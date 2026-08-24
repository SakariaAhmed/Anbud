alter table documents
  add column if not exists file_storage_bucket text not null default 'anbud-documents',
  add column if not exists file_storage_path text;

alter table service_documents
  add column if not exists file_storage_bucket text not null default 'anbud-documents',
  add column if not exists file_storage_path text;
