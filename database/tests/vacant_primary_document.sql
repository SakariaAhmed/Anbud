do $$
declare
  v_project_id uuid := gen_random_uuid();
  v_customer_id uuid := gen_random_uuid();
  v_result jsonb;
begin
  insert into public.projects (id, client_name, title)
  values (v_project_id, 'Synthetic customer', 'Vacant primary project');

  perform public.insert_primary_project_document(v_project_id, 'primary_customer_document', jsonb_build_object(
    'id', v_customer_id, 'title', 'Kundens kravspesifikasjon', 'file_name', 'krav.pdf',
    'file_format', 'pdf', 'content_type', 'application/pdf',
    'file_storage_bucket', 'documents', 'file_storage_path', 'projects/a/krav.pdf'));

  v_result := public.insert_vacant_primary_project_document(v_project_id, 'primary_customer_document', jsonb_build_object(
    'id', gen_random_uuid(), 'title', 'Bilag 1', 'file_name', 'bilag1.pdf',
    'file_format', 'pdf', 'content_type', 'application/pdf',
    'file_storage_bucket', 'documents', 'file_storage_path', 'projects/a/bilag1.pdf'));
  if v_result is not null then
    raise exception 'A suggested role replaced the current customer document';
  end if;
  if (select role from public.documents where id = v_customer_id) is distinct from 'primary_customer_document' then
    raise exception 'The current customer document was demoted';
  end if;
  if (select count(*) from public.documents where project_id = v_project_id) <> 1 then
    raise exception 'A refused suggestion still inserted a document';
  end if;

  v_result := public.insert_vacant_primary_project_document(v_project_id, 'primary_solution_document', jsonb_build_object(
    'id', gen_random_uuid(), 'title', 'Bilag 2', 'file_name', 'bilag2.pdf',
    'file_format', 'pdf', 'content_type', 'application/pdf',
    'file_storage_bucket', 'documents', 'file_storage_path', 'projects/a/bilag2.pdf'));
  if v_result ->> 'role' is distinct from 'primary_solution_document' then
    raise exception 'A vacant suggested role was not filled: %', v_result;
  end if;
  if not (select solution_document_uploaded from public.projects where id = v_project_id) then
    raise exception 'The project flags were not updated by the existing insert';
  end if;
end;
$$;
