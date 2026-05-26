insert into storage.buckets (id, name, public, file_size_limit)
values ('anbud-documents', 'anbud-documents', false, 41943040)
on conflict (id) do update
set
  public = false,
  file_size_limit = 41943040;

alter table documents
  add column if not exists supporting_subtype text,
  add column if not exists subtype text,
  add column if not exists title text,
  add column if not exists display_name text,
  add column if not exists file_name text,
  add column if not exists content_type text,
  add column if not exists file_format text,
  add column if not exists file_size_bytes integer,
  add column if not exists page_count integer,
  add column if not exists file_storage_bucket text,
  add column if not exists file_storage_path text,
  add column if not exists file_base64 text,
  add column if not exists raw_text text,
  add column if not exists structure_map jsonb,
  add column if not exists updated_at timestamptz;

update documents
set
  supporting_subtype = case
    when supporting_subtype in ('rfp', 'kravdokument', 'prosjektbeskrivelse', 'notat', 'motenotat', 'workshop', 'vedlegg', 'strategi', 'utkast', 'annet')
      then supporting_subtype
    when subtype in ('rfp', 'kravdokument', 'prosjektbeskrivelse', 'notat', 'motenotat', 'workshop', 'vedlegg', 'strategi', 'utkast', 'annet')
      then subtype
    else null
  end,
  subtype = case
    when subtype in ('rfp', 'kravdokument', 'prosjektbeskrivelse', 'notat', 'motenotat', 'workshop', 'vedlegg', 'strategi', 'utkast', 'annet')
      then subtype
    when supporting_subtype in ('rfp', 'kravdokument', 'prosjektbeskrivelse', 'notat', 'motenotat', 'workshop', 'vedlegg', 'strategi', 'utkast', 'annet')
      then supporting_subtype
    else null
  end,
  title = coalesce(nullif(title, ''), nullif(display_name, ''), nullif(file_name, ''), 'Dokument'),
  display_name = coalesce(nullif(display_name, ''), nullif(title, ''), nullif(file_name, ''), 'Dokument'),
  file_name = coalesce(nullif(file_name, ''), nullif(display_name, ''), nullif(title, ''), 'document.txt'),
  content_type = coalesce(nullif(content_type, ''), 'application/octet-stream'),
  file_format = case
    when lower(coalesce(file_format, '')) in ('pdf', 'docx', 'txt', 'md', 'xlsx', 'xls')
      then lower(file_format)
    else 'txt'
  end,
  file_size_bytes = coalesce(file_size_bytes, 0),
  file_storage_bucket = coalesce(nullif(file_storage_bucket, ''), 'anbud-documents'),
  file_base64 = coalesce(file_base64, ''),
  raw_text = coalesce(raw_text, ''),
  structure_map = coalesce(structure_map, '[]'::jsonb),
  updated_at = coalesce(updated_at, created_at, now());

alter table documents
  alter column title set default 'Dokument',
  alter column title set not null,
  alter column display_name set default 'Dokument',
  alter column display_name set not null,
  alter column file_name set default 'document.txt',
  alter column file_name set not null,
  alter column content_type set default 'application/octet-stream',
  alter column content_type set not null,
  alter column file_format set default 'txt',
  alter column file_format set not null,
  alter column file_size_bytes set default 0,
  alter column file_size_bytes set not null,
  alter column file_storage_bucket set default 'anbud-documents',
  alter column file_storage_bucket set not null,
  alter column file_base64 set default '',
  alter column file_base64 set not null,
  alter column raw_text set default '',
  alter column raw_text set not null,
  alter column structure_map set default '[]'::jsonb,
  alter column structure_map set not null,
  alter column updated_at set default now(),
  alter column updated_at set not null;

alter table documents
  drop constraint if exists documents_file_format_check;

alter table documents
  add constraint documents_file_format_check
  check (file_format in ('pdf', 'docx', 'txt', 'md', 'xlsx', 'xls'));

alter table documents
  drop constraint if exists documents_subtype_check;

alter table documents
  add constraint documents_subtype_check
  check (
    subtype is null
    or subtype in ('rfp', 'kravdokument', 'prosjektbeskrivelse', 'notat', 'motenotat', 'workshop', 'vedlegg', 'strategi', 'utkast', 'annet')
  );

alter table documents
  drop constraint if exists documents_supporting_subtype_check;

alter table documents
  add constraint documents_supporting_subtype_check
  check (
    supporting_subtype is null
    or supporting_subtype in ('rfp', 'kravdokument', 'prosjektbeskrivelse', 'notat', 'motenotat', 'workshop', 'vedlegg', 'strategi', 'utkast', 'annet')
  );

create index if not exists documents_project_id_idx on documents(project_id);
create index if not exists documents_project_role_idx on documents(project_id, role, created_at desc);

alter table service_documents
  add column if not exists title text,
  add column if not exists file_name text,
  add column if not exists content_type text,
  add column if not exists file_format text,
  add column if not exists file_size_bytes integer,
  add column if not exists page_count integer,
  add column if not exists file_storage_bucket text,
  add column if not exists file_storage_path text,
  add column if not exists file_base64 text,
  add column if not exists raw_text text,
  add column if not exists structure_map jsonb,
  add column if not exists ai_summary text,
  add column if not exists ai_summary_updated_at timestamptz,
  add column if not exists updated_at timestamptz;

update service_documents
set
  title = coalesce(nullif(title, ''), nullif(file_name, ''), 'Tjenestedokument'),
  file_name = coalesce(nullif(file_name, ''), nullif(title, ''), 'document.txt'),
  content_type = coalesce(nullif(content_type, ''), 'application/octet-stream'),
  file_format = case
    when lower(coalesce(file_format, '')) in ('pdf', 'docx', 'txt', 'md', 'xlsx', 'xls')
      then lower(file_format)
    else 'txt'
  end,
  file_size_bytes = coalesce(file_size_bytes, 0),
  file_storage_bucket = coalesce(nullif(file_storage_bucket, ''), 'anbud-documents'),
  file_base64 = coalesce(file_base64, ''),
  raw_text = coalesce(raw_text, ''),
  structure_map = coalesce(structure_map, '[]'::jsonb),
  ai_summary = coalesce(ai_summary, ''),
  updated_at = coalesce(updated_at, created_at, now());

alter table service_documents
  alter column title set default 'Tjenestedokument',
  alter column title set not null,
  alter column file_name set default 'document.txt',
  alter column file_name set not null,
  alter column content_type set default 'application/octet-stream',
  alter column content_type set not null,
  alter column file_format set default 'txt',
  alter column file_format set not null,
  alter column file_size_bytes set default 0,
  alter column file_size_bytes set not null,
  alter column file_storage_bucket set default 'anbud-documents',
  alter column file_storage_bucket set not null,
  alter column file_base64 set default '',
  alter column file_base64 set not null,
  alter column raw_text set default '',
  alter column raw_text set not null,
  alter column structure_map set default '[]'::jsonb,
  alter column structure_map set not null,
  alter column ai_summary set default '',
  alter column ai_summary set not null,
  alter column updated_at set default now(),
  alter column updated_at set not null;

alter table service_documents
  drop constraint if exists service_documents_file_format_check;

alter table service_documents
  add constraint service_documents_file_format_check
  check (file_format in ('pdf', 'docx', 'txt', 'md', 'xlsx', 'xls'));

create index if not exists service_documents_service_id_idx
  on service_documents(service_id, created_at desc);

notify pgrst, 'reload schema';
