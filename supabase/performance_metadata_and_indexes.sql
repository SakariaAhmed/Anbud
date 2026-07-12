alter table documents
  add column if not exists supporting_subtype text,
  add column if not exists title text,
  add column if not exists file_name text,
  add column if not exists file_size_bytes integer not null default 0,
  add column if not exists page_count integer,
  add column if not exists updated_at timestamptz not null default now();

alter table service_documents
  add column if not exists page_count integer;

update documents
set
  supporting_subtype = coalesce(supporting_subtype, subtype),
  title = coalesce(nullif(title, ''), nullif(display_name, ''), 'Dokument'),
  file_name = coalesce(nullif(file_name, ''), nullif(display_name, ''), nullif(title, ''), 'document.txt'),
  updated_at = coalesce(updated_at, created_at, now())
where
  supporting_subtype is null
  or title is null
  or title = ''
  or file_name is null
  or file_name = '';

alter table documents
  alter column title set not null,
  alter column file_name set not null;

alter table documents
  drop constraint if exists documents_file_format_check;

alter table documents
  add constraint documents_file_format_check
  check (file_format in ('pdf', 'docx', 'txt', 'md', 'xlsx', 'xls'));

alter table documents
  drop constraint if exists documents_subtype_check;

alter table documents
  add constraint documents_subtype_check
  check (subtype in ('rfp', 'kravdokument', 'prosjektbeskrivelse', 'notat', 'motenotat', 'workshop', 'vedlegg', 'strategi', 'utkast', 'tidligere_losning', 'annet'));

alter table documents
  drop constraint if exists documents_supporting_subtype_check;

alter table documents
  add constraint documents_supporting_subtype_check
  check (
    supporting_subtype is null
    or supporting_subtype in ('rfp', 'kravdokument', 'prosjektbeskrivelse', 'notat', 'motenotat', 'workshop', 'vedlegg', 'strategi', 'utkast', 'tidligere_losning', 'annet')
  );

create index if not exists projects_last_activity_idx
  on projects(last_activity_at desc);

create index if not exists project_service_selections_service_idx
  on project_service_selections(service_id);
