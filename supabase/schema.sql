create extension if not exists pgcrypto;

create table if not exists bids (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  customer_name text not null,
  title text not null default 'Ny analyse',
  estimated_value numeric(14,2),
  deadline date default (current_date + 30),
  owner text default 'Ikke satt',
  custom_fields jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists bids
  add column if not exists customer_name text,
  add column if not exists title text default 'Ny analyse',
  add column if not exists estimated_value numeric(14,2),
  add column if not exists deadline date default (current_date + 30),
  add column if not exists owner text default 'Ikke satt',
  add column if not exists custom_fields jsonb default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

update bids
set
  customer_name = coalesce(nullif(customer_name, ''), 'Ukjent kunde'),
  title = coalesce(nullif(title, ''), 'Ny analyse'),
  owner = coalesce(nullif(owner, ''), 'Ikke satt'),
  custom_fields = coalesce(custom_fields, '{}'::jsonb),
  deadline = coalesce(deadline, current_date + 30)
where customer_name is null
   or customer_name = ''
   or title is null
   or title = ''
   or owner is null
   or owner = ''
   or custom_fields is null
   or deadline is null;

alter table if exists bids
  alter column customer_name set not null,
  alter column title set not null,
  alter column custom_fields set not null;

alter table if exists bids
  alter column deadline set default (current_date + 30),
  alter column owner set default 'Ikke satt',
  alter column custom_fields set default '{}'::jsonb;

create table if not exists bid_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  bid_id uuid not null references bids(id) on delete cascade,
  document_role text not null check (document_role in ('bilag1', 'bilag2')),
  file_name text not null,
  content_type text not null,
  file_format text not null,
  file_base64 text not null,
  raw_text text not null default '',
  source_map jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table if exists bid_documents
  add column if not exists document_role text,
  add column if not exists file_format text,
  add column if not exists file_base64 text,
  add column if not exists raw_text text default '',
  add column if not exists source_map jsonb default '[]'::jsonb,
  add column if not exists created_at timestamptz not null default now();

update bid_documents
set
  document_role = coalesce(
    nullif(document_role, ''),
    case
      when lower(file_name) like '%bilag 2%' or lower(file_name) like '%bilag2%' then 'bilag2'
      else 'bilag1'
    end
  ),
  file_format = coalesce(
    nullif(file_format, ''),
    case
      when lower(file_name) like '%.pdf' then 'pdf'
      when lower(file_name) like '%.docx' then 'docx'
      when lower(file_name) like '%.txt' then 'txt'
      else 'txt'
    end
  ),
  file_base64 = coalesce(file_base64, ''),
  raw_text = coalesce(raw_text, ''),
  source_map = coalesce(source_map, '[]'::jsonb)
where document_role is null
   or document_role = ''
   or file_format is null
   or file_format = ''
   or file_base64 is null
   or raw_text is null
   or source_map is null;

alter table if exists bid_documents
  alter column document_role set default 'bilag1',
  alter column file_format set default 'txt',
  alter column file_base64 set default '',
  alter column raw_text set default '',
  alter column source_map set default '[]'::jsonb;

alter table if exists bid_documents
  drop constraint if exists bid_documents_document_role_check;

alter table if exists bid_documents
  add constraint bid_documents_document_role_check
  check (document_role in ('bilag1', 'bilag2'));

create table if not exists bid_requirements (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  bid_id uuid not null references bids(id) on delete cascade,
  code text not null,
  category text not null default 'Generelt',
  requirement_type text not null check (requirement_type in ('Må', 'Bør')),
  scope_summary text not null,
  source_reference text not null default '',
  source_excerpt text not null default '',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists bid_requirements
  add column if not exists title text,
  add column if not exists detail text,
  add column if not exists priority text,
  add column if not exists status text,
  add column if not exists code text,
  add column if not exists requirement_type text,
  add column if not exists scope_summary text,
  add column if not exists source_reference text default '',
  add column if not exists source_document text,
  add column if not exists completion_notes text default '',
  add column if not exists sort_order integer default 0,
  add column if not exists source_excerpt text default '',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

update bid_requirements
set
  title = coalesce(nullif(title, ''), nullif(scope_summary, ''), nullif(detail, ''), 'Mangler kravtittel'),
  detail = coalesce(nullif(detail, ''), nullif(scope_summary, ''), nullif(title, ''), 'Mangler kravutdyping'),
  priority = coalesce(
    nullif(priority, ''),
    case
      when requirement_type = 'Bør' then 'Low'
      else 'High'
    end
  ),
  status = coalesce(nullif(status, ''), 'Open'),
  code = coalesce(nullif(code, ''), 'Krav ' || left(id::text, 8)),
  requirement_type = coalesce(
    nullif(requirement_type, ''),
    case
      when coalesce(priority, '') = 'Low' then 'Bør'
      else 'Må'
    end
  ),
  scope_summary = coalesce(nullif(scope_summary, ''), nullif(detail, ''), nullif(title, ''), 'Mangler sammendrag'),
  source_reference = coalesce(nullif(source_reference, ''), coalesce(source_document, '')),
  source_excerpt = coalesce(source_excerpt, ''),
  source_document = coalesce(source_document, nullif(source_reference, '')),
  completion_notes = coalesce(completion_notes, ''),
  sort_order = coalesce(sort_order, 0)
where title is null
   or title = ''
   or detail is null
   or detail = ''
   or priority is null
   or priority = ''
   or status is null
   or status = ''
   or code is null
   or code = ''
   or requirement_type is null
   or requirement_type = ''
   or scope_summary is null
   or scope_summary = ''
   or source_reference is null
   or source_excerpt is null
   or completion_notes is null
   or sort_order is null;

alter table if exists bid_requirements
  alter column title set not null,
  alter column detail set not null,
  alter column code set not null,
  alter column priority set not null,
  alter column status set not null,
  alter column requirement_type set not null,
  alter column scope_summary set not null,
  alter column source_reference set not null,
  alter column source_excerpt set not null,
  alter column completion_notes set not null,
  alter column sort_order set not null;

alter table if exists bid_requirements
  drop constraint if exists bid_requirements_requirement_type_check;

alter table if exists bid_requirements
  add constraint bid_requirements_requirement_type_check
  check (requirement_type in ('Må', 'Bør'));

alter table if exists bid_requirements
  drop constraint if exists bid_requirements_priority_check;

alter table if exists bid_requirements
  add constraint bid_requirements_priority_check
  check (priority in ('Low', 'Medium', 'High'));

alter table if exists bid_requirements
  drop constraint if exists bid_requirements_status_check;

alter table if exists bid_requirements
  add constraint bid_requirements_status_check
  check (status in ('Open', 'In Progress', 'Covered'));

create unique index if not exists idx_bid_requirements_code_unique
  on bid_requirements (tenant_id, bid_id, code);

create table if not exists bid_customer_analysis (
  bid_id uuid primary key references bids(id) on delete cascade,
  tenant_id text not null,
  customer_priorities jsonb not null default '[]'::jsonb,
  clarifications jsonb not null default '[]'::jsonb,
  value_angles jsonb not null default '[]'::jsonb,
  generated_at timestamptz not null default now()
);

create table if not exists bid_compliance_results (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  bid_id uuid not null references bids(id) on delete cascade,
  requirement_id uuid not null references bid_requirements(id) on delete cascade,
  status text not null check (status in ('Besvart', 'Delvis besvart', 'Ikke besvart')),
  found_in text,
  answer_excerpt text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists bid_compliance_results
  add column if not exists tenant_id text,
  add column if not exists bid_id uuid references bids(id) on delete cascade,
  add column if not exists requirement_id uuid references bid_requirements(id) on delete cascade,
  add column if not exists status text,
  add column if not exists found_in text,
  add column if not exists answer_excerpt text default '',
  add column if not exists notes text default '',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

update bid_compliance_results
set
  status = coalesce(nullif(status, ''), 'Ikke besvart'),
  answer_excerpt = coalesce(answer_excerpt, ''),
  notes = coalesce(notes, '')
where status is null
   or status = ''
   or answer_excerpt is null
   or notes is null;

alter table if exists bid_compliance_results
  drop constraint if exists bid_compliance_results_status_check;

alter table if exists bid_compliance_results
  add constraint bid_compliance_results_status_check
  check (status in ('Besvart', 'Delvis besvart', 'Ikke besvart'));

create unique index if not exists idx_bid_compliance_requirement_unique
  on bid_compliance_results (tenant_id, bid_id, requirement_id);

create index if not exists idx_bids_tenant_updated
  on bids (tenant_id, updated_at desc);

create index if not exists idx_bid_documents_bid_created
  on bid_documents (tenant_id, bid_id, created_at desc);

create index if not exists idx_bid_requirements_bid_updated
  on bid_requirements (tenant_id, bid_id, updated_at desc);

create index if not exists idx_bid_compliance_bid_updated
  on bid_compliance_results (tenant_id, bid_id, updated_at desc);
