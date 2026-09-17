import type{Express,Request,Response}from'express';
import{pool}from'./db.js';

type User={id:string;name:string;role:string};
type Deps={requireUser:(req:Request,res:Response)=>Promise<User|null>};

export function registerInboxWallRuntimeRoutes(app:Express,deps:Deps){
 app.get('/api/v1/inbox-wall',async(req,res)=>{
  const u=await deps.requireUser(req,res);if(!u)return;
  const groups=(await pool.query(`select g.id,g.group_code,g.name,g.brand,g.department,g.region,g.routing_mode,g.min_health_score from whatsapp_groups g where g.status<>'archived' order by g.name`)).rows;
  for(const g of groups){
   g.numbers=(await pool.query(`select wa.id,wa.name,wa.phone,wa.status,wa.health_score,gm.is_primary,gm.priority,coalesce(al.enabled,false) real_test_enabled from whatsapp_group_members gm join whatsapp_accounts wa on wa.id=gm.whatsapp_account_id left join real_agent_allowlist al on al.whatsapp_account_id=wa.id where gm.group_id=$1 order by gm.is_primary desc,gm.priority,wa.name`,[g.id])).rows;
   for(const n of g.numbers){
    n.conversations=(await pool.query(`select cv.id,cv.group_id,g2.group_code,g2.name group_name,c.name customer_name,c.phone customer_phone,cv.status,cv.unread_count,cv.intent,cv.priority,cv.last_message_at,(select coalesce(m.rewritten_text,m.original_text) from messages m where m.conversation_id=cv.id order by m.created_at desc limit 1) last_message from conversations cv join customers c on c.id=cv.customer_id left join whatsapp_groups g2 on g2.id=cv.group_id where cv.whatsapp_account_id=$1 and cv.group_id=$2 order by cv.last_message_at desc limit 8`,[n.id,g.id])).rows;
    n.real_messages=(await pool.query(`select ram.content,ram.direction,ram.delivery_status,ram.created_at,rt.thread_code,case when ram.sender_account_id=$1 then 'sent' else 'received' end side,wa.name peer_name from real_agent_messages ram join real_agent_threads rt on rt.id=ram.thread_id left join whatsapp_accounts wa on wa.id=case when ram.sender_account_id=$1 then ram.recipient_account_id else ram.sender_account_id end where (ram.sender_account_id=$1 or ram.recipient_account_id=$1) and (rt.source_group_id=$2 or rt.target_group_id=$2) order by ram.created_at desc limit 6`,[n.id,g.id])).rows.reverse();
   }
  }
  const ungrouped=(await pool.query(`select cv.id,cv.whatsapp_account_id,wa.name channel_name,wa.phone channel_phone,c.name customer_name,c.phone customer_phone,cv.status,cv.unread_count,cv.last_message_at,(select coalesce(m.rewritten_text,m.original_text) from messages m where m.conversation_id=cv.id order by m.created_at desc limit 1) last_message from conversations cv join customers c on c.id=cv.customer_id join whatsapp_accounts wa on wa.id=cv.whatsapp_account_id where cv.group_id is null order by cv.last_message_at desc limit 50`)).rows;
  const ambiguous=(await pool.query(`select gm.whatsapp_account_id,wa.name,wa.phone,count(*)::int active_group_count,array_agg(g.group_code order by g.group_code) group_codes from whatsapp_group_members gm join whatsapp_groups g on g.id=gm.group_id and g.status='active' join whatsapp_accounts wa on wa.id=gm.whatsapp_account_id group by gm.whatsapp_account_id,wa.name,wa.phone having count(*)>1 order by wa.name`)).rows;
  res.json({groups,ungrouped,ambiguous_sender_mappings:ambiguous,generated_at:new Date().toISOString(),source_of_truth:'conversations.group_id'});
 });
}
