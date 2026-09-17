import type {Express,Request,Response} from 'express';
import {pool} from './db.js';

type User={id:string;name:string;role:string;department?:string};
type Deps={requireUser:(req:Request,res:Response)=>Promise<User|null>};

function outputText(d:any){return String(d?.output_text||'').trim()||String((d?.output||[]).filter((x:any)=>x.type==='message').flatMap((x:any)=>x.content||[]).map((x:any)=>x.text||'').join('\n')).trim()}

async function groupEvidence(groupId:string,query:string,limit=8){
  const words=[...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(x=>x.length>2))];
  const q=await pool.query(`
    select ki.id item_id,ki.title,ki.category,ki.authority_level,kv.version_no,kv.summary,kv.content,kv.source_ref
    from whatsapp_group_knowledge gk
    join knowledge_items ki on ki.id=gk.knowledge_item_id
    join knowledge_versions kv on kv.id=ki.current_version_id
    where gk.group_id=$1 and ki.status='published' and kv.status='published'
      and (kv.effective_from is null or kv.effective_from<=now())
      and (kv.expires_at is null or kv.expires_at>now())
  `,[groupId]);
  return q.rows.map((r:any)=>{const h=`${r.title||''} ${r.summary||''} ${r.content||''}`.toLowerCase();const lexical=words.reduce((n,w)=>n+(h.includes(w)?1:0),0)/(words.length||1);const authority=(7-Number(r.authority_level||6))/6;return{...r,scope:'group',score:lexical*.75+authority*.25}}).sort((a:any,b:any)=>b.score-a.score).slice(0,Math.max(1,Math.min(limit,12)));
}

export function registerGroupRagRoutes(app:Express,deps:Deps){
  app.post('/api/v1/group-rag/search',async(req,res)=>{
    const u=await deps.requireUser(req,res);if(!u)return;
    const query=String(req.body?.query||'').trim(),groupId=String(req.body?.group_id||'').trim();
    if(!query||!groupId)return res.status(400).json({error:'query_and_group_id_required'});
    const g=(await pool.query(`select id,group_code,name,status from whatsapp_groups where (id::text=$1 or group_code=$1) and status='active'`,[groupId])).rows[0];
    if(!g)return res.status(404).json({error:'active_group_not_found'});
    const items=await groupEvidence(g.id,query,Number(req.body?.limit)||8);
    res.json({group:g,items,mode:'group_lexical_authority',scope:'group'});
  });

  app.post('/api/v1/agent/group-grounded-preview/:conversationId',async(req,res)=>{
    const u=await deps.requireUser(req,res);if(!u)return;
    const draft=String(req.body?.operator_text||'').trim();if(!draft)return res.status(400).json({error:'operator_text_required'});
    const cv=(await pool.query(`select cv.id,cv.group_id,cv.intent,c.name customer_name,(select original_text from messages where conversation_id=cv.id and direction='inbound' order by created_at desc limit 1) customer_text,g.name group_name,g.group_code from conversations cv join customers c on c.id=cv.customer_id left join whatsapp_groups g on g.id=cv.group_id where cv.id=$1`,[req.params.conversationId])).rows[0];
    if(!cv)return res.status(404).json({error:'conversation_not_found'});
    if(!cv.group_id)return res.status(409).json({error:'conversation_group_unresolved',detail:'Assign the WhatsApp sender to exactly one active group, then reconcile group runtime.'});
    const query=`${cv.customer_text||''} ${draft}`.trim();
    const evidence=await groupEvidence(cv.group_id,query,8);
    const evidenceText=evidence.map((x:any,i:number)=>`[G${i+1}] ${x.title} v${x.version_no}: ${x.content}`).join('\n\n');
    let reply=draft,provider='fallback';
    if(process.env.OPENAI_API_KEY){
      const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${process.env.OPENAI_API_KEY}`},body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-5.6-luna',input:`You are RelayOS WhatsApp copilot for group ${cv.group_name||cv.group_code}. Rewrite the operator draft naturally and concisely. Use only the operator draft and approved GROUP evidence below. Never invent stock, price, ETA, policy, payment status, discount, or promises. If evidence is missing, say verification is needed.\nCustomer: ${cv.customer_name||'Customer'}\nMessage: ${cv.customer_text||''}\nDraft: ${draft}\nApproved group evidence:\n${evidenceText||'(none)'}`,max_output_tokens:260})});
      const d:any=await r.json().catch(()=>({}));if(r.ok){reply=outputText(d)||draft;provider='openai'}
    }
    await pool.query(`insert into agent_runtime_logs(conversation_id,operator_id,query,response_text,knowledge_item_ids,knowledge_versions,confidence,provider) values($1,$2,$3,$4,$5,$6,$7,$8)`,[cv.id,u.id,query,reply,evidence.map((x:any)=>x.item_id),JSON.stringify(evidence.map((x:any)=>({item_id:x.item_id,version:x.version_no,score:x.score,scope:'group'}))),evidence.length>=2?'high':evidence.length===1?'medium':'low',provider]);
    res.json({reply,provider,group:{id:cv.group_id,name:cv.group_name,group_code:cv.group_code},confidence:evidence.length>=2?'high':evidence.length===1?'medium':'low',evidence:evidence.map((x:any)=>({title:x.title,version:x.version_no,authority:x.authority_level,score:Number(x.score.toFixed(3)),source_ref:x.source_ref,scope:'group'}))});
  });
}
