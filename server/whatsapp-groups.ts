import type {Express,Request,Response} from 'express';
import crypto from 'crypto';
import {pool} from './db.js';

type User={id:string;name:string;role:string;department?:string};
type Deps={requireUser:(req:Request,res:Response)=>Promise<User|null>};

function groupCode(){return `WG-${crypto.randomBytes(3).toString('hex').toUpperCase()}`}
async function requireRole(req:Request,res:Response,deps:Deps,roles:string[]){const u=await deps.requireUser(req,res);if(!u)return null;if(!roles.includes(u.role)){res.status(403).json({error:'forbidden',role:u.role});return null}return u}
async function findGroup(id:string){return (await pool.query('select * from whatsapp_groups where id::text=$1 or group_code=$1',[id])).rows[0]||null}

export async function migrateWhatsappGroups(){await pool.query(`
 create table if not exists whatsapp_groups(
   id uuid primary key default gen_random_uuid(), group_code text not null unique, name text not null, description text,
   department text, brand text, region text,
   routing_mode text not null default 'least_load' check(routing_mode in('least_load','round_robin','health_first','priority')),
   fallback_enabled boolean not null default true,
   min_health_score int not null default 60 check(min_health_score between 0 and 100),
   status text not null default 'active' check(status in('active','paused','archived')),
   created_by uuid references operators(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
 );
 create table if not exists whatsapp_group_members(
   group_id uuid not null references whatsapp_groups(id) on delete cascade,
   whatsapp_account_id uuid not null references whatsapp_accounts(id) on delete cascade,
   priority int not null default 100, is_primary boolean not null default false, created_at timestamptz not null default now(),
   primary key(group_id,whatsapp_account_id)
 );
 create table if not exists whatsapp_group_knowledge(
   group_id uuid not null references whatsapp_groups(id) on delete cascade,
   knowledge_item_id uuid not null references knowledge_items(id) on delete cascade,
   created_at timestamptz not null default now(), primary key(group_id,knowledge_item_id)
 );
 create table if not exists whatsapp_group_operators(
   group_id uuid not null references whatsapp_groups(id) on delete cascade,
   operator_id uuid not null references operators(id) on delete cascade,
   role text not null default 'member' check(role in('member','lead')),
   created_at timestamptz not null default now(), primary key(group_id,operator_id)
 );
 create index if not exists idx_wg_members_number on whatsapp_group_members(whatsapp_account_id,group_id);
 create index if not exists idx_wg_knowledge_group on whatsapp_group_knowledge(group_id,knowledge_item_id);
 create index if not exists idx_wg_status on whatsapp_groups(status,department,brand,region);
 with ranked as (
   select ctid,row_number() over(partition by group_id order by created_at,whatsapp_account_id) rn
   from whatsapp_group_members where is_primary=true
 ) update whatsapp_group_members set is_primary=false where ctid in(select ctid from ranked where rn>1);
 create unique index if not exists uq_wg_one_primary on whatsapp_group_members(group_id) where is_primary=true;
`)}

async function detail(id:string){
 const g=await findGroup(id);if(!g)return null;
 const [numbers,knowledge,operators]=await Promise.all([
  pool.query(`select wa.id,wa.name,wa.phone,wa.status,wa.health_score,wa.department,gm.priority,gm.is_primary,count(c.id) filter(where c.status='open')::int open_conversations from whatsapp_group_members gm join whatsapp_accounts wa on wa.id=gm.whatsapp_account_id left join conversations c on c.whatsapp_account_id=wa.id where gm.group_id=$1 group by wa.id,gm.priority,gm.is_primary order by gm.is_primary desc,gm.priority asc,wa.health_score desc`,[g.id]),
  pool.query(`select ki.id,ki.title,ki.category,ki.department,ki.authority_level,ki.status,kv.version_no,kv.summary from whatsapp_group_knowledge gk join knowledge_items ki on ki.id=gk.knowledge_item_id left join knowledge_versions kv on kv.id=ki.current_version_id where gk.group_id=$1 order by ki.authority_level asc,ki.title`,[g.id]),
  pool.query(`select o.id,o.name,o.email,o.role,o.department,o.presence,go.role group_role from whatsapp_group_operators go join operators o on o.id=go.operator_id where go.group_id=$1 and o.active=true order by go.role desc,o.name`,[g.id])
 ]);
 return{...g,numbers:numbers.rows,knowledge:knowledge.rows,operators:operators.rows}
}

