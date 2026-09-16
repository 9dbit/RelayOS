import type {Express,Request,Response} from 'express';
import {pool} from './db.js';

type Actor={id:string;name:string;role:string};

async function actor(req:Request):Promise<Actor|null>{
  const id=String(req.header('x-relayos-operator-id')||'').trim();
  if(!id)return null;
  const q=await pool.query('select id,name,role from operators where id=$1 and active=true',[id]);
  return q.rows[0]||null;
}
async function requireActor(req:Request,res:Response,roles:string[]=['admin','supervisor','operator']){
  const a=await actor(req);if(!a){res.status(401).json({error:'authentication_required'});return null}
  if(!roles.includes(a.role)){res.status(403).json({error:'forbidden',role:a.role});return null}
  return a;
}
function arr(v:any){return Array.isArray(v)?v.map(String):String(v||'').split(',').map(x=>x.trim()).filter(Boolean)}

export async function migrateKnowledge(){
  await pool.query(`
    create table if not exists ai_agents(
      id uuid primary key default gen_random_uuid(),
      slug text not null unique,
      name text not null,
      description text,
      department text,
      agent_type text not null default 'service',
      status text not null default 'active',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists knowledge_items(
      id uuid primary key default gen_random_uuid(),
      title text not null,
      category text not null,
      department text,
      source_type text not null default 'manual',
      authority_level int not null default 3 check(authority_level between 1 and 6),
      data_class text not null default 'static' check(data_class in ('static','dynamic')),
      status text not null default 'draft' check(status in ('draft','review','published','archived')),
      current_version_id uuid,
      created_by uuid references operators(id),
      approved_by uuid references operators(id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists knowledge_versions(
      id uuid primary key default gen_random_uuid(),
      item_id uuid not null references knowledge_items(id) on delete cascade,
      version_no int not null,
      content text not null,
      summary text,
      tags text[] not null default '{}',
      source_ref text,
      effective_from timestamptz,
      expires_at timestamptz,
      status text not null default 'draft' check(status in ('draft','review','published','archived')),
      created_by uuid references operators(id),
      approved_by uuid references operators(id),
      created_at timestamptz not null default now(),
      unique(item_id,version_no)
    );

    create table if not exists knowledge_agent_scopes(
      agent_id uuid not null references ai_agents(id) on delete cascade,
      item_id uuid not null references knowledge_items(id) on delete cascade,
      access_mode text not null default 'read',
      created_at timestamptz not null default now(),
      primary key(agent_id,item_id)
    );

    create table if not exists knowledge_usage_logs(
      id uuid primary key default gen_random_uuid(),
      agent_id uuid references ai_agents(id),
      operator_id uuid references operators(id),
      query text not null,
      retrieval_mode text not null default 'lexical',
      matched_item_ids uuid[] not null default '{}',
      evidence jsonb not null default '[]',
      created_at timestamptz not null default now()
    );

    alter table knowledge_items drop constraint if exists knowledge_items_current_version_id_fkey;
    alter table knowledge_items add constraint knowledge_items_current_version_id_fkey foreign key(current_version_id) references knowledge_versions(id) on delete set null;
    create index if not exists idx_knowledge_items_status_category on knowledge_items(status,category,department);
    create index if not exists idx_knowledge_versions_item_status on knowledge_versions(item_id,status,version_no desc);
    create index if not exists idx_knowledge_scope_agent on knowledge_agent_scopes(agent_id,item_id);
    create index if not exists idx_knowledge_search on knowledge_versions using gin(to_tsvector('simple',coalesce(content,'')||' '||coalesce(summary,'')));
  `);

  const seeds=[
    ['sales-agent','Sales Agent','Product, pricing, promotion and sales guidance','Sales'],
    ['customer-service-agent','Customer Service Agent','Support, complaint, return and service policies','Customer Service'],
    ['payment-agent','Payment Agent','Payment, invoice and settlement guidance','Finance'],
    ['vip-agent','VIP Agent','VIP service rules and priority handling','VIP'],
    ['supervisor-agent','Supervisor Agent','Cross-department policy and escalation supervision','Management']
  ];
  for(const s of seeds)await pool.query(`insert into ai_agents(slug,name,description,department) values($1,$2,$3,$4) on conflict(slug) do update set name=excluded.name,description=excluded.description,department=excluded.department,updated_at=now()`,s);
}

