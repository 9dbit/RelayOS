import type {Express,Request,Response} from 'express';
import {pool} from './db.js';

type User={id:string;name:string;role:string;department?:string};
type Deps={requireUser:(req:Request,res:Response)=>Promise<User|null>};

async function candidates(groupId:string){
  return (await pool.query(`
    select o.id,o.name,o.email,o.role,o.department,o.presence,go.role group_role,
      (select count(*)::int from conversations cv where cv.assigned_operator_id=o.id and cv.status='open') open_load
    from whatsapp_group_operators go
    join operators o on o.id=go.operator_id
    where go.group_id=$1 and o.active=true
    order by case when go.role='lead' then 0 else 1 end,
      case o.presence when 'online' then 0 when 'away' then 1 else 2 end,
      (select count(*) from conversations cv where cv.assigned_operator_id=o.id and cv.status='open') asc,
      o.name asc
  `,[groupId])).rows;
}

async function routeConversation(conversationId:string,actor='system',force=false){
  const cv=(await pool.query(`select cv.id,cv.group_id,cv.status,cv.assigned_operator_id,cv.assigned_operator,g.group_code,g.name group_name from conversations cv left join whatsapp_groups g on g.id=cv.group_id where cv.id=$1`,[conversationId])).rows[0];
  if(!cv)return{ok:false,error:'conversation_not_found'};
  if(!cv.group_id)return{ok:false,error:'conversation_has_no_group'};
  if(cv.assigned_operator_id&&!force)return{ok:true,already_assigned:true,conversation:cv};
  const list=await candidates(cv.group_id),chosen=list[0];
  if(!chosen){
    await pool.query(`insert into operator_routing_events(conversation_id,group_id,event_type,actor,detail) values($1,$2,'unassigned_no_pool',$3,$4)`,[cv.id,cv.group_id,actor,JSON.stringify({group_code:cv.group_code,group_name:cv.group_name})]);
    return{ok:false,error:'no_group_operator_available',group:{id:cv.group_id,group_code:cv.group_code,name:cv.group_name}};
  }
  const q=(await pool.query(`update conversations set assigned_operator_id=$2,assigned_operator=$3 where id=$1 returning *`,[cv.id,chosen.id,chosen.name])).rows[0];
  await pool.query(`insert into operator_routing_events(conversation_id,group_id,operator_id,event_type,actor,detail) values($1,$2,$3,'assigned',$4,$5)`,[cv.id,cv.group_id,chosen.id,actor,JSON.stringify({group_role:chosen.group_role,presence:chosen.presence,open_load:chosen.open_load,forced:force})]);
  return{ok:true,conversation:q,operator:chosen};
}

export async function migrateOperatorRouting(){
  await pool.query(`
    create table if not exists operator_routing_events(
      id uuid primary key default gen_random_uuid(),
      conversation_id uuid not null references conversations(id) on delete cascade,
      group_id uuid references whatsapp_groups(id) on delete set null,
      operator_id uuid references operators(id) on delete set null,
      event_type text not null,
      actor text not null default 'system',
      detail jsonb not null default '{}',
      created_at timestamptz not null default now()
    );
    create index if not exists idx_operator_routing_conversation on operator_routing_events(conversation_id,created_at desc);
    create index if not exists idx_operator_routing_group on operator_routing_events(group_id,created_at desc);

    create or replace function relayos_route_group_operator() returns trigger as $$
    declare chosen_id uuid; chosen_name text; chosen_role text; chosen_presence text; chosen_load int;
    begin
      if new.group_id is null or new.assigned_operator_id is not null then return new; end if;
      select o.id,o.name,go.role,o.presence,
        (select count(*)::int from conversations cv where cv.assigned_operator_id=o.id and cv.status='open')
      into chosen_id,chosen_name,chosen_role,chosen_presence,chosen_load
      from whatsapp_group_operators go
      join operators o on o.id=go.operator_id
      where go.group_id=new.group_id and o.active=true
      order by case when go.role='lead' then 0 else 1 end,
        case o.presence when 'online' then 0 when 'away' then 1 else 2 end,
        (select count(*) from conversations cv where cv.assigned_operator_id=o.id and cv.status='open') asc,
        o.name asc
      limit 1;
      if chosen_id is not null then
        update conversations set assigned_operator_id=chosen_id,assigned_operator=chosen_name where id=new.id and assigned_operator_id is null;
        insert into operator_routing_events(conversation_id,group_id,operator_id,event_type,actor,detail)
        values(new.id,new.group_id,chosen_id,'assigned','system',jsonb_build_object('group_role',chosen_role,'presence',chosen_presence,'open_load',coalesce(chosen_load,0),'source','insert_trigger'));
      else
        insert into operator_routing_events(conversation_id,group_id,event_type,actor,detail)
        values(new.id,new.group_id,'unassigned_no_pool','system',jsonb_build_object('source','insert_trigger'));
      end if;
      return new;
    end;
    $$ language plpgsql;

    drop trigger if exists trg_relayos_route_group_operator on conversations;
    create trigger trg_relayos_route_group_operator
      after insert on conversations
      for each row execute function relayos_route_group_operator();
  `);
}

