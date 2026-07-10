comment on column documents.file_base64 is
  'Plaintext compatibility cache for legacy downloads. Current encrypted object storage is file_storage_bucket/file_storage_path; do not treat chunk encryption as full document-body encryption while this column is populated.';
comment on column documents.raw_text is
  'Plaintext extraction cache used by parsers, previews, and reindexing. document_chunks.text_encrypted protects only chunk bodies, not this source text.';
comment on column service_documents.file_base64 is
  'Plaintext compatibility cache for legacy downloads. Current encrypted object storage is file_storage_bucket/file_storage_path; do not treat chunk encryption as full document-body encryption while this column is populated.';
comment on column service_documents.raw_text is
  'Plaintext extraction cache used by parsers, previews, and reindexing. document_chunks.text_encrypted protects only chunk bodies, not this source text.';
comment on column document_chunks.fts is
  'Plaintext lexical index for hybrid retrieval. This intentionally stores searchable lexemes outside text_encrypted; disable/drop it if full content-at-rest encryption becomes a hard requirement.';
