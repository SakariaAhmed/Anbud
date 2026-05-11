create extension if not exists pgcrypto;

drop table if exists generated_artifacts cascade;
drop table if exists project_jobs cascade;
drop table if exists chat_messages cascade;
drop table if exists solution_evaluations cascade;
drop table if exists executive_summaries cascade;
drop table if exists customer_analyses cascade;
drop table if exists project_service_selections cascade;
drop table if exists service_documents cascade;
drop table if exists service_descriptions cascade;
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
  context_keywords text[] not null default '{}',
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
  file_format text not null check (file_format in ('pdf', 'docx', 'txt', 'md', 'xlsx', 'xls')),
  file_base64 text not null,
  raw_text text not null default '',
  structure_map jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index documents_project_id_idx on documents(project_id);
create index documents_project_role_idx on documents(project_id, role, created_at desc);

create table service_descriptions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  keywords text[] not null default '{}',
  inclusion_mode text not null default 'selected' check (inclusion_mode in ('fixed', 'selected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index service_descriptions_mode_idx on service_descriptions(inclusion_mode, name);
create index service_descriptions_keywords_idx on service_descriptions using gin(keywords);

create table service_documents (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references service_descriptions(id) on delete cascade,
  title text not null,
  file_name text not null,
  file_format text not null check (file_format in ('pdf', 'docx', 'txt', 'md', 'xlsx', 'xls')),
  content_type text not null,
  file_size_bytes integer not null default 0,
  file_base64 text not null,
  raw_text text not null default '',
  structure_map jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index service_documents_service_id_idx on service_documents(service_id, created_at desc);

create table project_service_selections (
  project_id uuid not null references projects(id) on delete cascade,
  service_id uuid not null references service_descriptions(id) on delete cascade,
  selected boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, service_id)
);

create index project_service_selections_project_idx on project_service_selections(project_id);

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
      'bilag1_rekonstruksjon',
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

create table project_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  kind text not null check (
    kind in (
      'customer_analysis',
      'solution_evaluation',
      'artifact_generation',
      'high_level_design',
      'perfect_system_solution'
    )
  ),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  message text not null default '',
  error text,
  result_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index project_jobs_project_id_idx on project_jobs(project_id, created_at desc);
create index project_jobs_status_idx on project_jobs(status, updated_at desc);

create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  context_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index chat_messages_project_id_idx on chat_messages(project_id, created_at asc);