export function registerOperatorRoutingRoutes(app:Express,deps:Deps){
  app.get('/api/v1/operator-routing/status',async(req,res)=>{
    const u=await deps.requireUser(req,res);if(!u)return;
    const q=await pool.query(`select
      count(*) filter(where status='open' and group_id is not null)::int grouped_open,
      count(*) filter(where status='open' and group_id is not null and assigned_operator_id is not null)::int assigned,
      count(*) filter(where status='open' and group_id is not null and assigned_operator_id is null)::int unassigned
      from conversations`);
    const noPool=(await pool.query(`select count(*)::int n from whatsapp_groups g where g.status='active' and not exists(select 1 from whatsapp_group_operators go join operators o on o.id=go.operator_id and o.active=true where go.group_id=g.id)`)).rows[0]?.n||0;
    res.json({...q.rows[0],groups_without_active_operator_pool:Number(noPool),policy:'lead_priority_then_presence_then_least_load'});
  });

  app.get('/api/v1/conversations/:id/operator-candidates',async(req,res)=>{
    const u=await deps.requireUser(req,res);if(!u)return;
    const cv=(await pool.query(`select cv.id,cv.group_id,cv.assigned_operator_id,cv.assigned_operator,g.group_code,g.name group_name from conversations cv left join whatsapp_groups g on g.id=cv.group_id where cv.id=$1`,[req.params.id])).rows[0];
    if(!cv)return res.status(404).json({error:'conversation_not_found'});
    if(!cv.group_id)return res.status(409).json({error:'conversation_has_no_group'});
    res.json({conversation:cv,policy:'lead_priority_then_presence_then_least_load',candidates:await candidates(cv.group_id)});
  });

  app.post('/api/v1/conversations/:id/route-operator',async(req,res)=>{
    const u=await deps.requireUser(req,res);if(!u)return;
    if(!['admin','supervisor'].includes(u.role))return res.status(403).json({error:'forbidden'});
    const result=await routeConversation(req.params.id,u.name,Boolean(req.body?.force));
    if(!result.ok)return res.status(result.error==='conversation_not_found'?404:409).json(result);
    res.json(result);
  });

  app.post('/api/v1/operator-routing/reconcile',async(req,res)=>{
    const u=await deps.requireUser(req,res);if(!u)return;
    if(!['admin','supervisor'].includes(u.role))return res.status(403).json({error:'forbidden'});
    const rows=(await pool.query(`select id from conversations where status='open' and group_id is not null and assigned_operator_id is null order by created_at asc limit 250`)).rows;
    let assigned=0,unassigned=0;
    for(const row of rows){const r=await routeConversation(row.id,u.name,false);r.ok?assigned++:unassigned++}
    res.json({ok:true,checked:rows.length,assigned,unassigned});
  });
}
