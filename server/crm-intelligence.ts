import type {Express,Request,Response} from 'express';
import {pool} from './db.js';

type User={id:string;name:string;role:string;department?:string};
type Deps={requireUser:(req:Request,res:Response)=>Promise<User|null>};
const clamp=(n:number,min=0,max=100)=>Math.max(min,Math.min(max,n));

export async function migrateCrmIntelligence(){await pool.query(`
 alter table customers add column if not exists engagement_score int not null default 0;
 alter table customers add column if not exists value_score int not null default 0;
 alter table customers add column if not exists buying_intent_score int not null default 0;
 alter table customers add column if not exists churn_risk_score int not null default 0;
 alter table customers add column if not exists ai_summary text;
 alter table customers add column if not exists next_best_action text;
 alter table customers add column if not exists sentiment text;
 alter table customers add column if not exists sentiment_score int not null default 0;
 alter table customers add column if not exists intelligence_updated_at timestamptz;
 create table if not exists crm_intent_events(id uuid primary key default gen_random_uuid(),customer_id uuid references customers(id) on delete cascade,conversation_id uuid references conversations(id) on delete set null,intent text not null,confidence numeric(5,4),source text not null default 'conversation',created_at timestamptz not null default now());
 create table if not exists crm_sentiment_events(id uuid primary key default gen_random_uuid(),customer_id uuid references customers(id) on delete cascade,conversation_id uuid references conversations(id) on delete set null,sentiment text not null,score int not null default 0,evidence text,created_at timestamptz not null default now());
 create table if not exists crm_identity_links(id uuid primary key default gen_random_uuid(),customer_id uuid not null references customers(id) on delete cascade,identity_type text not null,identity_value text not null,verified boolean not null default false,confidence int not null default 50,source text,created_at timestamptz not null default now(),unique(identity_type,identity_value));
 create table if not exists crm_duplicate_candidates(id uuid primary key default gen_random_uuid(),customer_a uuid not null references customers(id) on delete cascade,customer_b uuid not null references customers(id) on delete cascade,score int not null,reason text,status text not null default 'pending',created_at timestamptz not null default now(),unique(customer_a,customer_b));
 create table if not exists crm_automation_rules(id uuid primary key default gen_random_uuid(),name text not null,description text,enabled boolean not null default true,trigger_type text not null,conditions jsonb not null default '{}',actions jsonb not null default '[]',approval_mode text not null default 'required',created_by uuid references operators(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now());
 create table if not exists crm_automation_runs(id uuid primary key default gen_random_uuid(),rule_id uuid references crm_automation_rules(id) on delete set null,customer_id uuid references customers(id) on delete cascade,deal_id uuid references crm_deals(id) on delete cascade,status text not null default 'proposed',proposed_actions jsonb not null default '[]',approved_by uuid references operators(id),approved_at timestamptz,executed_at timestamptz,error text,created_at timestamptz not null default now());
 create index if not exists idx_crm_intent_customer on crm_intent_events(customer_id,created_at desc);
 create index if not exists idx_crm_sentiment_customer on crm_sentiment_events(customer_id,created_at desc);
 create index if not exists idx_crm_duplicates_status on crm_duplicate_candidates(status,score desc);
 create index if not exists idx_crm_automation_runs_status on crm_automation_runs(status,created_at desc);
 insert into crm_automation_rules(name,description,trigger_type,conditions,actions,approval_mode,created_by)
 select 'Hot lead follow-up','Create a priority sales follow-up when a hot lead has no next action','customer_score',jsonb_build_object('lead_score_gte',75),jsonb_build_array(jsonb_build_object('type','create_task','priority','high','title','Follow up hot lead')),'required',(select id from operators where role='admin' order by created_at limit 1)
 where not exists(select 1 from crm_automation_rules where name='Hot lead follow-up');
`)}

