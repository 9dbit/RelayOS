import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { pool,migrate,normalizePhone,chooseStickySender } from './db.js';
import { classifyIntent,rewriteForCustomer } from './ai.js';

const app=express();
const port=Number(process.env.PORT||3000);
const __dirname=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(__dirname,'..');
app.use(express.json({limit:'10mb'}));

const ImportRow=z.object({phone:z.any(),name:z.string().optional(),source:z.string().optional(),tags:z.any().optional(),opt_in:z.any().optional(),opt_in_source:z.string().optional()});
const Account=z.object({name:z.string().min(2),phone:z.string(),phone_number_id:z.string().optional(),waba_id:z.string().optional(),department:z.string().optional(),mode:z.enum(['manual','assist','hybrid','auto']).default('hybrid')});

function dbReady(res:express.Response){if(!process.env.DATABASE_URL){res.status(503).json({error:'database_not_configured'});return false}return true}
function bool(v:any){return v===true||['true','yes','1','y'].includes(String(v).toLowerCase())}
function metaReady(){return Boolean(process.env.META_ACCESS_TOKEN&&process.env.META_GRAPH_VERSION)}

app.get('/api/health',async(_req,res)=>{
  let database='not_configured';
  if(process.env.DATABASE_URL){try{await pool.query('select 1');database='connected'}catch{database='error'}}
  res.status(database==='error'?503:200).json({ok:database!=='error',service:'RelayOS',database,meta:metaReady()?'configured':'not_configured',timestamp:new Date().toISOString()});
});

app.get('/api/v1/dashboard',async(_req,res)=>{
  if(!dbReady(res))return;
  const [customers,numbers,conversations,messages]=await Promise.all([
    pool.query('select count(*)::int total,count(*) filter(where opt_in)::int opted_in from customers'),
    pool.query("select count(*)::int total,count(*) filter(where health_score>=80 and status in('active','healthy','verifying','verified'))::int healthy from whatsapp_accounts"),
    pool.query("select count(*)::int open from conversations where status='open'"),
    pool.query("select count(*)::int total from messages where created_at>now()-interval '24 hours'")
  ]);
  res.json({customers:customers.rows[0],numbers:numbers.rows[0],conversations:conversations.rows[0],messages24h:messages.rows[0].total});
});

app.get('/api/v1/numbers',async(_req,res)=>{
  if(!dbReady(res))return;
  const q=await pool.query(`select wa.id,wa.name,wa.phone,wa.phone_number_id,wa.waba_id,wa.department,wa.mode,wa.health_score as health,wa.status,wa.last_webhook_at,wa.last_outbound_at,wa.last_error,count(c.id)::int as chats from whatsapp_accounts wa left join conversations c on c.whatsapp_account_id=wa.id and c.status='open' group by wa.id order by wa.created_at`);
  res.json({items:q.rows});
});

app.post('/api/v1/numbers',async(req,res)=>{
  if(!dbReady(res))return;
  const parsed=Account.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'invalid_account',details:parsed.error.flatten()});
  const p=normalizePhone(parsed.data.phone);if(!p)return res.status(400).json({error:'invalid_phone'});
  const d=parsed.data;
  const q=await pool.query(`insert into whatsapp_accounts(name,phone,phone_number_id,waba_id,department,mode,status) values($1,$2,$3,$4,$5,$6,'setup') on conflict(phone) do update set name=excluded.name,phone_number_id=coalesce(excluded.phone_number_id,whatsapp_accounts.phone_number_id),waba_id=coalesce(excluded.waba_id,whatsapp_accounts.waba_id),department=excluded.department,mode=excluded.mode,updated_at=now() returning *`,[d.name,p,d.phone_number_id||null,d.waba_id||null,d.department||null,d.mode]);
  res.status(201).json(q.rows[0]);
});