export function registerWhatsappGroupRoutes(app:Express,deps:Deps){
 app.get('/api/v1/whatsapp-groups',async(req,res)=>{const u=await deps.requireUser(req,res);if(!u)return;const q=await pool.query(`select g.*,count(distinct gm.whatsapp_account_id)::int number_count,count(distinct gk.knowledge_item_id)::int knowledge_count,count(distinct go.operator_id)::int operator_count,coalesce(round(avg(wa.health_score)),0)::int avg_health,count(distinct c.id) filter(where c.status='open')::int open_conversations from whatsapp_groups g left join whatsapp_group_members gm on gm.group_id=g.id left join whatsapp_accounts wa on wa.id=gm.whatsapp_account_id left join whatsapp_group_knowledge gk on gk.group_id=g.id left join whatsapp_group_operators go on go.group_id=g.id left join conversations c on c.whatsapp_account_id=gm.whatsapp_account_id group by g.id order by g.status='active' desc,g.name`);res.json({items:q.rows})});

 app.post('/api/v1/whatsapp-groups',async(req,res)=>{const u=await requireRole(req,res,deps,['admin','supervisor']);if(!u)return;const name=String(req.body?.name||'').trim();if(!name)return res.status(400).json({error:'name_required'});let code=String(req.body?.group_code||'').trim().toUpperCase()||groupCode();for(let i=0;i<4;i++){try{const q=await pool.query(`insert into whatsapp_groups(group_code,name,description,department,brand,region,routing_mode,fallback_enabled,min_health_score,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,[code,name,String(req.body?.description||'').trim()||null,String(req.body?.department||'').trim()||null,String(req.body?.brand||'').trim()||null,String(req.body?.region||'').trim()||null,['least_load','round_robin','health_first','priority'].includes(req.body?.routing_mode)?req.body.routing_mode:'least_load',req.body?.fallback_enabled!==false,Math.max(0,Math.min(100,Number(req.body?.min_health_score)||60)),u.id]);return res.status(201).json(q.rows[0])}catch(e:any){if(e.code==='23505'&&!req.body?.group_code){code=groupCode();continue}throw e}}return res.status(409).json({error:'group_code_conflict'})});

 app.get('/api/v1/whatsapp-groups/:id',async(req,res)=>{const u=await deps.requireUser(req,res);if(!u)return;const d=await detail(req.params.id);d?res.json(d):res.status(404).json({error:'group_not_found'})});
 app.patch('/api/v1/whatsapp-groups/:id',async(req,res)=>{const u=await requireRole(req,res,deps,['admin','supervisor']);if(!u)return;const status=req.body?.status==null?null:String(req.body.status);if(status&&!['active','paused','archived'].includes(status))return res.status(400).json({error:'invalid_status'});const routing=req.body?.routing_mode==null?null:String(req.body.routing_mode);if(routing&&!['least_load','round_robin','health_first','priority'].includes(routing))return res.status(400).json({error:'invalid_routing_mode'});const q=await pool.query(`update whatsapp_groups set name=coalesce($2,name),description=coalesce($3,description),department=coalesce($4,department),brand=coalesce($5,brand),region=coalesce($6,region),routing_mode=coalesce($7,routing_mode),fallback_enabled=coalesce($8,fallback_enabled),min_health_score=coalesce($9,min_health_score),status=coalesce($10,status),updated_at=now() where id::text=$1 or group_code=$1 returning *`,[req.params.id,req.body?.name||null,req.body?.description??null,req.body?.department??null,req.body?.brand??null,req.body?.region??null,routing,typeof req.body?.fallback_enabled==='boolean'?req.body.fallback_enabled:null,req.body?.min_health_score==null?null:Math.max(0,Math.min(100,Number(req.body.min_health_score))),status]);q.rows[0]?res.json(q.rows[0]):res.status(404).json({error:'group_not_found'})});

 app.post('/api/v1/whatsapp-groups/:id/numbers',async(req,res)=>{const u=await requireRole(req,res,deps,['admin','supervisor']);if(!u)return;const g=await findGroup(req.params.id);if(!g)return res.status(404).json({error:'group_not_found'});const wa=String(req.body?.whatsapp_account_id||'').trim();if(!wa)return res.status(400).json({error:'whatsapp_account_id_required'});const exists=(await pool.query('select id from whatsapp_accounts where id::text=$1',[wa])).rows[0];if(!exists)return res.status(400).json({error:'whatsapp_account_not_found'});const client=await pool.connect();try{await client.query('begin');if(req.body?.is_primary)await client.query('update whatsapp_group_members set is_primary=false where group_id=$1',[g.id]);await client.query(`insert into whatsapp_group_members(group_id,whatsapp_account_id,priority,is_primary) values($1,$2,$3,$4) on conflict(group_id,whatsapp_account_id) do update set priority=excluded.priority,is_primary=excluded.is_primary`,[g.id,wa,Number(req.body?.priority)||100,Boolean(req.body?.is_primary)]);await client.query('commit')}catch(e){await client.query('rollback');throw e}finally{client.release()}res.json({ok:true,group:await detail(g.id)})});
 app.delete('/api/v1/whatsapp-groups/:id/numbers/:numberId',async(req,res)=>{const u=await requireRole(req,res,deps,['admin','supervisor']);if(!u)return;const g=await findGroup(req.params.id);if(!g)return res.status(404).json({error:'group_not_found'});await pool.query('delete from whatsapp_group_members where group_id=$1 and whatsapp_account_id=$2',[g.id,req.params.numberId]);res.json({ok:true,group:await detail(g.id)})});

 app.post('/api/v1/whatsapp-groups/:id/knowledge',async(req,res)=>{const u=await requireRole(req,res,deps,['admin','supervisor']);if(!u)return;const kid=String(req.body?.knowledge_item_id||'').trim();const g=await findGroup(req.params.id);if(!g||!kid)return res.status(400).json({error:'group_and_knowledge_required'});const exists=(await pool.query("select id from knowledge_items where id::text=$1 and status='published'",[kid])).rows[0];if(!exists)return res.status(400).json({error:'published_knowledge_not_found'});await pool.query(`insert into whatsapp_group_knowledge(group_id,knowledge_item_id) values($1,$2) on conflict do nothing`,[g.id,kid]);res.json({ok:true,group:await detail(g.id)})});
 app.delete('/api/v1/whatsapp-groups/:id/knowledge/:knowledgeId',async(req,res)=>{const u=await requireRole(req,res,deps,['admin','supervisor']);if(!u)return;const g=await findGroup(req.params.id);if(!g)return res.status(404).json({error:'group_not_found'});await pool.query('delete from whatsapp_group_knowledge where group_id=$1 and knowledge_item_id=$2',[g.id,req.params.knowledgeId]);res.json({ok:true,group:await detail(g.id)})});

 app.post('/api/v1/whatsapp-groups/:id/operators',async(req,res)=>{const u=await requireRole(req,res,deps,['admin','supervisor']);if(!u)return;const oid=String(req.body?.operator_id||'').trim();const g=await findGroup(req.params.id);if(!g||!oid)return res.status(400).json({error:'group_and_operator_required'});const exists=(await pool.query('select id from operators where id::text=$1 and active=true',[oid])).rows[0];if(!exists)return res.status(400).json({error:'operator_not_found'});await pool.query(`insert into whatsapp_group_operators(group_id,operator_id,role) values($1,$2,$3) on conflict(group_id,operator_id) do update set role=excluded.role`,[g.id,oid,req.body?.role==='lead'?'lead':'member']);res.json({ok:true,group:await detail(g.id)})});
 app.delete('/api/v1/whatsapp-groups/:id/operators/:operatorId',async(req,res)=>{const u=await requireRole(req,res,deps,['admin','supervisor']);if(!u)return;const g=await findGroup(req.params.id);if(!g)return res.status(404).json({error:'group_not_found'});await pool.query('delete from whatsapp_group_operators where group_id=$1 and operator_id=$2',[g.id,req.params.operatorId]);res.json({ok:true,group:await detail(g.id)})});

 app.get('/api/v1/whatsapp-groups/:id/sender-pool',async(req,res)=>{const u=await deps.requireUser(req,res);if(!u)return;const g=await findGroup(req.params.id);if(!g)return res.status(404).json({error:'group_not_found'});const q=await pool.query(`select wa.id,wa.name,wa.phone,wa.status,wa.health_score,gm.priority,gm.is_primary,count(c.id) filter(where c.status='open')::int workload from whatsapp_group_members gm join whatsapp_accounts wa on wa.id=gm.whatsapp_account_id left join conversations c on c.whatsapp_account_id=wa.id where gm.group_id=$1 and wa.status in('active','healthy','verified','verifying') and wa.health_score>=$2 group by wa.id,gm.priority,gm.is_primary order by gm.is_primary desc,case when $3='health_first' then wa.health_score end desc,case when $3='least_load' then count(c.id) filter(where c.status='open') end asc,gm.priority asc`,[g.id,g.min_health_score,g.routing_mode]);res.json({group:{id:g.id,group_code:g.group_code,name:g.name,routing_mode:g.routing_mode,fallback_enabled:g.fallback_enabled},eligible:q.rows})});
 app.get('/api/v1/whatsapp-groups/:id/effective-knowledge',async(req,res)=>{const u=await deps.requireUser(req,res);if(!u)return;const g=await findGroup(req.params.id);if(!g)return res.status(404).json({error:'group_not_found'});const q=await pool.query(`select ki.id,ki.title,ki.category,ki.authority_level,kv.version_no,kv.summary,kv.content,kv.source_ref from whatsapp_group_knowledge gk join knowledge_items ki on ki.id=gk.knowledge_item_id join knowledge_versions kv on kv.id=ki.current_version_id where gk.group_id=$1 and ki.status='published' and kv.status='published' and (kv.effective_from is null or kv.effective_from<=now()) and (kv.expires_at is null or kv.expires_at>now()) order by ki.authority_level asc,ki.title`,[g.id]);res.json({items:q.rows})});

 app.get('/api/v1/system/readiness',async(req,res)=>{const u=await deps.requireUser(req,res);if(!u)return;const scalar=async(sql:string)=>Number((await pool.query(sql)).rows[0]?.n||0);try{await pool.query('select 1')}catch(e:any){return res.status(503).json({error:'database_unavailable',detail:e.message})}const [numbersHealthy,groupsActive,groupsMissingPrimary,duplicatePrimaries,publishedKnowledge,groupKnowledge,activeOperators,audiences,approvedTemplates,allowlistedNumbers,completedRealTests]=await Promise.all([
   scalar(`select count(*)::int n from whatsapp_accounts where status in('active','healthy','verified','verifying') and coalesce(health_score,0)>=60`),
   scalar(`select count(*)::int n from whatsapp_groups where status='active'`),
   scalar(`select count(*)::int n from whatsapp_groups g where g.status='active' and not exists(select 1 from whatsapp_group_members gm where gm.group_id=g.id and gm.is_primary=true)`),
   scalar(`select count(*)::int n from (select group_id from whatsapp_group_members where is_primary=true group by group_id having count(*)>1)x`),
   scalar(`select count(*)::int n from knowledge_items where status='published'`),
   scalar(`select count(*)::int n from whatsapp_group_knowledge gk join knowledge_items ki on ki.id=gk.knowledge_item_id where ki.status='published'`),
   scalar(`select count(*)::int n from operators where active=true`),
   scalar(`select count(*)::int n from audience_databases where status='active'`),
   scalar(`select count(*)::int n from chat_templates where approved=true and status='approved'`),
   scalar(`select count(*)::int n from real_agent_allowlist where enabled=true`),
   scalar(`select count(*)::int n from real_agent_threads where status='completed'`)
 ]);const metaTransport=Boolean(process.env.META_ACCESS_TOKEN&&process.env.META_GRAPH_VERSION),webhookConfigured=Boolean(process.env.META_VERIFY_TOKEN),openaiConfigured=Boolean(process.env.OPENAI_API_KEY),primaryReady=groupsActive>0&&groupsMissingPrimary===0&&duplicatePrimaries===0,campaignReady=audiences>0&&approvedTemplates>0&&primaryReady;const items=[
   {key:'database',label:'Database',status:'ready',detail:'Postgres reachable',href:'/setup-wizard.html',required:true},
   {key:'meta',label:'Meta transport',status:metaTransport?'ready':'action',detail:metaTransport?'Access token and Graph version configured':'Add META_ACCESS_TOKEN and META_GRAPH_VERSION',href:'/onboarding.html',required:true},
   {key:'webhook',label:'Webhook configuration',status:webhookConfigured?'ready':'action',detail:webhookConfigured?'Verify token configured':'Add META_VERIFY_TOKEN and verify webhook in Meta',href:'/onboarding.html',required:true},
   {key:'numbers',label:'WhatsApp numbers',status:numbersHealthy>0?'ready':'action',detail:numbersHealthy>0?`${numbersHealthy} eligible number(s)`:'No eligible healthy sender',href:'/?view=whatsapp',required:true},
   {key:'groups',label:'WhatsApp groups',status:groupsActive>0?'ready':'action',detail:groupsActive>0?`${groupsActive} active group(s)`:'Create at least one active group',href:'/whatsapp-groups.html',required:true},
   {key:'primary',label:'Primary sender rules',status:primaryReady?'ready':'action',detail:primaryReady?'Every active group has exactly one primary sender':duplicatePrimaries>0?`${duplicatePrimaries} group(s) have duplicate primary senders`:`${groupsMissingPrimary} active group(s) missing primary sender`,href:'/whatsapp-groups.html',required:true},
   {key:'knowledge',label:'Published knowledge',status:publishedKnowledge>0?'ready':'action',detail:publishedKnowledge>0?`${publishedKnowledge} published item(s)`:'Publish at least one knowledge item',href:'/knowledge.html',required:true},
   {key:'group_knowledge',label:'Group knowledge',status:groupKnowledge>0?'ready':'action',detail:groupKnowledge>0?`${groupKnowledge} group attachment(s)`:'Attach published knowledge to a group',href:'/whatsapp-groups.html',required:true},
   {key:'operators',label:'Operators',status:activeOperators>0?'ready':'action',detail:activeOperators>0?`${activeOperators} active operator(s)`:'Add an active operator',href:'/team.html',required:true},
   {key:'openai',label:'AI runtime',status:openaiConfigured?'ready':'action',detail:openaiConfigured?'OpenAI API key configured. Billing/credits require live request validation.':'Add OPENAI_API_KEY',href:'/knowledge-runtime.html',required:true},
   {key:'campaign',label:'Campaign prerequisites',status:campaignReady?'ready':'action',detail:campaignReady?`${audiences} audience DB(s), ${approvedTemplates} approved template(s)`:`Need audience DB, approved template and primary sender`,href:'/campaigns.html',required:false},
   {key:'real_agent',label:'Real Agent E2E',status:allowlistedNumbers>=2&&completedRealTests>0?'ready':'optional',detail:allowlistedNumbers>=2&&completedRealTests>0?`${completedRealTests} completed E2E test(s)`:`${allowlistedNumbers} allowlisted number(s); controlled E2E test not completed`,href:'/real-agent.html',required:false}
 ];const required=items.filter(x=>x.required),score=Math.round(required.filter(x=>x.status==='ready').length/Math.max(1,required.length)*100);res.json({score,status:score===100?'ready':score>=70?'attention':'setup_required',items,counts:{numbersHealthy,groupsActive,groupsMissingPrimary,duplicatePrimaries,publishedKnowledge,groupKnowledge,activeOperators,audiences,approvedTemplates,allowlistedNumbers,completedRealTests},generated_at:new Date().toISOString()})});
}
