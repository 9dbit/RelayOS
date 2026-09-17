import type {Express,Request,Response} from 'express';
import {pool} from './db.js';

type User={id:string;name:string;role:string};
type Deps={requireUser:(req:Request,res:Response)=>Promise<User|null>};

function displayPhone(v:string){const d=String(v||'').replace(/\D/g,'');return d?`+${d}`:''}
function firstName(v:string){const n=String(v||'').trim();return n?n.split(/\s+/)[0]:''}
function handoverMessage(customerName?:string,oldPhone?:string){const n=firstName(customerName||'');const greet=n?`Halo Kak ${n}`:'Halo Kak';return `${greet}, maaf ya, aku lanjutkan chat kita dari nomor WhatsApp ${displayPhone(oldPhone||'')||'yang sebelumnya'} karena nomor yang tadi lagi ada kendala. Kita lanjut ngobrol dari nomor ini aja ya, konteks percakapannya tetap aku lanjutkan kok.`}

export function registerGroupContinuityRoutes(app:Express,deps:Deps){
  app.get('/api/v1/conversations/:id/failover-candidates',async(req,res)=>{
    const u=await deps.requireUser(req,res);if(!u)return;
    const old=(await pool.query(`select cv.id,cv.group_id,cv.whatsapp_account_id,g.group_code,g.name group_name,g.routing_mode,g.min_health_score from conversations cv left join whatsapp_groups g on g.id=cv.group_id where cv.id=$1`,[req.params.id])).rows[0];
    if(!old)return res.status(404).json({error:'conversation_not_found'});
    if(!old.group_id)return res.status(409).json({error:'group_context_required',detail:'Conversation has no unambiguous group. Resolve sender membership first.'});
    const q=await pool.query(`select wa.id,wa.name,wa.phone,wa.status,wa.health_score,gm.priority,gm.is_primary,count(cv.id) filter(where cv.status='open')::int workload from whatsapp_group_members gm join whatsapp_accounts wa on wa.id=gm.whatsapp_account_id left join conversations cv on cv.whatsapp_account_id=wa.id where gm.group_id=$1 and wa.id<>$2 and wa.status in('active','healthy') and coalesce(wa.health_score,0)>=$3 group by wa.id,gm.priority,gm.is_primary order by gm.is_primary desc,case when $4='health_first' then wa.health_score end desc,case when $4='least_load' then count(cv.id) filter(where cv.status='open') end asc,gm.priority asc,wa.health_score desc`,[old.group_id,old.whatsapp_account_id,Number(old.min_health_score||60),old.routing_mode||'least_load']);
    res.json({group:{id:old.group_id,group_code:old.group_code,name:old.group_name,routing_mode:old.routing_mode},items:q.rows,cross_group_allowed:false});
  });

  app.post('/api/v1/conversations/:id/failover',async(req,res)=>{
    const u=await deps.requireUser(req,res);if(!u)return;if(!['admin','supervisor'].includes(u.role))return res.status(403).json({error:'forbidden'});
    const reason=String(req.body?.reason||'sender_unavailable').trim();const requested=String(req.body?.whatsapp_account_id||'').trim();
    const old=(await pool.query(`select cv.*,c.name customer_name,wa.phone old_phone,g.group_code,g.name group_name,g.routing_mode,g.min_health_score from conversations cv join customers c on c.id=cv.customer_id join whatsapp_accounts wa on wa.id=cv.whatsapp_account_id left join whatsapp_groups g on g.id=cv.group_id where cv.id=$1`,[req.params.id])).rows[0];
    if(!old)return res.status(404).json({error:'conversation_not_found'});if(old.status!=='open')return res.status(409).json({error:'conversation_not_open'});
    if(!old.group_id)return res.status(409).json({error:'group_context_required',detail:'Safe failover requires sticky conversation.group_id. Reconcile group mapping first.'});
    let target:any=null;
    if(requested){target=(await pool.query(`select wa.*,gm.priority,gm.is_primary from whatsapp_group_members gm join whatsapp_accounts wa on wa.id=gm.whatsapp_account_id where gm.group_id=$1 and wa.id=$2 and wa.id<>$3 and wa.status in('active','healthy') and coalesce(wa.health_score,0)>=$4`,[old.group_id,requested,old.whatsapp_account_id,Number(old.min_health_score||60)])).rows[0];if(!target){const cross=(await pool.query(`select 1 from whatsapp_accounts where id=$1`,[requested])).rowCount;if(cross)return res.status(409).json({error:'cross_group_failover_requires_approval',group_id:old.group_id,group_code:old.group_code});}}
    else target=(await pool.query(`select wa.*,gm.priority,gm.is_primary,count(cv.id) filter(where cv.status='open')::int load from whatsapp_group_members gm join whatsapp_accounts wa on wa.id=gm.whatsapp_account_id left join conversations cv on cv.whatsapp_account_id=wa.id where gm.group_id=$1 and wa.id<>$2 and wa.status in('active','healthy') and coalesce(wa.health_score,0)>=$3 group by wa.id,gm.priority,gm.is_primary order by gm.is_primary desc,case when $4='health_first' then wa.health_score end desc,case when $4='least_load' then count(cv.id) filter(where cv.status='open') end asc,gm.priority asc,wa.health_score desc limit 1`,[old.group_id,old.whatsapp_account_id,Number(old.min_health_score||60),old.routing_mode||'least_load'])).rows[0];
    if(!target)return res.status(409).json({error:'no_same_group_failover_sender',group_id:old.group_id,group_code:old.group_code});
    const intro=String(req.body?.intro_message||'').trim()||handoverMessage(old.customer_name,old.old_phone);const client=await pool.connect();
    try{await client.query('begin');const threadId=old.thread_id||old.id;await client.query(`update conversations set status='closed',closed_at=now(),handover_reason=$2,handover_at=now(),thread_id=coalesce(thread_id,id) where id=$1`,[old.id,reason]);
      const n=(await client.query(`insert into conversations(customer_id,whatsapp_account_id,group_id,status,intent,ai_mode,assigned_operator,assigned_operator_id,priority,escalation_status,first_response_due_at,resolution_due_at,last_message_at,thread_id,previous_conversation_id,handover_reason,handover_at) values($1,$2,$3,'open',$4,$5,$6,$7,$8,$9,$10,$11,now(),$12,$13,$14,now()) returning *`,[old.customer_id,target.id,old.group_id,old.intent,old.ai_mode,old.assigned_operator,old.assigned_operator_id,old.priority,old.escalation_status,old.first_response_due_at,old.resolution_due_at,threadId,old.id,reason])).rows[0];
      await client.query('update customers set assigned_whatsapp_id=$1,updated_at=now() where id=$2',[target.id,old.customer_id]);
      const msg=(await client.query(`insert into messages(conversation_id,direction,sender_type,original_text,rewritten_text,delivery_status,metadata) values($1,'outbound','system_handover',$2,$2,'draft',$3) returning id`,[n.id,intro,JSON.stringify({handover_intro:true,thread_id:threadId,group_id:old.group_id,from_whatsapp_id:old.whatsapp_account_id,to_whatsapp_id:target.id})])).rows[0];
      await client.query(`insert into conversation_handovers(thread_id,customer_id,from_conversation_id,to_conversation_id,from_whatsapp_id,to_whatsapp_id,reason,intro_message,intro_message_id,actor_id,automatic) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[threadId,old.customer_id,old.id,n.id,old.whatsapp_account_id,target.id,reason,intro,msg.id,u.id,Boolean(req.body?.automatic)]);
      await client.query(`insert into conversation_events(conversation_id,event_type,actor,payload) values($1,'channel_failover',$2,$3)`,[old.id,u.name,JSON.stringify({thread_id:threadId,group_id:old.group_id,group_code:old.group_code,to_conversation_id:n.id,to_whatsapp_id:target.id,to_channel:target.name,reason,same_group:true})]);
      await client.query('commit');res.json({ok:true,same_group:true,group_id:old.group_id,group_code:old.group_code,thread_id:threadId,previous_conversation_id:old.id,new_conversation_id:n.id,from_whatsapp_id:old.whatsapp_account_id,to_whatsapp_id:target.id,to_channel:target.name,handover_message:intro,handover_message_id:msg.id,handover_message_status:'draft'});
    }catch(e){await client.query('rollback');throw e}finally{client.release()}
  });
}
