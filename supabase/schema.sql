-- Run in Supabase SQL editor.
create extension if not exists pgcrypto;

create table if not exists bids (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  customer_name text not null,
  title text not null default 'Untitled Bid',
  estimated_value numeric(14,2),
  deadline date not null,
  owner text not null default 'Unassigned',
  custom_fields jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists bid_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  bid_id uuid not null references bids(id) on delete cascade,
  file_name text not null,
  content_type text not null,
  raw_text text not null,
  status text not null default 'uploaded',
  created_at timestamptz not null default now()
);

create table if not exists bid_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  bid_id uuid not null references bids(id) on delete cascade,
  timestamp timestamptz not null default now(),
  user_name text not null default 'system',
  type text not null check (type in ('bid_created','document_uploaded','chat_question','chat_answer')),
  payload jsonb not null default '{}'::jsonb
);

create table if not exists bid_notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  bid_id uuid not null references bids(id) on delete cascade,
  content text not null,
  user_name text not null default 'system',
  created_at timestamptz not null default now()
);

create index if not exists idx_bids_tenant_updated on bids (tenant_id, updated_at desc);
create index if not exists idx_bid_documents_bid on bid_documents (tenant_id, bid_id, created_at desc);
create index if not exists idx_bid_events_bid on bid_events (tenant_id, bid_id, timestamp asc);
create index if not exists idx_bid_notes_bid on bid_notes (tenant_id, bid_id, created_at desc);
