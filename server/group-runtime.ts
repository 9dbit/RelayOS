import type {Express,Request,Response} from 'express';
import {pool} from './db.js';
import {migrateOperatorRouting,registerOperatorRoutingRoutes} from './operator-routing.js';
import {registerMetaOnboardingRoutes} from './meta-onboarding.js';

type User={id:string;name:string;role:string;department?:string};
type Deps={requireUser:(req:Request,res:Response)=>Promise<User|null>};

function normalizePhone(input:any){let p=String(input||'').replace(/\D/g,'');if(p.startsWith('0'))p='62'+p.slice(1);if(p.startsWith('8'))p='62'+p;return /^62\d{8,13}$/.test(p)?p:null}
function digits(v:any){return String(v||'').replace(/\D/g,'')}
async function configuredWabaId(){if(process.env.RELAYOS_PRIMARY_WABA_ID)return process.env.RELAYOS_PRIMARY_WABA_ID;const q=await pool.query("select waba_id from whatsapp_accounts where waba_id is not null and waba_id<>'' order by created_at limit 1");return q.rows[0]?.waba_id||null}

export async function migrateGroupRuntime(){
  await pool.query(`
    alter table conversations add column if not exists group_id uuid references whatsapp_groups(id) on delete set null;
    create index if not exists idx_conversations_group on conversations(group_id,last_message_at desc);

    create or replace function relayos_resolve_conversation_group() returns trigger as $$
    declare resolved uuid;
    begin
      if new.group_id is not null or new.whatsapp_account_id is null then return new; end if;
      select min(gm.group_id::text)::uuid into resolved
      from whatsapp_group_members gm
      join whatsapp_groups g on g.id=gm.group_id and g.status='active'
      where gm.whatsapp_account_id=new.whatsapp_account_id
      having count(*)=1;
      if resolved is not null then new.group_id:=resolved; end if;
      return new;
    end;
    $$ language plpgsql;

    drop trigger if exists trg_relayos_conversation_group on conversations;
    create trigger trg_relayos_conversation_group before insert on conversations for each row execute function relayos_resolve_conversation_group();

    update conversations cv set group_id=x.group_id
    from (
      select gm.whatsapp_account_id,min(gm.group_id::text)::uuid group_id
      from whatsapp_group_members gm
      join whatsapp_groups g on g.id=gm.group_id and g.status='active'
      group by gm.whatsapp_account_id having count(*)=1
    ) x
    where cv.group_id is null and cv.whatsapp_account_id=x.whatsapp_account_id;
  `);
  await migrateOperatorRouting();
}

async function context(conversationId:string){const q=await pool.query(`select cv.id conversation_id,cv.group_id,g.group_code,g.name group_name,g.brand,g.department,g.region,g.routing_mode,g.min_health_score,wa.id whatsapp_account_id,wa.name whatsapp_name,wa.phone whatsapp_phone,cv.assigned_operator_id,cv.assigned_operator,(select count(*)::int from whatsapp_group_knowledge gk where gk.group_id=cv.group_id) knowledge_count,(select count(*)::int from whatsapp_group_operators go join operators o on o.id=go.operator_id where go.group_id=cv.group_id and o.active=true) operator_count from conversations cv left join whatsapp_groups g on g.id=cv.group_id left join whatsapp_accounts wa on wa.id=cv.whatsapp_account_id where cv.id=$1`,[conversationId]);return q.rows[0]||null}

