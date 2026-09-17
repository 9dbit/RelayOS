import type {Express,Request,Response} from 'express';
import {pool} from './db.js';

type User={id:string;name:string;role:string;department?:string};
type Deps={requireUser:(req:Request,res:Response)=>Promise<User|null>};

export async function migrateGroupRuntime(){
  await pool.query(`
    alter table conversations add column if not exists group_id uuid references whatsapp_groups(id) on delete set null;
    create index if not exists idx_conversations_group on conversations(group_id,last_message_at desc);

    create or replace function relayos_resolve_conversation_group() returns trigger as $$
    declare resolved uuid;
    begin
      if new.group_id is not null or new.whatsapp_account_id is null then return new; end if;
      select min(gm.group_id::text)::uuid
        into resolved
      from whatsapp_group_members gm
      join whatsapp_groups g on g.id=gm.group_id and g.status='active'
      where gm.whatsapp_account_id=new.whatsapp_account_id
      having count(*)=1;
      if resolved is not null then new.group_id:=resolved; end if;
      return new;
    end;
    $$ language plpgsql;

    drop trigger if exists trg_relayos_conversation_group on conversations;
    create trigger trg_relayos_conversation_group
      before insert on conversations
      for each row execute function relayos_resolve_conversation_group();

    update conversations cv
    set group_id=x.group_id
    from (
      select gm.whatsapp_account_id,min(gm.group_id::text)::uuid group_id
      from whatsapp_group_members gm
      join whatsapp_groups g on g.id=gm.group_id and g.status='active'
      group by gm.whatsapp_account_id
      having count(*)=1
    ) x
    where cv.group_id is null and cv.whatsapp_account_id=x.whatsapp_account_id;
  `);
}

async function context(conversationId:string){
  const q=await pool.query(`
    select cv.id conversation_id,cv.group_id,g.group_code,g.name group_name,g.brand,g.department,g.region,g.routing_mode,g.min_health_score,
      wa.id whatsapp_account_id,wa.name whatsapp_name,wa.phone whatsapp_phone,
      (select count(*)::int from whatsapp_group_knowledge gk where gk.group_id=cv.group_id) knowledge_count,
      (select count(*)::int from whatsapp_group_operators go join operators o on o.id=go.operator_id where go.group_id=cv.group_id and o.active=true) operator_count
    from conversations cv
    left join whatsapp_groups g on g.id=cv.group_id
    left join whatsapp_accounts wa on wa.id=cv.whatsapp_account_id
    where cv.id=$1
  `,[conversationId]);
  return q.rows[0]||null;
}

export function registerGroupRuntimeRoutes(app:Express,deps:Deps){
  app.get('/api/v1/group-runtime/status',async(req,res)=>{
    const u=await deps.requireUser(req,res);if(!u)return;
    const [total,grouped,ambiguous]=await Promise.all([
      pool.query(`select count(*)::int n from conversations`),
      pool.query(`select count(*)::int n from conversations where group_id is not null`),
      pool.query(`select count(*)::int n from (select gm.whatsapp_account_id from whatsapp_group_members gm join whatsapp_groups g on g.id=gm.group_id and g.status='active' group by gm.whatsapp_account_id having count(*)>1)x`)
    ]);
    const t=Number(total.rows[0]?.n||0),g=Number(grouped.rows[0]?.n||0);
    res.json({sticky_group_runtime:true,conversations_total:t,conversations_grouped:g,coverage_percent:t?Math.round(g/t*100):100,ambiguous_sender_mappings:Number(ambiguous.rows[0]?.n||0)});
  });

  app.get('/api/v1/conversations/:id/group-context',async(req,res)=>{
    const u=await deps.requireUser(req,res);if(!u)return;
    const c=await context(req.params.id);if(!c)return res.status(404).json({error:'conversation_not_found'});
    if(!c.group_id)return res.json({...c,resolved:false,reason:'no_unambiguous_active_group_for_sender'});
    const [knowledge,operators]=await Promise.all([
      pool.query(`select ki.id,ki.title,ki.category,ki.authority_level,kv.version_no,kv.summary from whatsapp_group_knowledge gk join knowledge_items ki on ki.id=gk.knowledge_item_id join knowledge_versions kv on kv.id=ki.current_version_id where gk.group_id=$1 and ki.status='published' and kv.status='published' and (kv.effective_from is null or kv.effective_from<=now()) and (kv.expires_at is null or kv.expires_at>now()) order by ki.authority_level asc,ki.title`,[c.group_id]),
      pool.query(`select o.id,o.name,o.role,o.department,o.presence,go.role group_role from whatsapp_group_operators go join operators o on o.id=go.operator_id where go.group_id=$1 and o.active=true order by go.role desc,o.presence='online' desc,o.name`,[c.group_id])
    ]);
    res.json({...c,resolved:true,knowledge:knowledge.rows,operators:operators.rows});
  });

  app.post('/api/v1/group-runtime/reconcile',async(req,res)=>{
    const u=await deps.requireUser(req,res);if(!u)return;if(!['admin','supervisor'].includes(u.role))return res.status(403).json({error:'forbidden'});
    const r=await pool.query(`update conversations cv set group_id=x.group_id from (select gm.whatsapp_account_id,min(gm.group_id::text)::uuid group_id from whatsapp_group_members gm join whatsapp_groups g on g.id=gm.group_id and g.status='active' group by gm.whatsapp_account_id having count(*)=1)x where cv.group_id is null and cv.whatsapp_account_id=x.whatsapp_account_id returning cv.id`);
    res.json({ok:true,updated:r.rowCount||0});
  });
}
