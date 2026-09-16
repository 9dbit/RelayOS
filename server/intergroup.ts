import type {Express,Request,Response,NextFunction} from 'express';
import crypto from 'crypto';
import {pool} from './db.js';

type User={id:string;name:string;role:string;department?:string};
type Deps={
  requireUser:(req:Request,res:Response)=>Promise<User|null>;
  checkOrigin:(req:Request,res:Response)=>boolean;
  internalBaseUrl:string;
};

const model=process.env.OPENAI_COMMAND_MODEL||process.env.OPENAI_MODEL||'gpt-5.6-luna';
let runnerBusy=false;
let runnerStarted=false;

function threadCode(){return `IG-${crypto.randomBytes(3).toString('hex').toUpperCase()}`}
function clamp(v:any,min:number,max:number,fallback:number){const n=Number(v);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback}

export async function migrateIntergroup(){await pool.query(`
 create table if not exists intergroup_threads(
   id uuid primary key default gen_random_uuid(),
   thread_code text not null unique,
   source_group_id uuid not null references whatsapp_groups(id) on delete cascade,
   target_group_id uuid not null references whatsapp_groups(id) on delete cascade,
   topic text,
   status text not null default 'running' check(status in('running','paused','completed','cancelled')),
   max_turns int not null default 8 check(max_turns between 2 and 50),
   turn_count int not null default 0,
   interval_seconds int not null default 20 check(interval_seconds between 5 and 3600),
   next_turn_at timestamptz,
   stop_reason text,
   created_by uuid references operators(id),
   created_at timestamptz not null default now(),
   updated_at timestamptz not null default now()
 );
 create table if not exists intergroup_messages(
   id uuid primary key default gen_random_uuid(),
   thread_id uuid not null references intergroup_threads(id) on delete cascade,
   group_id uuid references whatsapp_groups(id) on delete set null,
   whatsapp_account_id uuid references whatsapp_accounts(id) on delete set null,
   side text not null check(side in('source','target','operator')),
   content text not null,
   metadata jsonb not null default '{}',
   created_at timestamptz not null default now()
 );
 create index if not exists idx_intergroup_threads_status_due on intergroup_threads(status,next_turn_at);
 create index if not exists idx_intergroup_messages_thread on intergroup_messages(thread_id,created_at);
`)}

async function resolveGroup(ref:string){
  return (await pool.query(`select * from whatsapp_groups where id::text=$1 or lower(group_code)=lower($1) or lower(name)=lower($1) limit 1`,[ref.trim()])).rows[0]||null;
}

async function groupContext(groupId:string){
  const g=(await pool.query(`select * from whatsapp_groups where id=$1`,[groupId])).rows[0];
  if(!g)return null;
  const [sender,knowledge]=await Promise.all([
    pool.query(`select wa.id,wa.name,wa.phone,wa.health_score from whatsapp_group_members gm join whatsapp_accounts wa on wa.id=gm.whatsapp_account_id where gm.group_id=$1 and wa.status in('active','healthy','verified','verifying') order by gm.is_primary desc,wa.health_score desc,gm.priority asc limit 1`,[groupId]),
    pool.query(`select ki.title,kv.summary,left(kv.content,700) content from whatsapp_group_knowledge gk join knowledge_items ki on ki.id=gk.knowledge_item_id join knowledge_versions kv on kv.id=ki.current_version_id where gk.group_id=$1 and ki.status='published' and kv.status='published' order by ki.authority_level asc limit 8`,[groupId])
  ]);
  return{group:g,sender:sender.rows[0]||null,knowledge:knowledge.rows};
}

async function aiText(instructions:string,input:string){
  const key=process.env.OPENAI_API_KEY;
  if(!key)return '';
  const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({model,instructions,input})});
  const d:any=await r.json();
  if(!r.ok)throw new Error(d?.error?.message||'OpenAI request failed');
  return String(d?.output_text||'').trim()||String((d?.output||[]).filter((x:any)=>x.type==='message').flatMap((x:any)=>x.content||[]).map((x:any)=>x.text||'').join('\n')).trim();
}

