alter table project_jobs drop constraint if exists project_jobs_kind_check;
alter table project_jobs
  add constraint project_jobs_kind_check check (
    kind in (
      'customer_analysis',
      'solution_evaluation',
      'artifact_generation',
      'high_level_design',
      'perfect_system_solution',
      'executive_summary',
      'requirement_pipeline'
    )
  );

create table if not exists document_blocks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  document_id uuid references documents(id) on delete cascade,
  page int,
  block_index int not null,
  section_path text[] not null default '{}',
  block_type text not null check (block_type in ('heading', 'paragraph', 'list_item', 'table', 'table_row', 'header', 'footer', 'unknown')),
  text text not null,
  raw_text text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists document_blocks_project_id_idx on document_blocks(project_id);
create index if not exists document_blocks_document_id_idx on document_blocks(document_id);
create index if not exists document_blocks_document_page_idx on document_blocks(document_id, page, block_index);

create table if not exists requirement_candidates (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  document_id uuid references documents(id) on delete cascade,
  candidate_key text,
  title text,
  original_text text not null,
  normalized_text text,
  category text,
  priority text,
  source_block_ids uuid[] not null default '{}',
  source_pages int[] not null default '{}',
  is_continuation boolean not null default false,
  confidence numeric,
  extraction_notes text,
  status text not null default 'candidate',
  created_at timestamptz not null default now()
);

create index if not exists requirement_candidates_project_id_idx on requirement_candidates(project_id);
create index if not exists requirement_candidates_document_id_idx on requirement_candidates(document_id);

create table if not exists requirements (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  document_id uuid references documents(id) on delete cascade,
  requirement_number text,
  original_requirement_id text,
  title text,
  original_text text not null,
  normalized_text text,
  category text,
  priority text,
  source_candidate_ids uuid[] not null default '{}',
  source_block_ids uuid[] not null default '{}',
  source_pages int[] not null default '{}',
  status text not null default 'ready',
  confidence numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists requirements_project_id_idx on requirements(project_id);
create index if not exists requirements_document_id_idx on requirements(document_id);

create table if not exists requirement_answers (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  requirement_id uuid references requirements(id) on delete cascade,
  answer_text text,
  answer_status text not null default 'draft',
  used_service_description_ids uuid[] not null default '{}',
  used_document_ids uuid[] not null default '{}',
  confidence numeric,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists requirement_answers_project_id_idx on requirement_answers(project_id);
create index if not exists requirement_answers_requirement_id_idx on requirement_answers(requirement_id);;