async function getMetaIdentity(phoneNumberId:string){
  if(!metaReady())throw new Error('meta_not_configured');
  const fields='display_phone_number,verified_name,quality_rating,platform_type';
  const r=await fetch(`https://graph.facebook.com/${process.env.META_GRAPH_VERSION}/${encodeURIComponent(phoneNumberId)}?fields=${encodeURIComponent(fields)}`,{headers:{authorization:`Bearer ${process.env.META_ACCESS_TOKEN}`}});
  const data:any=await r.json();
  if(!r.ok)throw new Error(data?.error?.message||`meta_http_${r.status}`);
  return data;
}

app.post('/api/v1/numbers/:id/verify',async(req,res)=>{
  if(!dbReady(res))return;
  const q=await pool.query('select * from whatsapp_accounts where id=$1',[req.params.id]);
  const account=q.rows[0];if(!account)return res.status(404).json({error:'account_not_found'});
  if(!account.phone_number_id)return res.status(400).json({error:'phone_number_id_required'});
  if(!metaReady())return res.status(503).json({error:'meta_not_configured'});
  try{
    const identity=await getMetaIdentity(account.phone_number_id);
    await pool.query("update whatsapp_accounts set status='verified',health_score=greatest(health_score,90),last_error=null,updated_at=now() where id=$1",[account.id]);
    res.json({ok:true,...identity});
  }catch(e:any){
    await pool.query("update whatsapp_accounts set status='verifying',health_score=least(health_score,70),last_error=$2,updated_at=now() where id=$1",[account.id,e.message]);
    res.status(400).json({ok:false,error:e.message||'meta_verification_failed'});
  }
});

app.post('/api/v1/numbers/:id/test',async(req,res)=>{
  if(!dbReady(res))return;
  const q=await pool.query('select * from whatsapp_accounts where id=$1',[req.params.id]);
  const account=q.rows[0];if(!account)return res.status(404).json({error:'account_not_found'});
  const checks={database:true,phone:Boolean(account.phone),phone_number_id:Boolean(account.phone_number_id),waba_id:Boolean(account.waba_id),meta_credentials:metaReady(),meta_identity:false};
  if(checks.phone_number_id&&checks.meta_credentials){try{await getMetaIdentity(account.phone_number_id);checks.meta_identity=true}catch{checks.meta_identity=false}}
  const ok=Object.values(checks).every(Boolean);
  await pool.query('update whatsapp_accounts set health_score=$1,last_error=$2,updated_at=now() where id=$3',[ok?95:70,ok?null:'channel_checks_failed',account.id]);
  res.status(ok?200:400).json({ok,checks,error:ok?undefined:'channel_checks_failed'});
});

app.post('/api/v1/numbers/:id/activate',async(req,res)=>{
  if(!dbReady(res))return;
  const q=await pool.query('select * from whatsapp_accounts where id=$1',[req.params.id]);
  const account=q.rows[0];if(!account)return res.status(404).json({error:'account_not_found'});
  if(!account.phone_number_id||!account.waba_id)return res.status(400).json({error:'meta_identity_incomplete'});
  if(!metaReady())return res.status(503).json({error:'meta_not_configured'});
  try{await getMetaIdentity(account.phone_number_id)}catch(e:any){return res.status(400).json({error:e.message||'meta_verification_failed'})}
  const updated=await pool.query("update whatsapp_accounts set status='active',health_score=100,last_error=null,updated_at=now() where id=$1 returning *",[account.id]);
  res.json({ok:true,account:updated.rows[0]});
});

app.get('/api/v1/customers',async(req,res)=>{
  if(!dbReady(res))return;
  const limit=Math.min(Number(req.query.limit)||100,500);
  const q=await pool.query(`select c.id,c.phone,c.name,c.source,c.tags,c.opt_in,c.opt_in_source,c.do_not_contact,c.created_at,wa.name assigned_sender from customers c left join whatsapp_accounts wa on wa.id=c.assigned_whatsapp_id order by c.updated_at desc limit $1`,[limit]);
  res.json({items:q.rows});
});

