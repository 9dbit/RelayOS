import {pool,normalizePhone} from './db.js';

type MetaPhone={id:string;display_phone_number?:string;verified_name?:string;quality_rating?:string};

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
    const url=`https://graph.facebook.com/${encodeURIComponent(version)}/${encodeURIComponent(wabaId)}/phone_numbers?fields=${encodeURIComponent('id,display_phone_number,verified_name,quality_rating')}&limit=100`;
    const r=await fetch(url,{headers:{authorization:`Bearer ${token}`}});
    const data:any=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(`Meta HTTP ${r.status}: ${data?.error?.message||'unknown error'}`);
    const phones:MetaPhone[]=Array.isArray(data?.data)?data.data:[];
    const match=phones.find(p=>normalizePhone(p.display_phone_number||'')===primaryPhone);
    if(!match)throw new Error(`primary phone not present in configured WABA; discovered=${phones.length}`);
    const db=(await pool.query('select phone,phone_number_id,waba_id,status from whatsapp_accounts where phone=$1 limit 1',[primaryPhone])).rows[0];
    const idMatches=!configuredPhoneNumberId||String(match.id)===configuredPhoneNumberId;
    const dbMatches=Boolean(db&&String(db.phone_number_id||'')===String(match.id)&&String(db.waba_id||'')===wabaId);
    const suffix=primaryPhone.slice(-4);
    if(!idMatches)console.warn(`[meta-smoke] DEGRADED primary=••••${suffix} configured_phone_number_id_mismatch`);
    else if(!dbMatches)console.warn(`[meta-smoke] DEGRADED primary=••••${suffix} meta_discovery=pass db_mapping=stale status=${db?.status||'missing'}`);
    else console.log(`[meta-smoke] PASS primary=••••${suffix} meta_discovery=pass db_mapping=pass status=${db.status}`);
  }catch(e:any){
    console.warn('[meta-smoke] DEGRADED',String(e?.message||e));
  }finally{
    await pool.end().catch(()=>{});
  }
}

await run();