async function composeTurn(thread:any,side:'source'|'target'){
  const ownId=side==='source'?thread.source_group_id:thread.target_group_id;
  const otherId=side==='source'?thread.target_group_id:thread.source_group_id;
  const [own,other,hist]=await Promise.all([
    groupContext(ownId),groupContext(otherId),
    pool.query(`select m.side,m.content,g.name group_name,m.created_at from intergroup_messages m left join whatsapp_groups g on g.id=m.group_id where m.thread_id=$1 order by m.created_at desc limit 12`,[thread.id])
  ]);
  if(!own||!other)throw new Error('intergroup_group_missing');
  const history=hist.rows.reverse().map((m:any)=>`${m.group_name||m.side}: ${m.content}`).join('\n');
  const kb=own.knowledge.map((k:any)=>`- ${k.title}: ${k.summary||k.content||''}`).join('\n')||'- No dedicated knowledge attached';
  const topic=thread.topic||'general business follow-up';
  const instructions=`You are an internal RelayOS AI agent representing WhatsApp group "${own.group.name}". You are talking to another internal AI agent representing "${other.group.name}" in a sandbox/test thread. This is not a real customer conversation and must never claim a Meta/WhatsApp message was sent. Stay consistent with your own group knowledge. Reply naturally in Indonesian unless the conversation uses another language. Keep each turn concise, 1-4 short sentences. Move the discussion toward a useful resolution instead of endless small talk. Topic: ${topic}.\n\nYour group knowledge:\n${kb}`;
  const input=`Conversation so far:\n${history||'(none)'}\n\nWrite the next reply from ${own.group.name}.`;
  let text=await aiText(instructions,input);
  if(!text){text=side==='source'?`Halo tim ${other.group.name}, saya lanjut follow up soal ${topic}. Ada update yang bisa kita sinkronkan?`:`Halo tim ${own.group.name}, siap. Kami cek konteks ${topic} dan bisa lanjut koordinasi dari sini.`}
  return{content:text,group:own.group,sender:own.sender};
}

export async function createIntergroupConversation(input:any,createdBy?:string|null){
  const source=await resolveGroup(String(input.source_group_id||input.source_group||''));
  const target=await resolveGroup(String(input.target_group_id||input.target_group||''));
  if(!source||!target)throw new Error('source_or_target_group_not_found');
  if(source.id===target.id)throw new Error('source_and_target_group_must_differ');
  const maxTurns=clamp(input.max_turns,2,50,8),interval=clamp(input.interval_seconds,5,3600,20),topic=String(input.topic||'').trim()||null;
  const thread=(await pool.query(`insert into intergroup_threads(thread_code,source_group_id,target_group_id,topic,max_turns,interval_seconds,next_turn_at,created_by) values($1,$2,$3,$4,$5,$6,now(),$7) returning *`,[threadCode(),source.id,target.id,topic,maxTurns,interval,createdBy||null])).rows[0];
  const first=await composeTurn(thread,'source');
  await pool.query(`insert into intergroup_messages(thread_id,group_id,whatsapp_account_id,side,content,metadata) values($1,$2,$3,'source',$4,$5)`,[thread.id,first.group.id,first.sender?.id||null,first.content,JSON.stringify({sandbox:true,agent_to_agent:true})]);
  await pool.query(`update intergroup_threads set turn_count=1,next_turn_at=now()+($2||' seconds')::interval,updated_at=now() where id=$1`,[thread.id,String(interval)]);
  return(await getIntergroupThread(thread.id))!;
}

export async function getIntergroupThread(id:string){
  const t=(await pool.query(`select t.*,sg.name source_group_name,sg.group_code source_group_code,tg.name target_group_name,tg.group_code target_group_code from intergroup_threads t join whatsapp_groups sg on sg.id=t.source_group_id join whatsapp_groups tg on tg.id=t.target_group_id where t.id::text=$1 or t.thread_code=$1`,[id])).rows[0];
  if(!t)return null;
  const m=await pool.query(`select m.*,g.name group_name,wa.name sender_name,wa.phone sender_phone from intergroup_messages m left join whatsapp_groups g on g.id=m.group_id left join whatsapp_accounts wa on wa.id=m.whatsapp_account_id where m.thread_id=$1 order by m.created_at`,[t.id]);
  return{...t,messages:m.rows};
}