app.post('/api/v1/customers/import',async(req,res)=>{
  if(!dbReady(res))return;
  const rows=Array.isArray(req.body?.rows)?req.body.rows:[];if(rows.length>10000)return res.status(413).json({error:'max_10000_rows_per_import'});
  let valid=0,invalid=0,inserted=0,updated=0;const seen=new Set<string>();
  const client=await pool.connect();
  try{
    await client.query('begin');
    for(const raw of rows){
      const parsed=ImportRow.safeParse(raw);if(!parsed.success){invalid++;continue}
      const phone=normalizePhone(String(parsed.data.phone));if(!phone){invalid++;continue}
      valid++;if(seen.has(phone))continue;seen.add(phone);
      const tags=Array.isArray(parsed.data.tags)?parsed.data.tags:String(parsed.data.tags||'').split(',').map(x=>x.trim()).filter(Boolean);
      const existing=await client.query('select id from customers where phone=$1',[phone]);
      await client.query(`insert into customers(phone,name,source,tags,opt_in,opt_in_source,opt_in_at) values($1,$2,$3,$4,$5,$6,case when $5 then now() else null end) on conflict(phone) do update set name=coalesce(excluded.name,customers.name),source=coalesce(excluded.source,customers.source),tags=case when cardinality(excluded.tags)>0 then excluded.tags else customers.tags end,opt_in=customers.opt_in or excluded.opt_in,opt_in_source=coalesce(excluded.opt_in_source,customers.opt_in_source),opt_in_at=case when customers.opt_in_at is null and excluded.opt_in then now() else customers.opt_in_at end,updated_at=now()`,[phone,parsed.data.name||null,parsed.data.source||null,tags,bool(parsed.data.opt_in),parsed.data.opt_in_source||null]);
      existing.rowCount?updated++:inserted++;
    }
    await client.query('commit');
    res.json({total:rows.length,valid,invalid,duplicates_in_file:valid-seen.size,inserted,updated});
  }catch(e){await client.query('rollback');throw e}finally{client.release()}
});

app.get('/api/v1/conversations',async(req,res)=>{
  if(!dbReady(res))return;
  const limit=Math.min(Number(req.query.limit)||100,300);
  const q=await pool.query(`select cv.id,cv.status,cv.intent,cv.ai_mode,cv.assigned_operator,cv.last_message_at,c.id customer_id,c.name customer_name,c.phone customer_phone,c.source,c.tags,c.opt_in,c.do_not_contact,wa.id whatsapp_account_id,wa.name channel_name,wa.phone channel_phone,wa.status channel_status,(select coalesce(m.rewritten_text,m.original_text) from messages m where m.conversation_id=cv.id order by m.created_at desc limit 1) last_message from conversations cv join customers c on c.id=cv.customer_id join whatsapp_accounts wa on wa.id=cv.whatsapp_account_id order by cv.last_message_at desc limit $1`,[limit]);
  res.json({items:q.rows});
});

app.get('/api/v1/conversations/:id/messages',async(req,res)=>{
  if(!dbReady(res))return;
  const q=await pool.query('select * from messages where conversation_id=$1 order by created_at',[req.params.id]);res.json({items:q.rows});
});

async function getConversation(id:string){
  const q=await pool.query(`select cv.*,c.name customer_name,c.phone customer_phone,wa.phone_number_id,wa.name channel_name,wa.status channel_status from conversations cv join customers c on c.id=cv.customer_id join whatsapp_accounts wa on wa.id=cv.whatsapp_account_id where cv.id=$1`,[id]);
  return q.rows[0];
}

app.post('/api/v1/conversations/:id/operator-preview',async(req,res)=>{
  if(!dbReady(res))return;
  const text=String(req.body?.text||'').trim();if(!text)return res.status(400).json({error:'text_required'});
  const cv=await getConversation(req.params.id);if(!cv)return res.status(404).json({error:'conversation_not_found'});
  const last=await pool.query("select original_text from messages where conversation_id=$1 and direction='inbound' order by created_at desc limit 1",[cv.id]);
  try{
    const rewritten=await rewriteForCustomer({customerName:cv.customer_name,intent:cv.intent,operatorText:text,customerText:last.rows[0]?.original_text});
    res.json({original_text:text,rewritten_text:rewritten||text,ai_available:Boolean(process.env.OPENAI_API_KEY)});
  }catch(e:any){res.status(502).json({error:e.message||'ai_preview_failed'})}
});