async function computeIntelligence(customerId:string){
 const [c,convs,msgs,deals,acts,tasks,signals]=await Promise.all([
  pool.query('select * from customers where id=$1',[customerId]),
  pool.query("select count(*)::int n,max(last_message_at) last_at,array_remove(array_agg(distinct intent),null) intents from conversations where customer_id=$1",[customerId]),
  pool.query("select count(*)::int total,count(*) filter(where direction='inbound')::int inbound,max(m.created_at) last_msg from messages m join conversations cv on cv.id=m.conversation_id where cv.customer_id=$1",[customerId]),
  pool.query("select count(*) filter(where status='open')::int open,count(*) filter(where status='won')::int won,coalesce(sum(amount) filter(where status='won'),0)::numeric won_value,coalesce(sum(amount) filter(where status='open'),0)::numeric open_value,max(updated_at) deal_last from crm_deals where customer_id=$1",[customerId]),
  pool.query("select count(*)::int n,max(created_at) last_at from crm_activities where customer_id=$1 and created_at>now()-interval '90 days'",[customerId]),
  pool.query("select count(*) filter(where status in('open','in_progress'))::int open,count(*) filter(where status in('open','in_progress') and due_at<now())::int overdue from crm_tasks where customer_id=$1",[customerId]),
  pool.query("select coalesce(sum(score_delta),0)::int delta,count(*)::int n from crm_ai_signals where customer_id=$1 and status='active'",[customerId])
 ]);
 const x=c.rows[0];if(!x)return null;
 const daysSince=x.last_contact_at?Math.max(0,(Date.now()-new Date(x.last_contact_at).getTime())/86400000):999;
 const engagement=clamp(Math.min(45,msgs.rows[0].inbound*5)+Math.min(25,acts.rows[0].n*3)+(daysSince<=3?25:daysSince<=14?12:0));
 const value=clamp(Math.min(70,Math.log10(Number(deals.rows[0].won_value||0)+1)*10)+Math.min(30,Number(deals.rows[0].open)*10));
 const intents=(convs.rows[0].intents||[]).map((v:string)=>String(v));
 let buying=clamp((intents.includes('pricing')?25:0)+(intents.includes('product_availability')?20:0)+Number(deals.rows[0].open)*18+Math.min(20,msgs.rows[0].inbound*2)+Number(signals.rows[0].delta||0));
 let churn=clamp((daysSince>30?35:daysSince>14?18:0)+(tasks.rows[0].overdue*12)+(x.sentiment==='negative'?25:0)+(x.do_not_contact?40:0)-(engagement*.25));
 let sentimentScore=Number(x.sentiment_score||0), sentiment=x.sentiment||'neutral';
 if(sentimentScore<=-25)sentiment='negative'; else if(sentimentScore>=25)sentiment='positive'; else sentiment='neutral';
 const nba=x.do_not_contact?'Do not contact':churn>=60?'Supervisor retention review':buying>=70?'High-priority sales follow-up':tasks.rows[0].overdue>0?'Resolve overdue task':daysSince>7?'Re-engage customer':'Continue active conversation';
 const summary=`${x.name||x.phone} is a ${x.lead_temperature||'cold'} ${x.lifecycle_stage||'lead'} with engagement ${engagement}/100, buying intent ${buying}/100, value ${value}/100, and churn risk ${churn}/100. ${Number(deals.rows[0].open)||0} open deal(s), ${Number(deals.rows[0].won)||0} won deal(s).`;
 await pool.query('update customers set engagement_score=$2,value_score=$3,buying_intent_score=$4,churn_risk_score=$5,ai_summary=$6,next_best_action=$7,sentiment=$8,intelligence_updated_at=now(),updated_at=now() where id=$1',[customerId,engagement,value,buying,churn,summary,nba,sentiment]);
 return{engagement_score:engagement,value_score:value,buying_intent_score:buying,churn_risk_score:churn,summary,next_best_action:nba,sentiment};
}

async function proposeAutomation(customerId:string){
 const c=(await pool.query('select * from customers where id=$1',[customerId])).rows[0];if(!c)return[];
 const rules=(await pool.query('select * from crm_automation_rules where enabled=true order by created_at')).rows;const runs=[];
 for(const r of rules){const cond=r.conditions||{};let pass=true;if(cond.lead_score_gte!=null&&Number(c.lead_score)<Number(cond.lead_score_gte))pass=false;if(cond.buying_intent_gte!=null&&Number(c.buying_intent_score)<Number(cond.buying_intent_gte))pass=false;if(cond.churn_risk_gte!=null&&Number(c.churn_risk_score)<Number(cond.churn_risk_gte))pass=false;if(!pass)continue;const existing=await pool.query("select id from crm_automation_runs where rule_id=$1 and customer_id=$2 and status in('proposed','approved') and created_at>now()-interval '24 hours'",[r.id,customerId]);if(existing.rowCount)continue;const q=await pool.query(`insert into crm_automation_runs(rule_id,customer_id,status,proposed_actions) values($1,$2,$3,$4) returning *`,[r.id,customerId,r.approval_mode==='none'?'approved':'proposed',JSON.stringify(r.actions||[])]);runs.push(q.rows[0]);}
 return runs;
}

async function executeRun(id:string,userId:string){const run=(await pool.query('select * from crm_automation_runs where id=$1',[id])).rows[0];if(!run)return null;for(const a of run.proposed_actions||[]){if(a.type==='create_task')await pool.query(`insert into crm_tasks(title,customer_id,created_by,priority,status,due_at) values($1,$2,$3,$4,'open',now()+interval '2 hours')`,[a.title||'AI CRM follow-up',run.customer_id,userId,a.priority||'normal']);if(a.type==='add_signal')await pool.query(`insert into crm_ai_signals(customer_id,signal_type,severity,score_delta,title,explanation) values($1,$2,$3,$4,$5,$6)`,[run.customer_id,a.signal_type||'automation',a.severity||'info',Number(a.score_delta)||0,a.title||'Automation signal',a.explanation||null]);}
 await pool.query("update crm_automation_runs set status='executed',approved_by=coalesce(approved_by,$2),approved_at=coalesce(approved_at,now()),executed_at=now() where id=$1",[id,userId]);return{id,status:'executed'};}

