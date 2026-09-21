import {pool,normalizePhone} from './db.js';

type MetaPhone={id:string;display_phone_number?:string;verified_name?:string;quality_rating?:string};

function metaErrorSummary(status:number,data:any){
  const e=data?.error||{};
  const parts=[
    `http=${status}`,
    e.type?`type=${String(e.type)}`:'',
    e.code!=null?`code=${String(e.code)}`:'',
    e.error_subcode!=null?`subcode=${String(e.error_subcode)}`:'',
    e.message?`message=${String(e.message)}`:'',
    e.fbtrace_id?`trace=${String(e.fbtrace_id)}`:''
  ].filter(Boolean);
  return parts.join(' ');
}

async function graphGet(token:string,url:string){
  const r=await fetch(url,{headers:{authorization:`Bearer ${token}`}});
  const data:any=await r.json().catch(()=>({}));
  return{ok:r.ok,status:r.status,data,summary:r.ok?'pass':metaErrorSummary(r.status,data)};
}

async function run(){
  const token=String(process.env.META_ACCESS_TOKEN||'').trim();
  const version=String(process.env.META_GRAPH_VERSION||'').trim();
  const wabaId=String(process.env.RELAYOS_PRIMARY_WABA_ID||'').trim();
  const primaryPhone=normalizePhone(process.env.RELAYOS_PRIMARY_PHONE||'');
  const configuredPhoneNumberId=String(process.env.RELAYOS_PRIMARY_PHONE_NUMBER_ID||'').trim();
  if(!token||!version||!wabaId||!primaryPhone){
    console.warn('[meta-smoke] DEGRADED required Meta/primary configuration missing');
    return;
  }
  try{
    const suffix=primaryPhone.slice(-4);
    const wabaUrl=`https://graph.facebook.com/${encodeURIComponent(version)}/${encodeURIComponent(wabaId)}/phone_numbers?fields=${encodeURIComponent('id,display_phone_number,verified_name,quality_rating')}&limit=100`;
    const waba=await graphGet(token,wabaUrl);

    let direct:any={ok:false,summary:'skipped: RELAYOS_PRIMARY_PHONE_NUMBER_ID missing'};
    if(configuredPhoneNumberId){
      const phoneUrl=`https://graph.facebook.com/${encodeURIComponent(version)}/${encodeURIComponent(configuredPhoneNumberId)}?fields=${encodeURIComponent('id,display_phone_number,verified_name,quality_rating,code_verification_status,platform_type')}`;
      direct=await graphGet(token,phoneUrl);
    }

    if(!waba.ok)console.warn(`[meta-smoke] WABA_DISCOVERY_BLOCKED primary=••••${suffix} ${waba.summary}`);
    else console.log(`[meta-smoke] WABA_DISCOVERY_PASS primary=••••${suffix} discovered=${Array.isArray(waba.data?.data)?waba.data.data.length:0}`);

    if(!direct.ok)console.warn(`[meta-smoke] PHONE_IDENTITY_BLOCKED primary=••••${suffix} ${direct.summary}`);
    else console.log(`[meta-smoke] PHONE_IDENTITY_PASS primary=••••${suffix} id_match=${String(direct.data?.id||'')===configuredPhoneNumberId}`);

    const phones:MetaPhone[]=waba.ok&&Array.isArray(waba.data?.data)?waba.data.data:[];
    const discovered=phones.find(p=>normalizePhone(p.display_phone_number||'')===primaryPhone);
    const directPhone=direct.ok?normalizePhone(direct.data?.display_phone_number||''):'';
    const identityId=String(discovered?.id||direct.data?.id||configuredPhoneNumberId||'');
    const metaPhoneMatches=Boolean((discovered&&normalizePhone(discovered.display_phone_number||'')===primaryPhone)||(direct.ok&&directPhone===primaryPhone));
    const db=(await pool.query('select phone,phone_number_id,waba_id,status from whatsapp_accounts where phone=$1 limit 1',[primaryPhone])).rows[0];
    const dbMatches=Boolean(db&&identityId&&String(db.phone_number_id||'')===identityId&&String(db.waba_id||'')===wabaId);

    if(metaPhoneMatches&&dbMatches)console.log(`[meta-smoke] PASS primary=••••${suffix} meta_identity=pass db_mapping=pass status=${db.status} discovery=${waba.ok?'pass':'blocked'}`);
    else if(metaPhoneMatches)console.warn(`[meta-smoke] DEGRADED primary=••••${suffix} meta_identity=pass db_mapping=stale status=${db?.status||'missing'} discovery=${waba.ok?'pass':'blocked'}`);
    else console.warn(`[meta-smoke] DEGRADED primary=••••${suffix} meta_identity=blocked db_status=${db?.status||'missing'} discovery=${waba.ok?'pass':'blocked'}`);
  }catch(e:any){
    console.warn('[meta-smoke] DEGRADED',String(e?.message||e));
  }finally{
    await pool.end().catch(()=>{});
  }
}

await run();