async function tickIntergroup(){
  if(runnerBusy)return;runnerBusy=true;
  try{
    const q=await pool.query(`select * from intergroup_threads where status='running' and coalesce(next_turn_at,now())<=now() order by next_turn_at nulls first limit 3`);
    for(const t of q.rows){
      if(Number(t.turn_count)>=Number(t.max_turns)){await pool.query(`update intergroup_threads set status='completed',stop_reason='max_turns_reached',next_turn_at=null,updated_at=now() where id=$1`,[t.id]);continue}
      const side:Number=Number(t.turn_count)%2===1?1:0;
      const nextSide:'source'|'target'=side===1?'target':'source';
      try{
        const turn=await composeTurn(t,nextSide);
        await pool.query(`insert into intergroup_messages(thread_id,group_id,whatsapp_account_id,side,content,metadata) values($1,$2,$3,$4,$5,$6)`,[t.id,turn.group.id,turn.sender?.id||null,nextSide,turn.content,JSON.stringify({sandbox:true,agent_to_agent:true})]);
        const n=Number(t.turn_count)+1;
        if(n>=Number(t.max_turns))await pool.query(`update intergroup_threads set turn_count=$2,status='completed',stop_reason='max_turns_reached',next_turn_at=null,updated_at=now() where id=$1`,[t.id,n]);
        else await pool.query(`update intergroup_threads set turn_count=$2,next_turn_at=now()+($3||' seconds')::interval,updated_at=now() where id=$1`,[t.id,n,String(t.interval_seconds)]);
      }catch(e:any){await pool.query(`update intergroup_threads set status='paused',stop_reason=$2,next_turn_at=null,updated_at=now() where id=$1`,[t.id,String(e.message||'runner_error').slice(0,500)])}
    }
  }finally{runnerBusy=false}
}

export function startIntergroupRunner(){if(runnerStarted)return;runnerStarted=true;setInterval(()=>{void tickIntergroup()},5000).unref?.()}

async function internalFetch(deps:Deps,path:string,u:User,init?:RequestInit){
  const headers:any={...(init?.headers||{}),'x-relayos-operator-id':u.id};
  if(init?.body)headers['content-type']='application/json';
  return fetch(`${deps.internalBaseUrl}${path}`,{...init,headers});
}

function parseGroupCommand(text:string){
  const m=text.match(/(?:gr(?:ou)?p|kelompok)\s+(.+?)\s+(?:tolong\s+)?(?:follow\s*up|hubungi|chat|kontak)\s+(?:gr(?:ou)?p|kelompok)\s+(.+?)(?=\s+(?:tentang|soal|dengan|interval|max|sebanyak)|[,.!?]|$)/i);
  if(!m)return null;
  const turns=text.match(/(?:max|sebanyak)\s+(\d+)\s*(?:turn|balasan|pesan|message)?/i);
  const interval=text.match(/interval\s+(\d+)\s*(?:detik|second|seconds)?/i);
  const topic=text.match(/(?:tentang|soal)\s+(.+?)(?=\s+(?:interval|max|sebanyak)|[.!?]|$)/i);
  return{source_group:m[1].trim(),target_group:m[2].trim(),topic:topic?.[1]?.trim()||'',max_turns:clamp(turns?.[1],2,50,8),interval_seconds:clamp(interval?.[1],5,3600,20)};
}

