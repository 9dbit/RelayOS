import type {Express,Request,Response} from 'express';
import {pool} from './db.js';

type User={id:string;name:string;role:string};
type Deps={requireUser:(req:Request,res:Response)=>Promise<User|null>};

function displayPhone(v:string){const d=String(v||'').replace(/\D/g,'');if(!d)return'';return d.startsWith('62')?`+${d}`:`+${d}`}
function firstName(v:string){const n=String(v||'').trim();return n?n.split(/\s+/)[0]:''}
function naturalHandoverMessage(input:{customerName?:string;oldPhone?:string;variant?:number}){
 const name=firstName(input.customerName||'');const greet=name?`Halo Kak ${name}`:'Halo Kak';const old=displayPhone(input.oldPhone||'');
 const variants=[
  `${greet}, maaf ya, aku lanjutkan chat kita dari nomor WhatsApp ${old||'yang sebelumnya'} karena nomor yang tadi lagi ada kendala. Kita lanjut ngobrol dari nomor ini aja ya, konteks percakapannya tetap aku lanjutkan kok.`,
  `${greet}, izin lanjut chat kita di sini ya. Nomor WhatsApp ${old||'sebelumnya'} lagi ada kendala, jadi aku sambung dari nomor ini dulu. Tenang, pembahasan kita sebelumnya tetap kebawa dan bisa langsung kita lanjutkan.`,
  `${greet}, maaf pindah nomor sebentar ya. WhatsApp ${old||'yang tadi'} lagi bermasalah, jadi aku lanjut bantu dari nomor ini. Kita bisa lanjut dari pembahasan terakhir, nggak perlu mulai dari awal lagi.`
 ];
 return variants[Math.abs(Number(input.variant||0))%variants.length];
}

async function seedHandoverKnowledge(){
 const exists=(await pool.query("select id from knowledge_items where title='WhatsApp Channel Handover Message' order by created_at limit 1")).rows[0];if(exists)return;
 const content=`Purpose: opening message when a customer conversation is continued from a different official WhatsApp sender number because the previous sender has a problem or is unavailable.\n\nTone: natural Indonesian, warm, concise, not bureaucratic. Prefer words such as \"maaf ya\", \"aku lanjutkan chat kita\", \"kita lanjut di nomor ini aja ya\". Do not sound like a system alert.\n\nRequired facts:\n- Address the customer naturally. Use \"Kak [first name]\" when a name is known, otherwise \"Kak\".\n- Mention the previous official WhatsApp number when available.\n- Explain only that the previous number is having a problem/kendala unless a more specific verified reason exists. Never invent suspension, blocking, outage, or technical causes.\n- Reassure the customer that the conversation context is retained and they do not need to repeat everything.\n- Never claim the Meta message ID is reused. RelayOS preserves internal thread continuity while the new sender receives new provider message IDs.\n\nPreferred example:\n\"Halo Kak [Nama], maaf ya, aku lanjutkan chat kita dari nomor WhatsApp [nomor lama] karena nomor yang tadi lagi ada kendala. Kita lanjut ngobrol dari nomor ini aja ya, konteks percakapannya tetap aku lanjutkan kok.\"\n\nAlternative natural variants:\n1. \"Halo Kak [Nama], izin lanjut chat kita di sini ya. Nomor WhatsApp [nomor lama] lagi ada kendala, jadi aku sambung dari nomor ini dulu. Tenang, pembahasan kita sebelumnya tetap kebawa dan bisa langsung kita lanjutkan.\"\n2. \"Halo Kak [Nama], maaf pindah nomor sebentar ya. WhatsApp [nomor lama] lagi bermasalah, jadi aku lanjut bantu dari nomor ini. Kita bisa lanjut dari pembahasan terakhir, nggak perlu mulai dari awal lagi.\"`;
 const c=await pool.connect();try{await c.query('begin');const item=(await c.query(`insert into knowledge_items(title,category,department,source_type,authority_level,data_class,status) values('WhatsApp Channel Handover Message','Channel Handover','Customer Service','system',2,'static','published') returning id`)).rows[0];const ver=(await c.query(`insert into knowledge_versions(item_id,version_no,content,summary,tags,source_ref,status) values($1,1,$2,'Natural customer-facing message for continuing a conversation from a replacement WhatsApp sender.',ARRAY['whatsapp','handover','failover','continuity','tone'],'system:whatsapp-handover','published') returning id`,[item.id,content])).rows[0];await c.query('update knowledge_items set current_version_id=$2 where id=$1',[item.id,ver.id]);await c.query(`insert into knowledge_agent_scopes(agent_id,item_id) select id,$1 from ai_agents where status='active' on conflict do nothing`,[item.id]);await c.query('commit')}catch(e){await c.query('rollback');throw e}finally{c.release()}
}

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
    intro_message text,
    intro_message_id uuid references messages(id) on delete set null,
    actor_id uuid references operators(id),
    automatic boolean not null default false,
    created_at timestamptz not null default now()
  );
  alter table conversation_handovers add column if not exists intro_message text;
  alter table conversation_handovers add column if not exists intro_message_id uuid references messages(id) on delete set null;
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
 await seedHandoverKnowledge();
}

