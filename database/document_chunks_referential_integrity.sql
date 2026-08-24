create or replace function delete_document_chunks_for_project_document()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  delete from document_chunks
  where source_type = 'project_document'
    and source_id = old.id;
  return old;
end;
$$;

create or replace function delete_document_chunks_for_service_document()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  delete from document_chunks
  where source_type = 'service_document'
    and source_id = old.id;
  return old;
end;
$$;

create or replace function validate_document_chunk_source()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.source_type = 'project_document' then
    if not exists (select 1 from documents where id = new.source_id) then
      raise foreign_key_violation using message = 'document_chunks.source_id does not reference an existing project document';
    end if;
    return new;
  end if;

  if new.source_type = 'service_document' then
    if not exists (select 1 from service_documents where id = new.source_id) then
      raise foreign_key_violation using message = 'document_chunks.source_id does not reference an existing service document';
    end if;
    return new;
  end if;

  raise check_violation using message = 'Invalid document_chunks.source_type';
end;
$$;

revoke execute on function delete_document_chunks_for_project_document() from anon;
revoke execute on function delete_document_chunks_for_project_document() from authenticated;
revoke execute on function delete_document_chunks_for_service_document() from anon;
revoke execute on function delete_document_chunks_for_service_document() from authenticated;
revoke execute on function validate_document_chunk_source() from anon;
revoke execute on function validate_document_chunk_source() from authenticated;

drop trigger if exists document_chunks_validate_source on document_chunks;
create trigger document_chunks_validate_source
  before insert or update of source_type, source_id on document_chunks
  for each row
  execute function validate_document_chunk_source();

drop trigger if exists documents_delete_chunks on documents;
create trigger documents_delete_chunks
  after delete on documents
  for each row
  execute function delete_document_chunks_for_project_document();

drop trigger if exists service_documents_delete_chunks on service_documents;
create trigger service_documents_delete_chunks
  after delete on service_documents
  for each row
  execute function delete_document_chunks_for_service_document();