export function registerCrmIntelligenceRoutes(app:Express,deps:Deps){const user=(req:Request,res:Response)=>deps.requireUser(req,res);
 app.post('/api/v1/crm/intelligence/:customerId/recompute',async(req,res)=>{const u=await user(req,res);if(!u)return;const data=await computeIntelligence(req.params.customerId);if(!data)return res.status(404).json({error:'contact_not_found'});const runs=await proposeAutomation(req.params.customerId);res.json({...data,automation_proposals:runs.length})});
 app.post('/api/v1/crm/intelligence/recompute-all',async(req,res)=>{const u=await user(req,res);if(!u)return;if(!['admin','supervisor'].includes(u.role))return res.status(403).json({error:'forbidden'});const ids=(await pool.query('select id from customers order by updated_at desc limit 1000')).rows;let n=0,proposals=0;for(const r of ids){if(await computeIntelligence(r.id)){n++;proposals+=(await proposeAutomation(r.id)).length}}res.json({ok:true,recomputed:n,automation_proposals:proposals})});
 app.get('/api/v1/crm/intelligence/overview',async(req,res)=>{const u=await user(req,res);if(!u)return;const q=await pool.query(`select count(*)::int contacts,count(*) filter(where buying_intent_score>=70)::int high_intent,count(*) filter(where churn_risk_score>=60)::int high_churn,count(*) filter(where engagement_score>=70)::int highly_engaged,round(avg(engagement_score))::int avg_engagement,round(avg(buying_intent_score))::int avg_buying_intent from customers`);const a=await pool.query("select count(*) filter(where status='proposed')::int proposed,count(*) filter(where status='executed')::int executed from crm_automation_runs");res.json({...q.rows[0],automation:a.rows[0]})});
 app.get('/api/v1/crm/intelligence/customers',async(req,res)=>{const u=await user(req,res);if(!u)return;const q=await pool.query(`select id,name,phone,email,lead_score,lead_temperature,engagement_score,value_score,buying_intent_score,churn_risk_score,sentiment,ai_summary,next_best_action,intelligence_updated_at from customers order by greatest(buying_intent_score,churn_risk_score,lead_score) desc,updated_at desc limit 300`);res.json({items:q.rows})});
 app.post('/api/v1/crm/intelligence/:customerId/sentiment',async(req,res)=>{const u=await user(req,res);if(!u)return;const score=clamp(Number(req.body?.score)||0,-100,100),sentiment=score<=-25?'negative':score>=25?'positive':'neutral';await pool.query('insert into crm_sentiment_events(customer_id,conversation_id,sentiment,score,evidence) values($1,$2,$3,$4,$5)',[req.params.customerId,req.body?.conversation_id||null,sentiment,score,String(req.body?.evidence||'').slice(0,1000)||null]);await pool.query('update customers set sentiment=$2,sentiment_score=$3 where id=$1',[req.params.customerId,sentiment,score]);res.json(await computeIntelligence(req.params.customerId))});
 app.get('/api/v1/crm/duplicates',async(req,res)=>{const u=await user(req,res);if(!u)return;const q=await pool.query(`select a.id a_id,a.name a_name,a.phone a_phone,a.email a_email,b.id b_id,b.name b_name,b.phone b_phone,b.email b_email,(case when lower(coalesce(a.email,''))=lower(coalesce(b.email,'')) and a.email is not null then 70 else 0 end + case when lower(coalesce(a.name,''))=lower(coalesce(b.name,'')) and a.name is not null then 25 else 0 end) score from customers a join customers b on a.id<b.id where (a.email is not null and lower(a.email)=lower(b.email)) or (a.name is not null and lower(a.name)=lower(b.name)) order by score desc limit 100`);res.json({items:q.rows})});
 app.get('/api/v1/crm/automation/runs',async(req,res)=>{const u=await user(req,res);if(!u)return;const q=await pool.query(`select r.*,ar.name rule_name,c.name customer_name,c.phone from crm_automation_runs r left join crm_automation_rules ar on ar.id=r.rule_id left join customers c on c.id=r.customer_id order by r.created_at desc limit 200`);res.json({items:q.rows})});
 app.post('/api/v1/crm/automation/runs/:id/approve',async(req,res)=>{const u=await user(req,res);if(!u)return;if(!['admin','supervisor'].includes(u.role))return res.status(403).json({error:'forbidden'});await pool.query("update crm_automation_runs set status='approved',approved_by=$2,approved_at=now() where id=$1 and status='proposed'",[req.params.id,u.id]);res.json(await executeRun(req.params.id,u.id))});
 app.post('/api/v1/crm/automation/rules',async(req,res)=>{const u=await user(req,res);if(!u)return;if(u.role!=='admin')return res.status(403).json({error:'admin_required'});const name=String(req.body?.name||'').trim();if(!name)return res.status(400).json({error:'name_required'});const q=await pool.query(`insert into crm_automation_rules(name,description,trigger_type,conditions,actions,approval_mode,created_by) values($1,$2,$3,$4,$5,$6,$7) returning *`,[name,req.body?.description||null,req.body?.trigger_type||'customer_score',JSON.stringify(req.body?.conditions||{}),JSON.stringify(req.body?.actions||[]),req.body?.approval_mode==='none'?'none':'required',u.id]);res.status(201).json(q.rows[0])});
}
