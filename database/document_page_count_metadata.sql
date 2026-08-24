alter table documents
  add column if not exists page_count integer;

alter table service_documents
  add column if not exists page_count integer;
