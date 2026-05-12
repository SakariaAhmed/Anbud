alter table service_documents
  add column if not exists ai_summary text not null default '',
  add column if not exists ai_summary_updated_at timestamptz;
