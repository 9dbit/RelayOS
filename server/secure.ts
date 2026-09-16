import express from 'express';
import crypto from 'crypto';
import {spawn} from 'child_process';
import {pool} from './db.js';

const app=express();
app.set('trust proxy',1);
const publicPort=Number(process.env.PORT||3000);
const internalPort=Number(process.env.RELAYOS_INTERNAL_PORT||3001);
const secret=process.env.RELAYOS_JWT_SECRET||'';
const bootstrapToken=process.env.RELAYOS_BOOTSTRAP_TOKEN||'';
const cookieName='relayos_session';
const sessionHours=12;

if(!secret||secret.length<32) throw new Error('RELAYOS_JWT_SECRET must be configured with at least 32 characters');

app.use(express.json({limit:'10mb'}));

function b64(v:Buffer|string){return Buffer.from(v).toString('base64url')}
function signJwt(payload:any){
  const header=b64(JSON.stringify({alg:'HS256',typ:'JWT'}));
  const body=b64(JSON.stringify(payload));
  const sig=crypto.createHmac('sha256',secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}
function verifyJwt(token:string){
  try{
    const [h,b,s]=token.split('.');if(!h||!b||!s)return null;
    const expected=crypto.createHmac('sha256',secret).update(`${h}.${b}`).digest('base64url');
    if(!crypto.timingSafeEqual(Buffer.from(s),Buffer.from(expected)))return null;
    const p=JSON.parse(Buffer.from(b,'base64url').toString('utf8'));
    if(!p.exp||Date.now()/1000>=p.exp)return null;
    return p;
  }catch{return null}
}
function cookies(req:express.Request){return Object.fromEntries(String(req.headers.cookie||'').split(';').map(v=>v.trim()).filter(Boolean).map(v=>{const i=v.indexOf('=');return[decodeURIComponent(v.slice(0,i)),decodeURIComponent(v.slice(i+1))]}))}
async function scryptHash(password:string,salt=crypto.randomBytes(16).toString('hex')){return new Promise<string>((resolve,reject)=>crypto.scrypt(password,salt,64,(e,k)=>e?reject(e):resolve(`${salt}:${Buffer.from(k).toString('hex')}`)))}
async function verifyPassword(password:string,stored:string){try{const[salt]=stored.split(':');const fresh=await scryptHash(password,salt);return crypto.timingSafeEqual(Buffer.from(fresh),Buffer.from(stored))}catch{return false}}
function tokenHash(token:string){return crypto.createHash('sha256').update(token).digest('hex')}
function setCookie(res:express.Response,token:string){res.setHeader('Set-Cookie',`${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${sessionHours*3600}`)}
function clearCookie(res:express.Response){res.setHeader('Set-Cookie',`${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`)}

async function migrateAuth(){
  await pool.query(`
    alter table operators add column if not exists password_hash text;
    alter table operators add column if not exists auth_version int not null default 1;
    alter table operators add column if not exists last_login_at timestamptz;
    alter table operators add column if not exists invited_at timestamptz;
    alter table operators add column if not exists accepted_at timestamptz;
    create unique index if not exists uq_operator_email_ci on operators(lower(email)) where email is not null;
    create table if not exists auth_sessions(
      id uuid primary key default gen_random_uuid(),
      operator_id uuid not null references operators(id) on delete cascade,
      jti text not null unique,
      expires_at timestamptz not null,
      revoked_at timestamptz,
      ip_hash text,
      user_agent text,
      created_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now()
    );
    create table if not exists operator_invites(
      id uuid primary key default gen_random_uuid(),
      operator_id uuid not null references operators(id) on delete cascade,
      token_hash text not null unique,
      invited_by uuid references operators(id),
      expires_at timestamptz not null,
      accepted_at timestamptz,
      created_at timestamptz not null default now()
    );
    create index if not exists idx_auth_sessions_operator on auth_sessions(operator_id,expires_at);
    create index if not exists idx_operator_invites_operator on operator_invites(operator_id,expires_at);
  `);
}

async function currentUser(req:express.Request){
  const token=cookies(req)[cookieName];if(!token)return null;
  const jwt=verifyJwt(token);if(!jwt?.sub||!jwt?.jti)return null;
  const q=await pool.query(`select o.id,o.name,o.email,o.role,o.department,o.presence,o.active,o.auth_version,s.id session_id,s.expires_at from auth_sessions s join operators o on o.id=s.operator_id where s.jti=$1 and s.operator_id=$2 and s.revoked_at is null and s.expires_at>now() and o.active=true`,[jwt.jti,jwt.sub]);
  const u=q.rows[0];if(!u||Number(jwt.ver)!==Number(u.auth_version))return null;
  await pool.query('update auth_sessions set last_seen_at=now() where id=$1',[u.session_id]);
  return u;
}
async function requireUser(req:express.Request,res:express.Response){const u=await currentUser(req);if(!u){if(req.path.startsWith('/api/'))res.status(401).json({error:'authentication_required'});else res.redirect('/login.html');return null}return u}
function roleAtLeast(role:string,allowed:string[]){return allowed.includes(role)}
function externalOrigin(req:express.Request){
  const proto=String(req.headers['x-forwarded-proto']||req.protocol||'https').split(',')[0].trim();
  const host=String(req.headers['x-forwarded-host']||req.get('host')||'').split(',')[0].trim();
  return `${proto}://${host}`;
}
function checkOrigin(req:express.Request,res:express.Response){
  if(['GET','HEAD','OPTIONS'].includes(req.method))return true;
  const origin=String(req.headers.origin||'').trim();
  if(!origin)return true;
  let incoming:string;try{incoming=new URL(origin).origin}catch{return res.status(403).json({error:'origin_rejected'}),false}
  const expected=externalOrigin(req);
  if(incoming!==expected){res.status(403).json({error:'origin_rejected'});return false}
  return true;
}

app.get('/api/auth/me',async(req,res)=>{const u=await currentUser(req);if(!u)return res.status(401).json({error:'authentication_required'});res.json({user:u})});
app.post('/api/auth/login',async(req,res)=>{
  if(!checkOrigin(req,res))return;
  const email=String(req.body?.email||'').trim().toLowerCase();const password=String(req.body?.password||'');
  const q=await pool.query('select * from operators where lower(email)=$1 and active=true',[email]);const u=q.rows[0];
  if(!u?.password_hash||!(await verifyPassword(password,u.password_hash)))return res.status(401).json({error:'invalid_credentials'});
  const jti=crypto.randomBytes(24).toString('hex'),now=Math.floor(Date.now()/1000),exp=now+sessionHours*3600;
  const ipHash=tokenHash(String(req.ip||''));
  await pool.query('insert into auth_sessions(operator_id,jti,expires_at,ip_hash,user_agent) values($1,$2,to_timestamp($3),$4,$5)',[u.id,jti,exp,ipHash,String(req.headers['user-agent']||'').slice(0,500)]);
  await pool.query("update operators set last_login_at=now(),last_seen_at=now(),presence='online' where id=$1",[u.id]);
  setCookie(res,signJwt({sub:u.id,jti,role:u.role,ver:u.auth_version,iat:now,exp}));
  res.json({ok:true,user:{id:u.id,name:u.name,email:u.email,role:u.role,department:u.department}});
});
app.post('/api/auth/logout',async(req,res)=>{if(!checkOrigin(req,res))return;const token=cookies(req)[cookieName],jwt=token?verifyJwt(token):null;if(jwt?.jti)await pool.query('update auth_sessions set revoked_at=now() where jti=$1',[jwt.jti]);clearCookie(res);res.json({ok:true})});

app.post('/api/auth/bootstrap',async(req,res)=>{
  if(!checkOrigin(req,res))return;if(!bootstrapToken||String(req.body?.token||'')!==bootstrapToken)return res.status(403).json({error:'invalid_bootstrap_token'});
  const count=await pool.query('select count(*)::int n from operators where password_hash is not null');if(count.rows[0].n>0)return res.status(409).json({error:'bootstrap_already_completed'});
  const email=String(req.body?.email||'').trim().toLowerCase(),password=String(req.body?.password||''),name=String(req.body?.name||'Adwin').trim();
  if(!email.includes('@')||password.length<10)return res.status(400).json({error:'email_and_10_char_password_required'});
  const hash=await scryptHash(password);
  const q=await pool.query("update operators set name=$1,email=$2,password_hash=$3,accepted_at=now(),role='admin',active=true where id=(select id from operators where role='admin' order by created_at limit 1) returning id,name,email,role",[name,email,hash]);
  if(!q.rowCount)return res.status(404).json({error:'admin_operator_missing'});res.json({ok:true,user:q.rows[0]});
});

app.post('/api/auth/invites',async(req,res)=>{
  if(!checkOrigin(req,res))return;const actor=await requireUser(req,res);if(!actor)return;if(!roleAtLeast(actor.role,['admin','supervisor']))return res.status(403).json({error:'forbidden'});
  const email=String(req.body?.email||'').trim().toLowerCase(),name=String(req.body?.name||'').trim(),role=String(req.body?.role||'operator'),department=String(req.body?.department||'').trim()||null;
  if(!email.includes('@')||!name||!['admin','supervisor','operator'].includes(role))return res.status(400).json({error:'invalid_invite'});
  if(actor.role==='supervisor'&&role!=='operator')return res.status(403).json({error:'supervisor_can_only_invite_operator'});
  const op=await pool.query(`insert into operators(name,email,role,department,presence,active,invited_at) values($1,$2,$3,$4,'offline',true,now()) on conflict(lower(email)) where email is not null do update set name=excluded.name,department=excluded.department returning id,name,email,role,department`,[name,email,role,department]);
  const raw=crypto.randomBytes(32).toString('base64url');
  await pool.query("update operator_invites set accepted_at=now() where operator_id=$1 and accepted_at is null",[op.rows[0].id]);
  await pool.query("insert into operator_invites(operator_id,token_hash,invited_by,expires_at) values($1,$2,$3,now()+interval '48 hours')",[op.rows[0].id,tokenHash(raw),actor.id]);
  const base=externalOrigin(req);res.status(201).json({ok:true,operator:op.rows[0],invite_url:`${base}/invite.html?token=${encodeURIComponent(raw)}`,expires_in_hours:48});
});
app.post('/api/auth/invites/accept',async(req,res)=>{
  if(!checkOrigin(req,res))return;const raw=String(req.body?.token||''),password=String(req.body?.password||'');if(password.length<10)return res.status(400).json({error:'password_min_10_chars'});
  const q=await pool.query(`select i.*,o.email,o.name from operator_invites i join operators o on o.id=i.operator_id where i.token_hash=$1 and i.accepted_at is null and i.expires_at>now()`,[tokenHash(raw)]);const inv=q.rows[0];if(!inv)return res.status(400).json({error:'invite_invalid_or_expired'});
  const hash=await scryptHash(password);const client=await pool.connect();try{await client.query('begin');await client.query('update operators set password_hash=$1,accepted_at=now(),auth_version=auth_version+1 where id=$2',[hash,inv.operator_id]);await client.query('update operator_invites set accepted_at=now() where id=$1',[inv.id]);await client.query('commit')}catch(e){await client.query('rollback');throw e}finally{client.release()}res.json({ok:true,email:inv.email,name:inv.name});
});
app.post('/api/auth/sessions/revoke-all',async(req,res)=>{if(!checkOrigin(req,res))return;const actor=await requireUser(req,res);if(!actor)return;await pool.query('update auth_sessions set revoked_at=now() where operator_id=$1 and revoked_at is null',[actor.id]);await pool.query('update operators set auth_version=auth_version+1 where id=$1',[actor.id]);clearCookie(res);res.json({ok:true})});

const publicPaths=new Set(['/login.html','/invite.html','/setup-admin.html','/favicon.ico']);
app.use(async(req,res,next)=>{
  if(req.path.startsWith('/api/auth/'))return next();
  if(req.path==='/api/health'||req.path.startsWith('/api/webhooks/meta'))return next();
  if(publicPaths.has(req.path))return next();
  const user=await requireUser(req,res);if(!user)return;
  if(req.path==='/onboarding.html'&&!roleAtLeast(user.role,['admin']))return res.status(403).send('Admin access required');
  (req as any).relayosUser=user;next();
});

app.use(async(req,res)=>{
  if(!checkOrigin(req,res))return;
  const user=(req as any).relayosUser||await currentUser(req);
  const url=`http://127.0.0.1:${internalPort}${req.originalUrl}`;
  const headers:any={};for(const[k,v]of Object.entries(req.headers)){if(v!==undefined&&!['host','content-length','cookie','x-relayos-operator-id','x-forwarded-proto','x-forwarded-host'].includes(k))headers[k]=Array.isArray(v)?v.join(','):v;}
  if(user)headers['x-relayos-operator-id']=user.id;
  let body:any=undefined;if(!['GET','HEAD'].includes(req.method)&&req.body!==undefined){headers['content-type']='application/json';body=JSON.stringify(req.body)}
  try{const r=await fetch(url,{method:req.method,headers,body,redirect:'manual'});r.headers.forEach((v,k)=>{if(!['transfer-encoding','content-length','set-cookie'].includes(k.toLowerCase()))res.setHeader(k,v)});res.status(r.status);const buf=Buffer.from(await r.arrayBuffer());res.send(buf)}catch(e:any){res.status(502).json({error:'backend_unavailable',detail:e.message})}
});

await migrateAuth();
const child=spawn(process.execPath,['--import','tsx','server/index.ts'],{stdio:'inherit',env:{...process.env,PORT:String(internalPort)}});
child.on('exit',(code)=>{console.error('RelayOS internal backend exited',code);process.exit(code??1)});
setTimeout(()=>app.listen(publicPort,()=>console.log(`RelayOS secure gateway listening on ${publicPort}`)),500);
