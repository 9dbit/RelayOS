import pg from 'pg';
const {Pool}=pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized:false } : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
});

export async function migrate(){
  if(!process.env.DATABASE_URL){console.warn('DATABASE_URL not configured; persistence endpoints will be unavailable.');return;}
  await pool.query(`
  create extension if not exists pgcrypto;

  create table if not exists whatsapp_accounts(
    id uuid primary key default gen_random_uuid(),name text not null,phone text not null unique,phone_number_id text unique,waba_id text,department text,mode text not null default 'hybrid',health_score int not null default 100 check(health_score between 0 and 100),status text not null default 'setup',last_webhook_at timestamptz,last_outbound_at timestamptz,last_error text,created_at timestamptz not null default now(),updated_at timestamptz not null default now()
  );
  alter table whatsapp_accounts add column if not exists last_webhook_at timestamptz;
  alter table whatsapp_accounts add column if not exists last_outbound_at timestamptz;
  alter table whatsapp_accounts add column if not exists last_error text;

  create table if not exists operators(
    id uuid primary key default gen_random_uuid(),
    name text not null,
    email text unique,
    role text not null default 'operator' check(role in ('admin','supervisor','operator')),
    presence text not null default 'offline' check(presence in ('online','away','offline')),
    department text,
    max_conversations int not null default 20 check(max_conversations between 1 and 500),
    active boolean not null default true,
    last_seen_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  create table if not exists customers(
    id uuid primary key default gen_random_uuid(),phone text not null unique,name text,source text,tags text[] not null default '{}',opt_in boolean not null default false,opt_in_source text,opt_in_at timestamptz,do_not_contact boolean not null default false,assigned_whatsapp_id uuid references whatsapp_accounts(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now()
  );

  create table if not exists conversations(
    id uuid primary key default gen_random_uuid(),customer_id uuid not null references customers(id) on delete cascade,whatsapp_account_id uuid not null references whatsapp_accounts(id),status text not null default 'open',intent text,ai_mode text not null default 'hybrid',assigned_operator text,assigned_operator_id uuid references operators(id),unread_count int not null default 0,priority text not null default 'normal',escalation_status text not null default 'none',escalation_reason text,escalated_at timestamptz,closed_at timestamptz,last_read_at timestamptz,first_response_due_at timestamptz,resolution_due_at timestamptz,first_response_at timestamptz,sla_breached_at timestamptz,last_message_at timestamptz not null default now(),created_at timestamptz not null default now()
  );
  alter table conversations add column if not exists assigned_operator_id uuid references operators(id);
  alter table conversations add column if not exists unread_count int not null default 0;
  alter table conversations add column if not exists priority text not null default 'normal';
  alter table conversations add column if not exists escalation_status text not null default 'none';
  alter table conversations add column if not exists escalation_reason text;
  alter table conversations add column if not exists escalated_at timestamptz;
  alter table conversations add column if not exists closed_at timestamptz;
  alter table conversations add column if not exists last_read_at timestamptz;
  alter table conversations add column if not exists first_response_due_at timestamptz;
  alter table conversations add column if not exists resolution_due_at timestamptz;
  alter table conversations add column if not exists first_response_at timestamptz;
  alter table conversations add column if not exists sla_breached_at timestamptz;

  create table if not exists messages(
    id uuid primary key default gen_random_uuid(),conversation_id uuid not null references conversations(id) on delete cascade,direction text not null,sender_type text not null,external_message_id text unique,original_text text,interpreted_text text,rewritten_text text,delivery_status text not null default 'received',sent_at timestamptz,delivered_at timestamptz,read_at timestamptz,failed_at timestamptz,metadata jsonb not null default '{}',created_at timestamptz not null default now()
  );
  alter table messages add column if not exists sent_at timestamptz;
  alter table messages add column if not exists delivered_at timestamptz;
  alter table messages add column if not exists read_at timestamptz;
  alter table messages add column if not exists failed_at timestamptz;

  create table if not exists conversation_notes(id uuid primary key default gen_random_uuid(),conversation_id uuid not null references conversations(id) on delete cascade,author text not null,body text not null,created_at timestamptz not null default now());
  create table if not exists conversation_events(id uuid primary key default gen_random_uuid(),conversation_id uuid not null references conversations(id) on delete cascade,event_type text not null,actor text,payload jsonb not null default '{}',created_at timestamptz not null default now());
  create table if not exists inbound_events(id uuid primary key default gen_random_uuid(),provider text not null,event_key text not null unique,payload jsonb not null,processed_at timestamptz,created_at timestamptz not null default now());

  create index if not exists idx_customers_assigned_whatsapp on customers(assigned_whatsapp_id);
  create index if not exists idx_conversations_last_message on conversations(last_message_at desc);
  create index if not exists idx_conversations_operator on conversations(assigned_operator_id,status);
  create index if not exists idx_conversations_sla on conversations(status,first_response_due_at,resolution_due_at);
  create unique index if not exists uq_open_conversation_per_sender on conversations(customer_id,whatsapp_account_id) where status='open';
  create index if not exists idx_messages_conversation_created on messages(conversation_id,created_at);
  create index if not exists idx_messages_external_status on messages(external_message_id,delivery_status);
  create index if not exists idx_notes_conversation_created on conversation_notes(conversation_id,created_at desc);
  create index if not exists idx_events_conversation_created on conversation_events(conversation_id,created_at desc);

  update conversations set
    first_response_due_at=coalesce(first_response_due_at,created_at + case priority when 'urgent' then interval '5 minutes' when 'high' then interval '10 minutes' when 'low' then interval '60 minutes' else interval '30 minutes' end),
    resolution_due_at=coalesce(resolution_due_at,created_at + case priority when 'urgent' then interval '60 minutes' when 'high' then interval '120 minutes' when 'low' then interval '1440 minutes' else interval '480 minutes' end)
  where status='open';
  `);

  await pool.query(`insert into operators(name,email,role,presence,department,max_conversations,active,last_seen_at)
    values('Adwin','admin@relayos.local','admin','online','Management',100,true,now())
    on conflict(email) do update set role='admin',active=true,updated_at=now()`);

  const phone=normalizePhone(process.env.RELAYOS_PRIMARY_PHONE||'');
  const phoneNumberId=process.env.RELAYOS_PRIMARY_PHONE_NUMBER_ID;
  const wabaId=process.env.RELAYOS_PRIMARY_WABA_ID;
  if(phone&&phoneNumberId&&wabaId){
    await pool.query(`insert into whatsapp_accounts(name,phone,phone_number_id,waba_id,department,mode,status,health_score)
      values($1,$2,$3,$4,$5,'hybrid','verifying',85)
      on conflict(phone) do update set name=excluded.name,phone_number_id=excluded.phone_number_id,waba_id=excluded.waba_id,department=excluded.department,updated_at=now()`,[process.env.RELAYOS_PRIMARY_NAME||'Primary WhatsApp',phone,phoneNumberId,wabaId,process.env.RELAYOS_PRIMARY_DEPARTMENT||'Sales']);
  }
}