export function registerIntergroupRoutes(app:Express,deps:Deps){
  app.post('/api/v1/command-center/chat',async(req,res,next)=>{
    if(!deps.checkOrigin(req,res))return;
    const text=String(req.body?.message||'').trim(),parsed=parseGroupCommand(text);if(!parsed)return next();
    const u=await deps.requireUser(req,res);if(!u)return;
    const source=await resolveGroup(parsed.source_group),target=await resolveGroup(parsed.target_group);
    if(!source||!target)return res.status(400).json({error:'group_not_found',detail:'Use an exact group name or Group ID.'});
    let threadId=String(req.body?.thread_id||'');
    if(!threadId)threadId=(await pool.query(`insert into command_threads(operator_id,title) values($1,$2) returning id`,[u.id,text.slice(0,70)])).rows[0].id;
    await pool.query(`insert into command_messages(thread_id,role,content) values($1,'user',$2)`,[threadId,text]);
    const args={source_group_id:source.id,target_group_id:target.id,source_group_code:source.group_code,target_group_code:target.group_code,topic:parsed.topic,max_turns:parsed.max_turns,interval_seconds:parsed.interval_seconds};
    const p=(await pool.query(`insert into command_proposals(thread_id,operator_id,action_type,arguments,risk_level) values($1,$2,'start_intergroup_conversation',$3,'medium') returning *`,[threadId,u.id,JSON.stringify(args)])).rows[0];
    const answer=`Saya siapkan Agent-to-Agent sandbox: ${source.name} → ${target.name}. Maksimum ${parsed.max_turns} turn, interval ${parsed.interval_seconds} detik. Setelah approval, kedua AI group akan bersahut-sahutan dan thread-nya muncul di Inbox dengan badge Agent-to-Agent / Sandbox.`;
    await pool.query(`insert into command_messages(thread_id,role,content,metadata) values($1,'assistant',$2,$3)`,[threadId,answer,JSON.stringify({mode:'intergroup_sandbox'})]);
    return res.json({thread_id:threadId,answer,proposals:[p],model,mode:'ai_crm_operator'});
  });

  app.post('/api/v1/command-center/proposals/:id/approve',async(req,res,next)=>{
    if(!deps.checkOrigin(req,res))return;const u=await deps.requireUser(req,res);if(!u)return;
    const p=(await pool.query(`select * from command_proposals where id=$1 and operator_id=$2 and status='pending'`,[req.params.id,u.id])).rows[0];
    if(!p||p.action_type!=='start_intergroup_conversation')return next();
    try{const result=await createIntergroupConversation(p.arguments,u.id);await pool.query(`update command_proposals set status='executed',approved_by=$2,approved_at=now(),executed_at=now(),result=$3 where id=$1`,[p.id,u.id,JSON.stringify({thread_id:result.id,thread_code:result.thread_code})]);return res.json({ok:true,result:{thread:result,note:'Internal sandbox only. No Meta message was sent.'}})}catch(e:any){return res.status(400).json({error:e.message||'intergroup_start_failed'})}
  });

  app.post('/api/v1/command-center/proposals/:id/reject',async(req,res,next)=>{
    if(!deps.checkOrigin(req,res))return;const u=await deps.requireUser(req,res);if(!u)return;
    const p=(await pool.query(`select action_type from command_proposals where id=$1 and operator_id=$2 and status='pending'`,[req.params.id,u.id])).rows[0];if(!p||p.action_type!=='start_intergroup_conversation')return next();
    await pool.query(`update command_proposals set status='rejected',approved_by=$2,approved_at=now() where id=$1`,[req.params.id,u.id]);return res.json({ok:true});
  });

  app.get('/api/v1/intergroup/threads',async(req,res)=>{const u=await deps.requireUser(req,res);if(!u)return;const q=await pool.query(`select t.*,sg.name source_group_name,sg.group_code source_group_code,tg.name target_group_name,tg.group_code target_group_code,(select content from intergroup_messages m where m.thread_id=t.id order by created_at desc limit 1) last_message,(select created_at from intergroup_messages m where m.thread_id=t.id order by created_at desc limit 1) last_message_at from intergroup_threads t join whatsapp_groups sg on sg.id=t.source_group_id join whatsapp_groups tg on tg.id=t.target_group_id order by coalesce((select created_at from intergroup_messages m where m.thread_id=t.id order by created_at desc limit 1),t.created_at) desc limit 100`);res.json({items:q.rows})});
  app.get('/api/v1/intergroup/threads/:id',async(req,res)=>{const u=await deps.requireUser(req,res);if(!u)return;const t=await getIntergroupThread(req.params.id);t?res.json(t):res.status(404).json({error:'intergroup_thread_not_found'})});
  app.post('/api/v1/intergroup/threads/:id/status',async(req,res)=>{if(!deps.checkOrigin(req,res))return;const u=await deps.requireUser(req,res);if(!u)return;if(!['admin','supervisor'].includes(u.role))return res.status(403).json({error:'forbidden'});const status=String(req.body?.status||'');if(!['running','paused','completed','cancelled'].includes(status))return res.status(400).json({error:'invalid_status'});const q=await pool.query(`update intergroup_threads set status=$2,next_turn_at=case when $2='running' then now() else null end,stop_reason=case when $2='running' then null else stop_reason end,updated_at=now() where id=$1 returning *`,[req.params.id,status]);res.json({ok:true,thread:q.rows[0]})});

  app.get('/api/v1/conversations',async(req,res)=>{const u=await deps.requireUser(req,res);if(!u)return;try{const r=await internalFetch(deps,req.originalUrl,u);const d:any=await r.json();if(!r.ok)return res.status(r.status).json(d);const q=await pool.query(`select t.id,'Agent-to-Agent'::text channel_name,(sg.name||' ↔ '||tg.name)::text customer_name,t.thread_code::text customer_phone,'sandbox'::text intent,case when t.status='running' then 'open' else t.status end::text status,0::int unread_count,'none'::text escalation_status,null::text escalation_reason,null::uuid assigned_operator_id,null::text assigned_operator,null::text assigned_operator_name,'normal'::text priority,true::boolean is_intergroup,(select content from intergroup_messages m where m.thread_id=t.id order by created_at desc limit 1) last_message,coalesce((select created_at from intergroup_messages m where m.thread_id=t.id order by created_at desc limit 1),t.created_at) last_message_at from intergroup_threads t join whatsapp_groups sg on sg.id=t.source_group_id join whatsapp_groups tg on tg.id=t.target_group_id where t.status<>'cancelled' order by last_message_at desc limit 100`);const items=[...(d.items||[]),...q.rows].sort((a:any,b:any)=>new Date(b.last_message_at||0).getTime()-new Date(a.last_message_at||0).getTime());res.json({...d,items})}catch(e:any){res.status(502).json({error:'backend_unavailable',detail:e.message})}});

  app.get('/api/v1/conversations/:id/messages',async(req,res)=>{const u=await deps.requireUser(req,res);if(!u)return;const t=await getIntergroupThread(req.params.id);if(!t){const r=await internalFetch(deps,req.originalUrl,u);const d:any=await r.json();return res.status(r.status).json(d)}const items=t.messages.map((m:any)=>({id:m.id,conversation_id:t.id,direction:m.side==='target'?'inbound':'outbound',sender_type:m.side==='operator'?'Operator':`${m.group_name||m.side}${m.sender_phone?` · ${m.sender_phone}`:''}`,original_text:m.content,rewritten_text:m.content,delivery_status:'internal',metadata:{sandbox:true,agent_to_agent:true,side:m.side},created_at:m.created_at}));res.json({items,notes:[],events:[]})});

  app.post('/api/v1/conversations/:id/read',async(req,res,next)=>{const t=(await pool.query(`select id from intergroup_threads where id=$1`,[req.params.id])).rows[0];if(!t)return next();if(!deps.checkOrigin(req,res))return;const u=await deps.requireUser(req,res);if(!u)return;res.json({ok:true})});
  app.post('/api/v1/conversations/:id/operator-preview',async(req,res,next)=>{const t=(await pool.query(`select id from intergroup_threads where id=$1`,[req.params.id])).rows[0];if(!t)return next();if(!deps.checkOrigin(req,res))return;const u=await deps.requireUser(req,res);if(!u)return;res.json({rewritten_text:String(req.body?.text||''),ai_available:Boolean(process.env.OPENAI_API_KEY),sandbox:true})});
  app.post('/api/v1/conversations/:id/operator-send',async(req,res,next)=>{const t=(await pool.query(`select * from intergroup_threads where id=$1`,[req.params.id])).rows[0];if(!t)return next();if(!deps.checkOrigin(req,res))return;const u=await deps.requireUser(req,res);if(!u)return;const text=String(req.body?.rewritten_text||req.body?.original_text||'').trim();if(!text)return res.status(400).json({error:'message_required'});await pool.query(`insert into intergroup_messages(thread_id,side,content,metadata) values($1,'operator',$2,$3)`,[t.id,text,JSON.stringify({sandbox:true,manual_operator:true,operator_id:u.id})]);await pool.query(`update intergroup_threads set next_turn_at=case when status='running' then now()+($2||' seconds')::interval else next_turn_at end,updated_at=now() where id=$1`,[t.id,String(t.interval_seconds)]);res.json({ok:true,delivery:{queued:false,internal:true},sandbox:true})});
  app.post('/api/v1/conversations/:id/status',async(req,res,next)=>{const t=(await pool.query(`select * from intergroup_threads where id=$1`,[req.params.id])).rows[0];if(!t)return next();if(!deps.checkOrigin(req,res))return;const u=await deps.requireUser(req,res);if(!u)return;const requested=String(req.body?.status||'');const status=requested==='open'?'running':requested==='closed'?'completed':requested;if(!['running','paused','completed','cancelled'].includes(status))return res.status(400).json({error:'invalid_status'});await pool.query(`update intergroup_threads set status=$2,next_turn_at=case when $2='running' then now() else null end,updated_at=now() where id=$1`,[t.id,status]);res.json({ok:true})});
}