export async function retrieveKnowledge(query:string,agentSlug:string,limit=6,operatorId?:string|null){
  const aq=await pool.query('select id,slug,name from ai_agents where slug=$1 and status=$2',[agentSlug,'active']);
  const ag=aq.rows[0];if(!ag)return{agent:null,items:[],retrieval_mode:'lexical'};
  const q=await pool.query(`
    select ki.id,ki.title,ki.category,ki.department,ki.authority_level,ki.data_class,kv.id version_id,kv.version_no,kv.content,kv.summary,kv.tags,kv.source_ref,kv.effective_from,kv.expires_at,
      ts_rank(to_tsvector('simple',coalesce(ki.title,'')||' '||coalesce(kv.summary,'')||' '||coalesce(kv.content,'')),plainto_tsquery('simple',$2)) as rank
    from knowledge_agent_scopes kas
    join knowledge_items ki on ki.id=kas.item_id
    join knowledge_versions kv on kv.id=ki.current_version_id
    where kas.agent_id=$1 and ki.status='published' and kv.status='published'
      and (kv.effective_from is null or kv.effective_from<=now())
      and (kv.expires_at is null or kv.expires_at>now())
      and (to_tsvector('simple',coalesce(ki.title,'')||' '||coalesce(kv.summary,'')||' '||coalesce(kv.content,'')) @@ plainto_tsquery('simple',$2)
        or ki.title ilike '%'||$2||'%' or kv.content ilike '%'||$2||'%')
    order by ki.authority_level asc,rank desc,kv.version_no desc
    limit $3`,[ag.id,query,Math.max(1,Math.min(limit,12))]);
  const evidence=q.rows.map((x:any)=>({item_id:x.id,title:x.title,version:x.version_no,authority_level:x.authority_level,category:x.category,source_ref:x.source_ref,excerpt:String(x.content||'').slice(0,900)}));
  await pool.query('insert into knowledge_usage_logs(agent_id,operator_id,query,retrieval_mode,matched_item_ids,evidence) values($1,$2,$3,$4,$5,$6)',[ag.id,operatorId||null,query,'lexical',q.rows.map((x:any)=>x.id),JSON.stringify(evidence)]);
  return{agent:ag,items:q.rows,retrieval_mode:'lexical'};
}

