insert into storage.buckets (id, name, public, file_size_limit)
values ('anbud-documents', 'anbud-documents', false, 41943040)
on conflict (id) do update
set
  public = false,
  file_size_limit = 41943040;

alter table documents
  add column if not exists file_storage_bucket text not null default 'anbud-documents',
  add column if not exists file_storage_path text;

alter table service_documents
  add column if not exists file_storage_bucket text not null default 'anbud-documents',
  add column if not exists file_storage_path text;
