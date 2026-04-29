create extension if not exists pgcrypto;

drop table if exists generated_artifacts cascade;
drop table if exists chat_messages cascade;
drop table if exists solution_evaluations cascade;
drop table if exists executive_summaries cascade;
drop table if exists customer_analyses cascade;
drop table if exists documents cascade;
drop table if exists projects cascade;

drop table if exists bid_compliance_results cascade;
drop table if exists bid_customer_analysis cascade;
drop table if exists bid_requirements cascade;
drop table if exists bid_documents cascade;
drop table if exists bids cascade;
drop table if exists bid_tasks cascade;
drop table if exists bid_decisions cascade;
drop table if exists bid_notes cascade;
drop table if exists bid_events cascade;

create table projects (
  id uuid primary key default gen_random_uuid(),
  client_name text not null,
  title text not null,
  description text not null default '',
  customer_document_uploaded boolean not null default false,
  customer_analysis_generated boolean not null default false,
  solution_document_uploaded boolean not null default false,
  solution_evaluation_generated boolean not null default false,
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  role text not null check (role in ('primary_customer_document', 'primary_solution_document', 'supporting_document')),
  subtype text check (subtype in ('rfp', 'kravdokument', 'prosjektbeskrivelse', 'motenotat', 'workshop', 'vedlegg', 'strategi', 'utkast', 'annet')),
  display_name text not null,
  content_type text not null,
  file_format text not null check (file_format in ('pdf', 'docx', 'txt', 'md')),
  file_base64 text not null,
  raw_text text not null default '',
  structure_map jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index documents_project_id_idx on documents(project_id);
create index documents_project_role_idx on documents(project_id, role, created_at desc);

create table customer_analyses (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references projects(id) on delete cascade,
  source_document_ids uuid[] not null default '{}',
  result_json jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table solution_evaluations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references projects(id) on delete cascade,
  source_document_ids uuid[] not null default '{}',
  result_json jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table executive_summaries (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references projects(id) on delete cascade,
  result_json jsonb not null,
  input_snapshot jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table generated_artifacts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  artifact_type text not null check (
    artifact_type in (
      'losningsutkast',
      'forbedret_kravsvar',
      'tilbudsstrategi',
      'verdiargumentasjon',
      'anbefalt_arkitektur',
      'gjennomforing_og_risiko'
    )
  ),
  title text not null,
  content_markdown text not null,
  input_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index generated_artifacts_project_id_idx on generated_artifacts(project_id, created_at desc);

create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  context_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index chat_messages_project_id_idx on chat_messages(project_id, created_at asc);
