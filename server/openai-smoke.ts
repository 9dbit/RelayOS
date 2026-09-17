const key=process.env.OPENAI_API_KEY;
if(!key) throw new Error('OPENAI_API_KEY is required in production');

const model=process.env.OPENAI_MODEL||'gpt-5.6-luna';
const embeddingModel=process.env.OPENAI_EMBEDDING_MODEL||'text-embedding-3-small';
const headers={'content-type':'application/json','authorization':`Bearer ${key}`};

async function checkResponses(){
  const started=Date.now();
  const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers,body:JSON.stringify({model,input:'Reply with exactly: RELAYOS_OK',max_output_tokens:16})});
  const requestId=r.headers.get('x-request-id')||'n/a';
  const d:any=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(`OpenAI Responses smoke test failed: HTTP ${r.status} ${d?.error?.message||''} request_id=${requestId}`);
  const text=String(d.output_text||'').trim();
  if(!text) throw new Error(`OpenAI Responses smoke test returned empty output request_id=${requestId}`);
  console.log(`[openai-smoke] responses=ready model=${model} latency_ms=${Date.now()-started} request_id=${requestId}`);
}

async function checkEmbeddings(){
  const started=Date.now();
  const r=await fetch('https://api.openai.com/v1/embeddings',{method:'POST',headers,body:JSON.stringify({model:embeddingModel,input:'RelayOS health check'})});
  const requestId=r.headers.get('x-request-id')||'n/a';
  const d:any=await r.json().catch(()=>({}));
  const vector=d?.data?.[0]?.embedding;
  if(!r.ok) throw new Error(`OpenAI Embeddings smoke test failed: HTTP ${r.status} ${d?.error?.message||''} request_id=${requestId}`);
  if(!Array.isArray(vector)||!vector.length) throw new Error(`OpenAI Embeddings smoke test returned no vector request_id=${requestId}`);
  console.log(`[openai-smoke] embeddings=ready model=${embeddingModel} dimensions=${vector.length} latency_ms=${Date.now()-started} request_id=${requestId}`);
}

await checkResponses();
await checkEmbeddings();
console.log('[openai-smoke] RelayOS OpenAI production gate PASSED');