export function registerGroupRuntimeRoutes(app:Express,deps:Deps){
  registerOperatorRoutingRoutes(app,deps);
  registerMetaOnboardingRoutes(app,deps);

  app.post('/api/v1/meta/discover-number',async(req,res)=>{
    const u=await deps.requireUser(req,res);if(!u)return;if(u.role!=='admin')return res.status(403).json({error:'admin_required'});
    const phone=normalizePhone(req.body?.phone);if(!phone)return res.status(400).json({error:'invalid_phone'});
    const accountId=String(req.body?.account_id||'').trim()||null;
    const token=process.env.META_ACCESS_TOKEN,version=process.env.META_GRAPH_VERSION,wabaId=await configuredWabaId();
    if(!token||!version)return res.status(503).json({error:'meta_transport_not_configured'});
    if(!wabaId)return res.status(400).json({error:'waba_id_not_configured'});
    const primaryPhone=normalizePhone(process.env.RELAYOS_PRIMARY_PHONE||''),primaryPhoneId=process.env.RELAYOS_PRIMARY_PHONE_NUMBER_ID||'';
    if(primaryPhone&&phone===primaryPhone&&primaryPhoneId){const q=accountId?await pool.query('update whatsapp_accounts set phone_number_id=$1,waba_id=$2,updated_at=now() where id=$3 returning *',[primaryPhoneId,wabaId,accountId]):await pool.query('update whatsapp_accounts set phone_number_id=$1,waba_id=$2,updated_at=now() where phone=$3 returning *',[primaryPhoneId,wabaId,phone]);return res.json({ok:true,source:'railway_primary_config',phone_number_id:primaryPhoneId,waba_id:wabaId,account:q.rows[0]||null})}
    try{const fields='id,display_phone_number,verified_name,quality_rating';const url=`https://graph.facebook.com/${encodeURIComponent(version)}/${encodeURIComponent(wabaId)}/phone_numbers?fields=${encodeURIComponent(fields)}&limit=100`;const r=await fetch(url,{headers:{authorization:`Bearer ${token}`}});const data:any=await r.json();if(!r.ok)return res.status(400).json({error:'meta_phone_discovery_failed',detail:data?.error?.message||`meta_http_${r.status}`});const list=Array.isArray(data?.data)?data.data:[];const match=list.find((x:any)=>digits(x.display_phone_number)===phone||digits(x.display_phone_number).endsWith(phone)||phone.endsWith(digits(x.display_phone_number)));if(!match)return res.status(404).json({error:'phone_not_found_in_configured_waba',waba_configured:true,available_count:list.length});const q=accountId?await pool.query('update whatsapp_accounts set phone_number_id=$1,waba_id=$2,updated_at=now() where id=$3 returning *',[String(match.id),wabaId,accountId]):await pool.query('update whatsapp_accounts set phone_number_id=$1,waba_id=$2,updated_at=now() where phone=$3 returning *',[String(match.id),wabaId,phone]);res.json({ok:true,source:'meta_waba_phone_numbers',phone_number_id:String(match.id),waba_id:wabaId,display_phone_number:match.display_phone_number,verified_name:match.verified_name,quality_rating:match.quality_rating,account:q.rows[0]||null})}catch(e:any){res.status(500).json({error:'meta_phone_discovery_error',detail:e.message})}
  });

  app.get('/api/v1/group-runtime/status',async(req,res)=>{const u=await deps.requireUser(req,res);if(!u)return;const[total,grouped,ambiguous]=await Promise.all([pool.query(`select count(*)::int n from conversations`),pool.query(`select count(*)::int n from conversations where group_id is not null`),pool.query(`select count(*)::int n from (select gm.whatsapp_account_id from whatsapp_group_members gm join whatsapp_groups g on g.id=gm.group_id and g.status='active' group by gm.whatsapp_account_id having count(*)>1)x`)]);const t=Number(total.rows[0]?.n||0),g=Number(grouped.rows[0]?.n||0);res.json({sticky_group_runtime:true,conversations_total:t,conversations_grouped:g,coverage_percent:t?Math.round(g/t*100):100,ambiguous_sender_mappings:Number(ambiguous.rows[0]?.n||0)})});

  app.get('/api/v1/conversations/:id/group-context',async(req,res)=>{const u=await deps.requireUser(req,res);if(!u)return;const c=await context(req.params.id);if(!c)return res.status(404).json({error:'conversation_not_found'});if(!c.group_id)return res.json({...c,resolved:false,reason:'no_unambiguous_active_group_for_sender'});const[knowledge,operators]=await Promise.all([pool.query(`select ki.id,ki.title,ki.category,ki.authority_level,kv.version_no,kv.summary from whatsapp_group_knowledge gk join knowledge_items ki on ki.id=gk.knowledge_item_id join knowledge_versions kv on kv.id=ki.current_version_id where gk.group_id=$1 and ki.status='published' and kv.status='published' and (kv.effective_from is null or kv.effective_from<=now()) and (kv.expires_at is null or kv.expires_at>now()) order by ki.authority_level asc,ki.title`,[c.group_id]),pool.query(`select o.id,o.name,o.role,o.department,o.presence,go.role group_role,(select count(*)::int from conversations cv where cv.assigned_operator_id=o.id and cv.status='open') open_load from whatsapp_group_operators go join operators o on o.id=go.operator_id where go.group_id=$1 and o.active=true order by case when go.role='lead' then 0 else 1 end,case o.presence when 'online' then 0 when 'away' then 1 else 2 end,open_load asc,o.name`,[c.group_id])]);res.json({...c,resolved:true,knowledge:knowledge.rows,operators:operators.rows})});

  app.post('/api/v1/group-runtime/reconcile',async(req,res)=>{const u=await deps.requireUser(req,res);if(!u)return;if(!['admin','supervisor'].includes(u.role))return res.status(403).json({error:'forbidden'});const r=await pool.query(`update conversations cv set group_id=x.group_id from (select gm.whatsapp_account_id,min(gm.group_id::text)::uuid group_id from whatsapp_group_members gm join whatsapp_groups g on g.id=gm.group_id and g.status='active' group by gm.whatsapp_account_id having count(*)=1)x where cv.group_id is null and cv.whatsapp_account_id=x.whatsapp_account_id returning cv.id`);res.json({ok:true,updated:r.rowCount||0})});
}
