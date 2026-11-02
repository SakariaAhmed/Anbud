-- Run against a disposable database after 20261102130000_customer_analysis_partials.sql.
create function pg_temp.assert_true(value boolean, label text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'assertion failed: %',label; end if; end $$;
create function pg_temp.expect_error(statement text, expected text) returns void language plpgsql as $$
begin
  begin execute statement; exception when others then
    if position(expected in sqlerrm)>0 then return; end if;
    raise;
  end;
  raise exception 'expected error: %',expected;
end $$;

do $$
declare
  p uuid := '10000000-0000-4000-8000-000000000001';
  j uuid := '20000000-0000-4000-8000-000000000001';
  lease uuid := '30000000-0000-4000-8000-000000000001';
  generation uuid := '40000000-0000-4000-8000-000000000001';
  manual uuid := '50000000-0000-4000-8000-000000000001';
  request_id uuid := '60000000-0000-4000-8000-000000000001';
  payload jsonb;
  statement text;
begin
  insert into public.projects(id,source_revision) values(p,1);
  insert into public.documents(id,project_id) values(p,p);
  insert into public.project_jobs(id,project_id,kind,status,lease_token,locked_at,submission_sequence)
    values(j,p,'customer_analysis','running',lease,clock_timestamp(),1);
  payload := jsonb_build_object('generation_id',generation,'expected_source_revision',1,
    'expected_analysis_revision',null,'source_document_ids',jsonb_build_array(p),
    'field','customer_goals','value',jsonb_build_object('encrypted',true,'payload','enc:v1:first-ciphertext'),
    'digest',repeat('a',64));
  perform public.save_customer_analysis_partial(p,j,lease,payload);
  perform pg_temp.assert_true(public.read_customer_analysis_partial(p)->>'status'='incomplete','incomplete read');
  perform pg_temp.assert_true(not exists(select 1 from public.customer_analyses),'partial is never a complete analysis');
  perform pg_temp.assert_true((select not customer_analysis_generated from public.projects where id=p),'no generated flag');
  perform public.save_customer_analysis_partial(p,j,lease,jsonb_set(payload,'{value,payload}','"enc:v1:retry-ciphertext"'));
  perform pg_temp.assert_true((select fields->'customer_goals'->>'payload'='enc:v1:first-ciphertext' from public.customer_analysis_partials where job_id=j),'retry preserves original value');
  statement := format('select public.save_customer_analysis_partial(%L,%L,%L,%%L::jsonb)',p,j,lease);
  perform pg_temp.expect_error(format(statement,jsonb_set(payload,'{digest}',to_jsonb(repeat('b',64)))),'ANALYSIS_PARTIAL_FIELD_CHANGED');
  perform pg_temp.expect_error(format(statement,jsonb_set(payload,'{generation_id}',to_jsonb(gen_random_uuid()))),'ANALYSIS_PARTIAL_GENERATION_CHANGED');
  perform pg_temp.expect_error(format(statement,jsonb_set(payload,'{value}','{"unencrypted":"secret"}')),'INVALID_ANALYSIS_PARTIAL');
  perform pg_temp.expect_error(format(statement,jsonb_set(payload,'{value,cleartext}','"secret"')),'INVALID_ANALYSIS_PARTIAL');
  perform pg_temp.expect_error(format(statement,jsonb_set(payload,'{source_document_ids}',jsonb_build_array(manual))),'INVALID_ANALYSIS_PARTIAL_SOURCES');
  perform pg_temp.expect_error(format(statement,payload-'expected_analysis_revision'),'CUSTOMER_ANALYSIS_CHANGED');
  update public.projects set source_revision=2 where id=p;
  perform pg_temp.assert_true(public.read_customer_analysis_partial(p) is null,'source change hides preview');
  perform pg_temp.expect_error(format(statement,payload),'PROJECT_SOURCE_REVISION_CHANGED');
  update public.projects set source_revision=1 where id=p;
  insert into public.customer_analyses(project_id,revision) values(p,manual);
  perform pg_temp.assert_true(public.read_customer_analysis_partial(p) is null,'manual save hides preview');
  perform pg_temp.expect_error(format(statement,payload),'CUSTOMER_ANALYSIS_CHANGED');
  delete from public.customer_analyses where project_id=p;
  update public.project_jobs set locked_at=clock_timestamp()-interval '16 minutes' where id=j;
  perform pg_temp.assert_true(public.read_customer_analysis_partial(p) is null,'expired lease hides preview');
  perform pg_temp.expect_error(format(statement,payload),'PROJECT_JOB_LEASE_LOST');
  update public.project_jobs set locked_at=clock_timestamp() where id=j;
  insert into public.project_jobs(id,project_id,kind,status,submission_sequence) values(manual,p,'customer_analysis','queued',2);
  perform pg_temp.assert_true(public.read_customer_analysis_partial(p) is null,'new submission hides preview');
  perform pg_temp.expect_error(format(statement,payload),'PROJECT_JOB_SUPERSEDED');
  delete from public.project_jobs where id=manual;
  insert into public.project_analysis_requests(project_id,request_id,status,source_revision) values(p,request_id,'scheduled',1);
  update public.project_jobs set status='queued',lease_token=null where id=j;
  perform pg_temp.assert_true(not exists(select 1 from public.customer_analysis_partials where job_id=j),'requeue discards prior stream');
  update public.project_jobs set status='running',lease_token=lease,locked_at=clock_timestamp() where id=j;
  payload := payload || jsonb_build_object('automatic_request_id',request_id);
  perform public.save_customer_analysis_partial(p,j,lease,payload);
  update public.project_analysis_requests set status='cancelled' where project_id=p;
  perform pg_temp.assert_true(public.read_customer_analysis_partial(p) is null,'cancellation hides preview');
  perform pg_temp.expect_error(format(statement,payload),'AUTOMATIC_ANALYSIS_CANCELLED');
  update public.project_analysis_requests set status='scheduled' where project_id=p;
  update public.project_jobs set status='failed',lease_token=null,locked_at=null where id=j;
  perform pg_temp.assert_true(public.read_customer_analysis_partial(p)->>'job_status'='failed','later failure retains preview for reload');
  perform pg_temp.expect_error(format(statement,payload),'PROJECT_JOB_LEASE_LOST');
  update public.project_jobs set status='running',lease_token=gen_random_uuid(),locked_at=clock_timestamp() where id=j;
  perform pg_temp.assert_true(not exists(select 1 from public.customer_analysis_partials where job_id=j),'takeover discards prior stream');
  perform pg_temp.expect_error(format(statement,payload),'PROJECT_JOB_LEASE_LOST');
  select lease_token into lease from public.project_jobs where id=j;
  perform public.save_customer_analysis_partial(p,j,lease,payload);
  update public.project_jobs set result_checkpoint='{"kind":"customer_analysis"}' where id=j;
  perform pg_temp.assert_true(public.read_customer_analysis_partial(p) is null,'published checkpoint hides preview');
  perform pg_temp.expect_error(format('select public.save_customer_analysis_partial(%L,%L,%L,%L::jsonb)',p,j,lease,payload),'PARTIAL_ANALYSIS_NOT_ALLOWED');
  update public.project_jobs set status='completed',lease_token=null where id=j;
  perform pg_temp.assert_true(not exists(select 1 from public.customer_analysis_partials where job_id=j),'final completion removes preview');
  perform pg_temp.assert_true(not has_table_privilege('authenticated','public.customer_analysis_partials','SELECT'),'no direct authenticated reads');
  perform pg_temp.assert_true(not has_function_privilege('anon','public.read_customer_analysis_partial(uuid)','EXECUTE'),'no anonymous RPC');
  perform pg_temp.assert_true(not has_function_privilege('authenticated','public.save_customer_analysis_partial(uuid,uuid,uuid,jsonb)','EXECUTE'),'no authenticated write RPC');
  perform pg_temp.assert_true(has_function_privilege('service_role','public.save_customer_analysis_partial(uuid,uuid,uuid,jsonb)','EXECUTE'),'service RPC grant');
end $$;
