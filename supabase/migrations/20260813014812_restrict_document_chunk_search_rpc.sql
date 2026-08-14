revoke execute on function public.update_document_chunk_search_vectors(text, uuid, jsonb)
  from public, anon, authenticated;

grant execute on function public.update_document_chunk_search_vectors(text, uuid, jsonb)
  to service_role;
