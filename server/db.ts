import pg from 'pg';
const {Pool}=pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized:false } : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
});

export async function migrate(){
  if(!process.env.DATABASE_URL){
    console.warn('DATABASE_URL not configured; persistence endpoints will be unavailable.');
    return;
  }
  await pool.query(`
  create extension if not exists pgcrypto;

  create table if not exists whatsapp_accounts(
    id uuid primary key default gen_random_uuid(),
    name text not null,
    phone text not null unique,
    phone_number_id text unique,
    waba_id text,
    department text,
    mode text not null default 'hybrid',
    health_score int not null default 100,
    status text not null default 'setup',
    access_token_encrypted text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  create table if not exists customers(
    id uuid primary key default gen_random_uuid(),
    phone text not null unique,
    name text,
    source text,
    tags text[] not null default '{}',
    opt_in boolean not null default false,
    opt_in_source text,
    opt_in_at timestamptz,
    do_not_contact boolean not null default false,
    assigned_whatsapp_id uuid references whatsapp_accounts(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  create table if not exists conversations(
    id uuid primary key default gen_random_uuid(),
    customer_id uuid not null references customers(id) on delete cascade,
    whatsapp_account_id uuid not null references whatsapp_accounts(id),
    status text not null default 'open',
    intent text,
    ai_mode text not null default 'hybrid',
    assigned_operator text,
    last_message_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique(customer_id, whatsapp_account_id, status)
  );

  create table if not exists messages(
    id uuid primary key default gen_random_uuid(),
    conversation_id uuid not null references conversations(id) on delete cascade,
    direction text not null,
    sender_type text not null,
    external_message_id text unique,
    original_text text,
    interpreted_text text,
    rewritten_text text,
    delivery_status text not null default 'received',
    metadata jsonb not null default '{}',
    created_at timestamptz not null default now()
  );

  create table if not exists inbound_events(
    id uuid primary key default gen_random_uuid(),
    provider text not null,
    event_key text not null unique,
    payload jsonb not null,
    processed_at timestamptz,
    created_at timestamptz not null default now()
  );

  create index if not exists idx_customers_assigned_whatsapp on customers(assigned_whatsapp_id);
  create index if not exists idx_conversations_last_message on conversations(last_message_at desc);
  create index if not exists idx_messages_conversation_created on messages(conversation_id, created_at);
  `);
}

export function normalizePhone(input:string){
  let p=String(input||'').replace(/\D/g,'');
  if(p.startsWith('0')) p='62'+p.slice(1);
  if(p.startsWith('8')) p='62'+p;
  return /^62\d{8,13}$/.test(p)?p:null;
}

export async function chooseStickySender(customerId:string){
  const existing=await pool.query('select assigned_whatsapp_id from customers where id=$1',[customerId]);
  if(existing.rows[0]?.assigned_whatsapp_id) return existing.rows[0].assigned_whatsapp_id as string;
  const sender=await pool.query(`
    select wa.id
    from whatsapp_accounts wa
    left join conversations c on c.whatsapp_account_id=wa.id and c.status='open'
    where wa.status in ('active','healthy') and wa.health_score >= 60
    group by wa.id
    order by count(c.id) asc, wa.health_score desc, wa.created_at asc
    limit 1
  `);
  const id=sender.rows[0]?.id;
  if(!id) throw new Error('No eligible WhatsApp sender available');
  await pool.query('update customers set assigned_whatsapp_id=$1, updated_at=now() where id=$2',[id,customerId]);
  return id as string;
}
