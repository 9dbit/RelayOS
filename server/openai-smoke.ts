const key=process.env.OPENAI_API_KEY;
const model=process.env.OPENAI_MODEL||'gpt-5.6-luna';
const embeddingModel=process.env.OPENAI_EMBEDDING_MODEL||'text-embedding-3-small';

function responseText(d:any){
  const direct=String(d?.output_text||'').trim();
  if(direct)return direct;
  return String((d?.output||[]).flatMap((x:any)=>x?.content||[]).map((x:any)=>x?.text||x?.output_text||'').filter(Boolean).join('\n')).trim();
}

export async function probeOpenAI(){
  if(!key)return{ok:false,responses:false,embeddings:false,error:'OPENAI_API_KEY missing',model,embedding_model:embeddingModel};
  const headers={'content-type':'application/json','authorization':`Bearer ${key}`};
  const result:any={ok:false,responses:false,embeddings:false,model,embedding_model:embeddingModel};
  try{
    const started=Date.now();
    const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers,body:JSON.stringify({model,input:'Reply with exactly: RELAYOS_OK',max_output_tokens:64})});
    const requestId=r.headers.get('x-request-id')||'n/a';
    const d:any=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(`Responses HTTP ${r.status}: ${d?.error?.message||'unknown error'}`);
    const text=responseText(d);
    result.responses=true;
    result.response_text=text||null;
    result.response_request_id=requestId;
    result.response_latency_ms=Date.now()-started;
  }catch(e:any){result.responses_error=e?.message||String(e)}
  try{
    const started=Date.now();
    const r=await fetch('https://api.openai.com/v1/embeddings',{method:'POST',headers,body:JSON.stringify({model:embeddingModel,input:'RelayOS health check'})});
    const requestId=r.headers.get('x-request-id')||'n/a';
    const d:any=await r.json().catch(()=>({}));
    const vector=d?.data?.[0]?.embedding;
    if(!r.ok)throw new Error(`Embeddings HTTP ${r.status}: ${d?.error?.message||'unknown error'}`);
    if(!Array.isArray(vector)||!vector.length)throw new Error('Embeddings returned no vector');
    result.embeddings=true;
    result.embedding_dimensions=vector.length;
    result.embedding_request_id=requestId;
    result.embedding_latency_ms=Date.now()-started;
  }catch(e:any){result.embeddings_error=e?.message||String(e)}
  result.ok=Boolean(result.responses&&result.embeddings);
  return result;
}

if(import.meta.url===`file://${process.argv[1]}`){
  const result=await probeOpenAI();
  if(result.ok)console.log(`[openai-smoke] PASS model=${result.model} response_ms=${result.response_latency_ms} embedding_ms=${result.embedding_latency_ms}`);
  else console.warn('[openai-smoke] DEGRADED',JSON.stringify(result));
}