export function registerContinuityRoutes(app:Express,deps:Deps){
 app.get('/api/v1/threads/:threadId',async(req,res)=>{const u=await deps.requireUser(req,res);if(!u)return;const c=await pool.query(`select cv.id,cv.thread_id,cv.previous_conversation_id,cv.status,cv.intent,cv.created_at,cv.closed_at,cv.handover_reason,cv.handover_at,wa.id whatsapp_account_id,wa.name channel_name,wa.phone channel_phone from conversations cv join whatsapp_accounts wa on wa.id=cv.whatsapp_account_id where cv.thread_id=$1 order by cv.created_at`,[req.params.threadId]);if(!c.rowCount)return res.status(404).json({error:'thread_not_found'});const ids=c.rows.map((x:any)=>x.id);const m=await pool.query(`select m.*,cv.thread_id,wa.name channel_name,wa.phone channel_phone from messages m join conversations cv on cv.id=m.conversation_id join whatsapp_accounts wa on wa.id=cv.whatsapp_account_id where m.conversation_id=any($1::uuid[]) order by m.created_at`,[ids]);const h=await pool.query('select * from conversation_handovers where thread_id=$1 order by created_at',[req.params.threadId]);res.json({thread_id:req.params.threadId,conversations:c.rows,messages:m.rows,handovers:h.rows})});

 app.post('/api/v1/conversations/:id/handover-preview',async(req,res)=>{const u=await deps.requireUser(req,res);if(!u)return;const q=(await pool.query(`select cv.id,c.name customer_name,wa.phone old_phone from conversations cv join customers c on c.id=cv.customer_id join whatsapp_accounts wa on wa.id=cv.whatsapp_account_id where cv.id=$1`,[req.params.id])).rows[0];if(!q)return res.status(404).json({error:'conversation_not_found'});res.json({message:naturalHandoverMessage({customerName:q.customer_name,oldPhone:q.old_phone,variant:Number(req.body?.variant)||0}),knowledge_source:'WhatsApp Channel Handover Message',verified_reason_policy:'generic_problem_only'})});

 app.post('/api/v1/conversations/:id/failover',async(req,res)=>{const u=await deps.requireUser(req,res);if(!u)return;if(!['admin','supervisor'].includes(u.role))return res.status(403).json({error:'forbidden'});const reason=String(req.body?.reason||'sender_unavailable').trim();const requested=String(req.body?.whatsapp_account_id||'').trim();const old=(await pool.query(`select cv.*,c.assigned_whatsapp_id,c.name customer_name,wa.phone old_phone from conversations cv join customers c on c.id=cv.customer_id join whatsapp_accounts wa on wa.id=cv.whatsapp_account_id where cv.id=$1`,[req.params.id])).rows[0];if(!old)return res.status(404).json({error:'conversation_not_found'});if(old.status!=='open')return res.status(409).json({error:'conversation_not_open'});
  let target:any=null;
  if(requested)target=(await pool.query(`select * from whatsapp_accounts where id=$1 and id<>$2 and status in('active','healthy') and health_score>=60`,[requested,old.whatsapp_account_id])).rows[0];
  else target=(await pool.query(`select wa.*,count(cv.id) filter(where cv.status='open')::int load from whatsapp_accounts wa left join conversations cv on cv.whatsapp_account_id=wa.id where wa.id<>$1 and wa.status in('active','healthy') and wa.health_score>=60 group by wa.id order by wa.health_score desc,count(cv.id) filter(where cv.status='open') asc limit 1`,[old.whatsapp_account_id])).rows[0];
  if(!target)return res.status(409).json({error:'no_eligible_failover_sender'});
  const intro=String(req.body?.intro_message||'').trim()||naturalHandoverMessage({customerName:old.customer_name,oldPhone:old.old_phone,variant:Number(req.body?.variant)||0});
  const client=await pool.connect();try{await client.query('begin');const threadId=old.thread_id||old.id;await client.query(`update conversations set status='closed',closed_at=now(),handover_reason=$2,handover_at=now(),thread_id=coalesce(thread_id,id) where id=$1`,[old.id,reason]);const n=(await client.query(`insert into conversations(customer_id,whatsapp_account_id,status,intent,ai_mode,assigned_operator,assigned_operator_id,priority,escalation_status,first_response_due_at,resolution_due_at,last_message_at,thread_id,previous_conversation_id,handover_reason,handover_at) values($1,$2,'open',$3,$4,$5,$6,$7,$8,$9,$10,now(),$11,$12,$13,now()) returning *`,[old.customer_id,target.id,old.intent,old.ai_mode,old.assigned_operator,old.assigned_operator_id,old.priority,old.escalation_status,old.first_response_due_at,old.resolution_due_at,threadId,old.id,reason])).rows[0];await client.query('update customers set assigned_whatsapp_id=$1,updated_at=now() where id=$2',[target.id,old.customer_id]);const msg=(await client.query(`insert into messages(conversation_id,direction,sender_type,original_text,rewritten_text,delivery_status,metadata) values($1,'outbound','system_handover',$2,$2,'draft',$3) returning id`,[n.id,intro,JSON.stringify({handover_intro:true,thread_id:threadId,from_whatsapp_id:old.whatsapp_account_id,to_whatsapp_id:target.id,knowledge_source:'WhatsApp Channel Handover Message'})])).rows[0];await client.query(`insert into conversation_handovers(thread_id,customer_id,from_conversation_id,to_conversation_id,from_whatsapp_id,to_whatsapp_id,reason,intro_message,intro_message_id,actor_id,automatic) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[threadId,old.customer_id,old.id,n.id,old.whatsapp_account_id,target.id,reason,intro,msg.id,u.id,Boolean(req.body?.automatic)]);await client.query(`insert into conversation_events(conversation_id,event_type,actor,payload) values($1,'channel_failover',$2,$3)`,[old.id,u.name,JSON.stringify({thread_id:threadId,to_conversation_id:n.id,to_whatsapp_id:target.id,to_channel:target.name,reason,intro_message:intro,intro_message_id:msg.id})]);await client.query(`insert into conversation_events(conversation_id,event_type,actor,payload) values($1,'handover_intro_drafted',$2,$3)`,[n.id,u.name,JSON.stringify({thread_id:threadId,from_phone:old.old_phone,message_id:msg.id})]);await client.query('commit');res.json({ok:true,thread_id:threadId,previous_conversation_id:old.id,new_conversation_id:n.id,from_whatsapp_id:old.whatsapp_account_id,to_whatsapp_id:target.id,to_channel:target.name,continuity_preserved:true,handover_message:intro,handover_message_id:msg.id,handover_message_status:'draft',knowledge_source:'WhatsApp Channel Handover Message'})}catch(e){await client.query('rollback');throw e}finally{client.release()}
 });

 app.get('/api/v1/continuity/health',async(req,res)=>{const u=await deps.requireUser(req,res);if(!u)return;const q=await pool.query(`select count(distinct thread_id)::int threads,count(*) filter(where previous_conversation_id is not null)::int continued_conversations,(select count(*)::int from conversation_handovers) handovers from conversations`);res.json(q.rows[0])});
}
