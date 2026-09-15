type RelayContext={customerName?:string;intent?:string;operatorText?:string;customerText?:string;brandTone?:string};

export async function rewriteForCustomer(ctx:RelayContext){
  if(!ctx.operatorText) return null;
  const key=process.env.OPENAI_API_KEY;
  if(!key) return ctx.operatorText;
  const body={
    model:process.env.OPENAI_MODEL||'gpt-5.6-luna',
    input:[{
      role:'user',
      content:[{type:'input_text',text:`Rewrite this operator reply into a concise, professional WhatsApp response for the customer. Preserve facts exactly, do not invent stock, price, ETA, policy, or promises. Brand tone: ${ctx.brandTone||'friendly, modern, professional'}. Customer: ${ctx.customerName||'Customer'}. Intent: ${ctx.intent||'unknown'}. Customer message: ${ctx.customerText||''}. Operator reply: ${ctx.operatorText}`}]
    }],
    max_output_tokens:220
  };
  const r=await fetch('https://api.openai.com/v1/responses',{
    method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${key}`},body:JSON.stringify(body)
  });
  if(!r.ok) throw new Error(`AI provider error ${r.status}`);
  const data:any=await r.json();
  const text=data.output_text || data.output?.flatMap((o:any)=>o.content||[]).find((c:any)=>c.type==='output_text')?.text;
  return text?.trim()||ctx.operatorText;
}

export async function classifyIntent(text:string){
  const t=text.toLowerCase();
  if(/stok|stock|ready|tersedia/.test(t)) return 'product_availability';
  if(/harga|price|berapa|diskon/.test(t)) return 'pricing';
  if(/order|pesanan|kirim|shipping|estimasi/.test(t)) return 'order_status';
  if(/refund|retur|komplain|complaint/.test(t)) return 'support';
  return 'general';
}
