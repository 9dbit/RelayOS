import type {Express,Request,Response} from 'express';
import {pool} from './db.js';

type User={id:string;name:string;role:string};
type Deps={requireUser:(req:Request,res:Response)=>Promise<User|null>};

export async function migrateContinuity(){
 await pool.query(`
  alter table conversations add column if not exists thread_id uuid;
  alter table conversations add column if not exists previous_conversation_id uuid references conversations(id) on delete set null;
  alter table conversations add column if not exists handover_reason text;
  alter table conversations add column if not exists handover_at timestamptz;
  update conversations set thread_id=id where thread_id is null;
  alter table conversations alter column thread_id set default gen_random_uuid();
  create index if not exists idx_conversations_thread on conversations(thread_id,created_at);
  create table if not exists conversation_handovers(
    id uuid primary key default gen_random_uuid(),
    thread_id uuid not null,
    customer_id uuid not null references customers(id) on delete cascade,
    from_conversation_id uuid references conversations(id) on delete set null,
    to_conversation_id uuid references conversations(id) on delete set null,
    from_whatsapp_id uuid references whatsapp_accounts(id),
    to_whatsapp_id uuid references whatsapp_accounts(id),
    reason text,
    actor_id uuid references operators(id),
    automatic boolean not null default false,
    created_at timestamptz not null default now()
  );
  create index if not exists idx_handovers_thread on conversation_handovers(thread_id,created_at);
  create or replace function relayos_continue_recent_handover() returns trigger as $$
  declare prev record;
  begin
    if new.thread_id is null then
      select id,thread_id,whatsapp_account_id into prev from conversations
      where customer_id=new.customer_id and status='closed' and whatsapp_account_id<>new.whatsapp_account_id
        and closed_at>now()-interval '10 minutes'
      order by closed_at desc limit 1;
      if found then
        new.thread_id:=coalesce(prev.thread_id,prev.id);
        new.previous_conversation_id:=prev.id;
        new.handover_at:=now();
      else
        new.thread_id:=gen_random_uuid();
      end if;
    end if;
    return new;
  end; $$ language plpgsql;
  drop trigger if exists trg_relayos_continue_recent_handover on conversations;
  create trigger trg_relayos_continue_recent_handover before insert on conversations for each row execute function relayos_continue_recent_handover();
 `);
}

export function registerContinuityRoutes(app:Express,deps:Deps){
 app.get('/api/v1/threads/:threadId',async(req,res)=>{const u=await deps.requireUser(req,res);if(!u)return;const c=await pool.query(`select cv.id,cv.thread_id,cv.previous_conversation_id,cv.status,cv.intent,cv.created_at,cv.closed_at,cv.handover_reason,cv.handover_at,wa.id whatsapp_account_id,wa.name channel_name,wa.phone channel_phone from conversations cv join whatsapp_accounts wa on wa.id=cv.whatsapp_account_id where cv.thread_id=$1 order by cv.created_at`,[req.params.threadId]);if(!c.rowCount)return res.status(404).json({error:'thread_not_found'});const ids=c.rows.map((x:any)=>x.id);const m=await pool.query(`select m.*,cv.thread_id,wa.name channel_name,wa.phone channel_phone from messages m join conversations cv on cv.id=m.conversation_id join whatsapp_accounts wa on wa.id=cv.whatsapp_account_id where m.conversation_id=any($1::uuid[]) order by m.created_at`,[ids]);const h=await pool.query('select * from conversation_handovers where thread_id=$1 order by created_at',[req.params.threadId]);res.json({thread_id:req.params.threadId,conversations:c.rows,messages:m.rows,handovers:h.rows})});

 app.post('/api/v1/conversations/:id/failover',async(req,res)=>{const u=await deps.requireUser(req,res);if(!u)return;if(!['admin','supervisor'].includes(u.role))return res.status(403).json({error:'forbidden'});const reason=String(req.body?.reason||'sender_unavailable').trim();const requested=String(req.body?.whatsapp_account_id||'').trim();const old=(await pool.query(`select cv.*,c.assigned_whatsapp_id from conversations cv join customers c on c.id=cv.customer_id where cv.id=$1`,[req.params.id])).rows[0];if(!old)return res.status(404).json({error:'conversation_not_found'});if(old.status!=='open')return res.status(409).json({error:'conversation_not_open'});
  let target:any=null;
  if(requested)target=(await pool.query(`select * from whatsapp_accounts where id=$1 and id<>$2 and status in('active','healthy') and health_score>=60`,[requested,old.whatsapp_account_id])).rows[0];
  else target=(await pool.query(`select wa.*,count(cv.id) filter(where cv.status='open')::int load from whatsapp_accounts wa left join conversations cv on cv.whatsapp_account_id=wa.id where wa.id<>$1 and wa.status in('active','healthy') and wa.health_score>=60 group by wa.id order by wa.health_score desc,count(cv.id) filter(where cv.status='open') asc limit 1`,[old.whatsapp_account_id])).rows[0];
  if(!target)return res.status(409).json({error:'no_eligible_failover_sender'});
  const client=await pool.connect();try{await client.query('begin');const threadId=old.thread_id||old.id;await client.query(`update conversations set status='closed',closed_at=now(),handover_reason=$2,handover_at=now(),thread_id=coalesce(thread_id,id) where id=$1`,[old.id,reason]);const n=(await client.query(`insert into conversations(customer_id,whatsapp_account_id,status,intent,ai_mode,assigned_operator,assigned_operator_id,priority,escalation_status,first_response_due_at,resolution_due_at,last_message_at,thread_id,previous_conversation_id,handover_reason,handover_at) values($1,$2,'open',$3,$4,$5,$6,$7,$8,$9,$10,now(),$11,$12,$13,now()) returning *`,[old.customer_id,target.id,old.intent,old.ai_mode,old.assigned_operator,old.assigned_operator_id,old.priority,old.escalation_status,old.first_response_due_at,old.resolution_due_at,threadId,old.id,reason])).rows[0];await client.query('update customers set assigned_whatsapp_id=$1,updated_at=now() where id=$2',[target.id,old.customer_id]);await client.query(`insert into conversation_handovers(thread_id,customer_id,from_conversation_id,to_conversation_id,from_whatsapp_id,to_whatsapp_id,reason,actor_id,automatic) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[threadId,old.customer_id,old.id,n.id,old.whatsapp_account_id,target.id,reason,u.id,Boolean(req.body?.automatic)]);await client.query(`insert into conversation_events(conversation_id,event_type,actor,payload) values($1,'channel_failover',$2,$3)`,[old.id,u.name,JSON.stringify({thread_id:threadId,to_conversation_id:n.id,to_whatsapp_id:target.id,to_channel:target.name,reason})]);await client.query('commit');res.json({ok:true,thread_id:threadId,previous_conversation_id:old.id,new_conversation_id:n.id,from_whatsapp_id:old.whatsapp_account_id,to_whatsapp_id:target.id,to_channel:target.name,continuity_preserved:true})}catch(e){await client.query('rollback');throw e}finally{client.release()}
 });

 app.get('/api/v1/continuity/health',async(req,res)=>{const u=await deps.requireUser(req,res);if(!u)return;const q=await pool.query(`select count(distinct thread_id)::int threads,count(*) filter(where previous_conversation_id is not null)::int continued_conversations,(select count(*)::int from conversation_handovers) handovers from conversations`);res.json(q.rows[0])});
}