export function registerKnowledgeRoutes(app:Express){
  app.get('/api/v1/knowledge/dashboard',async(req,res)=>{const a=await requireActor(req,res);if(!a)return;const [items,published,review,agents,usage]=await Promise.all([
    pool.query('select count(*)::int n from knowledge_items'),pool.query("select count(*)::int n from knowledge_items where status='published'"),pool.query("select count(*)::int n from knowledge_items where status='review'"),pool.query("select count(*)::int n from ai_agents where status='active'"),pool.query("select count(*)::int n from knowledge_usage_logs where created_at>now()-interval '24 hours'")]);res.json({items:items.rows[0].n,published:published.rows[0].n,review:review.rows[0].n,agents:agents.rows[0].n,searches24h:usage.rows[0].n})});

  app.get('/api/v1/knowledge/agents',async(req,res)=>{const a=await requireActor(req,res);if(!a)return;const q=await pool.query(`select a.*,count(kas.item_id)::int knowledge_count from ai_agents a left join knowledge_agent_scopes kas on kas.agent_id=a.id group by a.id order by a.name`);res.json({items:q.rows})});

  app.get('/api/v1/knowledge/items',async(req,res)=>{const a=await requireActor(req,res);if(!a)return;const q=await pool.query(`select ki.*,kv.version_no,kv.summary,kv.tags,kv.effective_from,kv.expires_at,coalesce(json_agg(json_build_object('id',ag.id,'slug',ag.slug,'name',ag.name)) filter(where ag.id is not null),'[]') agents from knowledge_items ki left join knowledge_versions kv on kv.id=ki.current_version_id left join knowledge_agent_scopes kas on kas.item_id=ki.id left join ai_agents ag on ag.id=kas.agent_id group by ki.id,kv.id order by ki.updated_at desc limit 500`);res.json({items:q.rows})});

  app.post('/api/v1/knowledge/items',async(req,res)=>{const a=await requireActor(req,res,['admin','supervisor']);if(!a)return;const title=String(req.body?.title||'').trim(),category=String(req.body?.category||'General').trim(),content=String(req.body?.content||'').trim();if(!title||!content)return res.status(400).json({error:'title_and_content_required'});const client=await pool.connect();try{await client.query('begin');const item=await client.query(`insert into knowledge_items(title,category,department,source_type,authority_level,data_class,status,created_by) values($1,$2,$3,$4,$5,$6,'draft',$7) returning *`,[title,category,String(req.body?.department||'').trim()||null,String(req.body?.source_type||'manual'),Math.max(1,Math.min(Number(req.body?.authority_level)||3,6)),req.body?.data_class==='dynamic'?'dynamic':'static',a.id]);const version=await client.query(`insert into knowledge_versions(item_id,version_no,content,summary,tags,source_ref,effective_from,expires_at,status,created_by) values($1,1,$2,$3,$4,$5,$6,$7,'draft',$8) returning *`,[item.rows[0].id,content,String(req.body?.summary||'').trim()||null,arr(req.body?.tags),String(req.body?.source_ref||'').trim()||null,req.body?.effective_from||null,req.body?.expires_at||null,a.id]);await client.query('update knowledge_items set current_version_id=$2 where id=$1',[item.rows[0].id,version.rows[0].id]);for(const agentId of arr(req.body?.agent_ids))await client.query('insert into knowledge_agent_scopes(agent_id,item_id) values($1,$2) on conflict do nothing',[agentId,item.rows[0].id]);await client.query('commit');res.status(201).json({item:item.rows[0],version:version.rows[0]})}catch(e){await client.query('rollback');throw e}finally{client.release()}});

  app.post('/api/v1/knowledge/items/:id/version',async(req,res)=>{const a=await requireActor(req,res,['admin','supervisor']);if(!a)return;const content=String(req.body?.content||'').trim();if(!content)return res.status(400).json({error:'content_required'});const n=await pool.query('select coalesce(max(version_no),0)+1 n from knowledge_versions where item_id=$1',[req.params.id]);const q=await pool.query(`insert into knowledge_versions(item_id,version_no,content,summary,tags,source_ref,effective_from,expires_at,status,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9) returning *`,[req.params.id,n.rows[0].n,content,String(req.body?.summary||'').trim()||null,arr(req.body?.tags),String(req.body?.source_ref||'').trim()||null,req.body?.effective_from||null,req.body?.expires_at||null,a.id]);await pool.query("update knowledge_items set current_version_id=$2,status='draft',updated_at=now() where id=$1",[req.params.id,q.rows[0].id]);res.status(201).json(q.rows[0])});

  app.post('/api/v1/knowledge/items/:id/review',async(req,res)=>{const a=await requireActor(req,res,['admin','supervisor']);if(!a)return;await pool.query("update knowledge_items set status='review',updated_at=now() where id=$1",[req.params.id]);await pool.query("update knowledge_versions set status='review' where id=(select current_version_id from knowledge_items where id=$1)",[req.params.id]);res.json({ok:true})});

  app.post('/api/v1/knowledge/items/:id/publish',async(req,res)=>{const a=await requireActor(req,res,['admin']);if(!a)return;const q=await pool.query('select current_version_id from knowledge_items where id=$1',[req.params.id]);if(!q.rows[0])return res.status(404).json({error:'knowledge_not_found'});await pool.query("update knowledge_versions set status='archived' where item_id=$1 and id<>$2 and status='published'",[req.params.id,q.rows[0].current_version_id]);await pool.query("update knowledge_versions set status='published',approved_by=$2 where id=$1",[q.rows[0].current_version_id,a.id]);await pool.query("update knowledge_items set status='published',approved_by=$2,updated_at=now() where id=$1",[req.params.id,a.id]);res.json({ok:true})});

  app.post('/api/v1/knowledge/items/:id/archive',async(req,res)=>{const a=await requireActor(req,res,['admin']);if(!a)return;await pool.query("update knowledge_items set status='archived',updated_at=now() where id=$1",[req.params.id]);res.json({ok:true})});

  app.post('/api/v1/knowledge/items/:id/scope',async(req,res)=>{const a=await requireActor(req,res,['admin','supervisor']);if(!a)return;const ids=arr(req.body?.agent_ids);const client=await pool.connect();try{await client.query('begin');await client.query('delete from knowledge_agent_scopes where item_id=$1',[req.params.id]);for(const id of ids)await client.query('insert into knowledge_agent_scopes(agent_id,item_id) values($1,$2)',[id,req.params.id]);await client.query('commit');res.json({ok:true,agent_ids:ids})}catch(e){await client.query('rollback');throw e}finally{client.release()}});

  app.post('/api/v1/knowledge/search',async(req,res)=>{const a=await requireActor(req,res);if(!a)return;const query=String(req.body?.query||'').trim(),slug=String(req.body?.agent_slug||'supervisor-agent');if(!query)return res.status(400).json({error:'query_required'});const result=await retrieveKnowledge(query,slug,Number(req.body?.limit)||6,a.id);res.json(result)});
}