export function normalizePhone(input:string){let p=String(input||'').replace(/\D/g,'');if(p.startsWith('0'))p='62'+p.slice(1);if(p.startsWith('8'))p='62'+p;return /^62\d{8,13}$/.test(p)?p:null;}

export function slaIntervals(priority='normal'){
  if(priority==='urgent')return{first:5,resolution:60};
  if(priority==='high')return{first:10,resolution:120};
  if(priority==='low')return{first:60,resolution:1440};
  return{first:30,resolution:480};
}

export async function chooseStickySender(customerId:string){
  const existing=await pool.query('select assigned_whatsapp_id from customers where id=$1',[customerId]);if(existing.rows[0]?.assigned_whatsapp_id)return existing.rows[0].assigned_whatsapp_id as string;
  const sender=await pool.query(`select wa.id from whatsapp_accounts wa left join conversations c on c.whatsapp_account_id=wa.id and c.status='open' where wa.status in ('active','healthy') and wa.health_score>=60 group by wa.id order by count(c.id),wa.health_score desc,wa.created_at limit 1`);
  const id=sender.rows[0]?.id;if(!id)throw new Error('No eligible WhatsApp sender available');await pool.query('update customers set assigned_whatsapp_id=$1,updated_at=now() where id=$2',[id,customerId]);return id as string;
}