async function sendWhatsApp(phoneNumberId:string,to:string,text:string){
  if(!metaReady())return {queued:false,reason:'meta_not_configured'};
  const url=`https://graph.facebook.com/${process.env.META_GRAPH_VERSION}/${phoneNumberId}/messages`;
  const r=await fetch(url,{method:'POST',headers:{authorization:`Bearer ${process.env.META_ACCESS_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to,type:'text',text:{body:text,preview_url:false}})});
  const data:any=await r.json();if(!r.ok)throw new Error(data?.error?.message||`meta_send_${r.status}`);return {queued:true,data};
}

app.post('/api/v1/conversations/:id/operator-send',async(req,res)=>{
  if(!dbReady(res))return;
  const original=String(req.body?.original_text||'').trim();const rewritten=String(req.body?.rewritten_text||original).trim();
  if(!rewritten)return res.status(400).json({error:'text_required'});
  const cv=await getConversation(req.params.id);if(!cv)return res.status(404).json({error:'conversation_not_found'});
  const m=await pool.query(`insert into messages(conversation_id,direction,sender_type,original_text,rewritten_text,delivery_status) values($1,'outbound','operator',$2,$3,'queued') returning *`,[cv.id,original||rewritten,rewritten]);
  let delivery:any={queued:false,reason:'meta_not_configured'};
  try{
    if(cv.phone_number_id)delivery=await sendWhatsApp(cv.phone_number_id,cv.customer_phone,rewritten);
    await pool.query("update messages set delivery_status=$1,metadata=$2 where id=$3",[delivery.queued?'sent':'draft',JSON.stringify(delivery),m.rows[0].id]);
    await pool.query('update conversations set last_message_at=now() where id=$1',[cv.id]);
    await pool.query("update whatsapp_accounts set last_outbound_at=case when $1 then now() else last_outbound_at end,last_error=$2,health_score=case when $1 then greatest(health_score,90) else health_score end where phone_number_id=$3",[delivery.queued,delivery.queued?null:delivery.reason,cv.phone_number_id]);
    res.json({message:{...m.rows[0],delivery_status:delivery.queued?'sent':'draft'},delivery});
  }catch(e:any){
    await pool.query("update messages set delivery_status='failed',metadata=$1 where id=$2",[JSON.stringify({error:e.message}),m.rows[0].id]);
    await pool.query("update whatsapp_accounts set last_error=$1,health_score=greatest(0,health_score-10) where phone_number_id=$2",[e.message,cv.phone_number_id]);
    res.status(502).json({error:e.message||'send_failed'});
  }
});

app.post('/api/v1/conversations/:id/operator-reply',async(req,res)=>{
  if(!dbReady(res))return;
  const text=String(req.body?.text||'').trim();if(!text)return res.status(400).json({error:'text_required'});
  const cv=await getConversation(req.params.id);if(!cv)return res.status(404).json({error:'conversation_not_found'});
  const last=await pool.query("select original_text from messages where conversation_id=$1 and direction='inbound' order by created_at desc limit 1",[cv.id]);
  const rewritten=await rewriteForCustomer({customerName:cv.customer_name,intent:cv.intent,operatorText:text,customerText:last.rows[0]?.original_text});
  req.body={original_text:text,rewritten_text:rewritten||text};
  const m=await pool.query(`insert into messages(conversation_id,direction,sender_type,original_text,rewritten_text,delivery_status) values($1,'outbound','operator',$2,$3,'queued') returning *`,[cv.id,text,rewritten||text]);
  let delivery:any={queued:false,reason:'meta_not_configured'};
  if(cv.phone_number_id)delivery=await sendWhatsApp(cv.phone_number_id,cv.customer_phone,rewritten||text);
  await pool.query("update messages set delivery_status=$1,metadata=$2 where id=$3",[delivery.queued?'sent':'draft',JSON.stringify(delivery),m.rows[0].id]);
  await pool.query('update conversations set last_message_at=now() where id=$1',[cv.id]);
  res.json({message:{...m.rows[0],rewritten_text:rewritten},delivery});
});

app.get('/api/webhooks/meta',async(req,res)=>{
  const mode=req.query['hub.mode'],token=req.query['hub.verify_token'],challenge=req.query['hub.challenge'];
  if(mode==='subscribe'&&token===process.env.META_VERIFY_TOKEN)return res.status(200).send(String(challenge||''));
  res.sendStatus(403);
});

app.post('/api/webhooks/meta',async(req,res)=>{
  res.sendStatus(200);
  if(!process.env.DATABASE_URL)return;
  try{
    const changes=req.body?.entry?.flatMap((e:any)=>e.changes||[])||[];
    for(const change of changes){
      const value=change.value||{};const phoneNumberId=value.metadata?.phone_number_id;
      if(phoneNumberId)await pool.query("update whatsapp_accounts set last_webhook_at=now(),last_error=null,health_score=greatest(health_score,90),updated_at=now() where phone_number_id=$1",[phoneNumberId]);
      for(const msg of value.messages||[]){
        const eventKey=`meta:${msg.id}`;
        const inserted=await pool.query('insert into inbound_events(provider,event_key,payload) values($1,$2,$3) on conflict(event_key) do nothing returning id',['meta',eventKey,JSON.stringify(msg)]);
        if(!inserted.rowCount)continue;
        const phone=normalizePhone(msg.from);const text=msg.text?.body||msg.button?.text||msg.interactive?.button_reply?.title||'';
        if(!phone)continue;
        const cq=await pool.query(`insert into customers(phone,source) values($1,'whatsapp') on conflict(phone) do update set updated_at=now() returning id,name,assigned_whatsapp_id`,[phone]);
        const customer=cq.rows[0];let senderId=customer.assigned_whatsapp_id;
        if(phoneNumberId){const wa=await pool.query('select id from whatsapp_accounts where phone_number_id=$1',[phoneNumberId]);if(wa.rows[0]){senderId=wa.rows[0].id;if(!customer.assigned_whatsapp_id)await pool.query('update customers set assigned_whatsapp_id=$1 where id=$2',[senderId,customer.id]);}}
        if(!senderId)senderId=await chooseStickySender(customer.id);
        const open=await pool.query("select id from conversations where customer_id=$1 and whatsapp_account_id=$2 and status='open' order by created_at desc limit 1",[customer.id,senderId]);
        let conversationId=open.rows[0]?.id;const intent=await classifyIntent(text);
        if(!conversationId){const n=await pool.query("insert into conversations(customer_id,whatsapp_account_id,intent) values($1,$2,$3) returning id",[customer.id,senderId,intent]);conversationId=n.rows[0].id}else await pool.query('update conversations set intent=$1,last_message_at=now() where id=$2',[intent,conversationId]);
        await pool.query(`insert into messages(conversation_id,direction,sender_type,external_message_id,original_text,delivery_status,metadata) values($1,'inbound','customer',$2,$3,'received',$4) on conflict(external_message_id) do nothing`,[conversationId,msg.id,text,JSON.stringify({type:msg.type,timestamp:msg.timestamp})]);
        await pool.query('update inbound_events set processed_at=now() where event_key=$1',[eventKey]);
      }
    }
  }catch(e){console.error('Meta webhook processing failed',e)}
});

app.use(express.static(path.join(root,'dist')));
app.get('*',(_req,res)=>res.sendFile(path.join(root,'dist','index.html')));

migrate().then(()=>app.listen(port,'0.0.0.0',()=>console.log(`RelayOS listening on ${port}`))).catch(e=>{console.error('Startup migration failed',e);process.exit(1)});
