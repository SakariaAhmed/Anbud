begin;
lock table public.chat_messages in share row exclusive mode;
-- Removed and restored inside this transaction so replay can repair old totals.
drop trigger if exists chat_session_metadata_guard on public.chat_sessions;

-- Messages own session counts/previews. Encrypted memory is still appended in
-- the application using compare-and-swap on the previous ciphertext.
alter table public.chat_sessions
  add column if not exists last_message_created_at timestamptz,
  add column if not exists last_message_id uuid;

create index if not exists chat_messages_session_page_idx
  on public.chat_messages(project_id, session_id, created_at desc, id desc)
  where session_id is not null;
drop index if exists public.chat_messages_project_session_idx;
create index if not exists chat_messages_legacy_session_idx
  on public.chat_messages(project_id, created_at, id) where session_id is null;

update public.chat_sessions s
set message_count = (select count(*) from public.chat_messages m
                    where m.project_id = s.project_id and m.session_id = s.id),
    last_message_preview = coalesce((select left(regexp_replace(m.content, '[[:space:]]+', ' ', 'g'), 120)
      from public.chat_messages m where m.project_id = s.project_id and m.session_id = s.id
      order by m.created_at desc, m.id desc limit 1), ''),
    last_message_created_at = (select m.created_at from public.chat_messages m
      where m.project_id = s.project_id and m.session_id = s.id
      order by m.created_at desc, m.id desc limit 1),
    last_message_id = (select m.id from public.chat_messages m
      where m.project_id = s.project_id and m.session_id = s.id
      order by m.created_at desc, m.id desc limit 1);

-- Older application versions still send client-derived counts and previews.
-- Only the nested message-maintenance trigger may change these derived fields.
create or replace function public.protect_chat_session_message_metadata()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'UPDATE'
     and new.summary_encrypted is distinct from old.summary_encrypted
     and coalesce(pg_catalog.current_setting('anbud.chat_memory_cas', true), '') <> 'on' then
    raise exception 'CHAT_MEMORY_CAS_REQUIRED: use encrypted memory append';
  end if;
  if pg_catalog.pg_trigger_depth() > 1 then return new; end if;
  if tg_op = 'INSERT' then
    new.message_count := 0;
    new.last_message_preview := '';
    new.last_message_created_at := null;
    new.last_message_id := null;
  else
    new.message_count := old.message_count;
    new.last_message_preview := old.last_message_preview;
    new.last_message_created_at := old.last_message_created_at;
    new.last_message_id := old.last_message_id;
  end if;
  return new;
end;
$$;
revoke all on function public.protect_chat_session_message_metadata() from public, anon, authenticated;
grant execute on function public.protect_chat_session_message_metadata() to service_role;
create trigger chat_session_metadata_guard
  before insert or update on public.chat_sessions
  for each row execute function public.protect_chat_session_message_metadata();

create or replace function public.track_chat_session_message()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  v_old_project uuid;
  v_old_session text;
  v_new_project uuid;
  v_new_session text;
  v_latest public.chat_messages%rowtype;
begin
  if tg_op <> 'INSERT' then
    v_old_project := old.project_id;
    v_old_session := old.session_id;
  end if;
  if tg_op <> 'DELETE' then
    v_new_project := new.project_id;
    v_new_session := new.session_id;
  end if;
  if tg_op = 'UPDATE' and v_old_project = v_new_project
     and v_old_session is not distinct from v_new_session then return new; end if;

  -- A consistent order also makes future session reassignment safe.
  perform 1 from public.chat_sessions s
  where (s.project_id = v_old_project and s.id = v_old_session)
     or (s.project_id = v_new_project and s.id = v_new_session)
  order by s.project_id, s.id for no key update;

  if v_old_session is not null then
    select * into v_latest from public.chat_messages m
      where m.project_id = v_old_project and m.session_id = v_old_session
      order by m.created_at desc, m.id desc limit 1;
    update public.chat_sessions set message_count = greatest(0, message_count - 1),
      last_message_preview = coalesce(left(regexp_replace(v_latest.content, '[[:space:]]+', ' ', 'g'), 120), ''),
      last_message_created_at = v_latest.created_at, last_message_id = v_latest.id
    where project_id = v_old_project and id = v_old_session;
  end if;
  if v_new_session is not null then
    update public.chat_sessions set
      message_count = message_count + 1,
      last_message_preview = case when last_message_created_at is null
        or (new.created_at, new.id) > (last_message_created_at, last_message_id)
        then left(regexp_replace(new.content, '[[:space:]]+', ' ', 'g'), 120) else last_message_preview end,
      last_message_created_at = case when last_message_created_at is null
        or (new.created_at, new.id) > (last_message_created_at, last_message_id)
        then new.created_at else last_message_created_at end,
      last_message_id = case when last_message_created_at is null
        or (new.created_at, new.id) > (last_message_created_at, last_message_id)
        then new.id else last_message_id end,
      updated_at = greatest(updated_at, new.created_at)
    where project_id = v_new_project and id = v_new_session;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.track_chat_session_message() from public, anon, authenticated;
grant execute on function public.track_chat_session_message() to service_role;
drop trigger if exists chat_message_session_metadata on public.chat_messages;
create trigger chat_message_session_metadata
  after insert or delete or update of session_id, project_id on public.chat_messages
  for each row execute function public.track_chat_session_message();


-- Ciphertexts can exceed URL limits, so CAS parameters travel in an RPC body.
create or replace function public.compare_and_swap_chat_session_memory(
  p_project_id uuid, p_session_id text, p_expected_summary text,
  p_summary text, p_domain_hints text[]
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  v_previous_context text := pg_catalog.current_setting('anbud.chat_memory_cas', true);
  v_updated boolean;
begin
  if p_summary is null or p_summary not like 'enc:v1:%' then
    raise exception 'Encrypted chat memory is required';
  end if;
  perform pg_catalog.set_config('anbud.chat_memory_cas', 'on', true);
  update public.chat_sessions set summary_encrypted = p_summary,
    domain_hints = p_domain_hints
  where project_id = p_project_id and id = p_session_id
    and summary_encrypted = p_expected_summary;
  v_updated := found;
  perform pg_catalog.set_config('anbud.chat_memory_cas', coalesce(v_previous_context, ''), true);
  return v_updated;
exception when others then
  perform pg_catalog.set_config('anbud.chat_memory_cas', coalesce(v_previous_context, ''), true);
  raise;
end;
$$;
revoke all on function public.compare_and_swap_chat_session_memory(uuid, text, text, text, text[])
  from public, anon, authenticated;
grant execute on function public.compare_and_swap_chat_session_memory(uuid, text, text, text, text[])
  to service_role;

-- Release guard only inspects catalogs; it never inserts synthetic chat data.
create or replace function public.chat_session_consistency_preflight()
returns text language plpgsql stable security invoker set search_path = '' as $$
begin
  if exists (
    select 1 from (values
      ('message_count', 'pg_catalog.int4'::regtype),
      ('last_message_preview', 'pg_catalog.text'::regtype),
      ('last_message_created_at', 'pg_catalog.timestamptz'::regtype),
      ('last_message_id', 'pg_catalog.uuid'::regtype)
    ) required(name, type_id)
    where not exists (
      select 1 from pg_catalog.pg_attribute a
      where a.attrelid = pg_catalog.to_regclass('public.chat_sessions')
        and a.attname = required.name and a.atttypid = required.type_id
        and a.attnum > 0 and not a.attisdropped
    )
  ) then raise exception 'CHAT_SESSION_SCHEMA_INCOMPLETE: count/preview columns'; end if;
  if exists (
    select 1 from (values ('chat_messages_session_page_idx'), ('chat_messages_legacy_session_idx')) required(name)
    where not exists (
      select 1 from pg_catalog.pg_index i
      where i.indexrelid = pg_catalog.to_regclass('public.' || required.name)
        and i.indrelid = pg_catalog.to_regclass('public.chat_messages')
        and i.indisvalid and i.indisready
    )
  ) then raise exception 'CHAT_SESSION_SCHEMA_INCOMPLETE: history indexes'; end if;
  if not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = pg_catalog.to_regclass('public.chat_messages')
      and t.tgname = 'chat_message_session_metadata' and not t.tgisinternal
      and t.tgenabled in ('O', 'A')
      and t.tgfoid = pg_catalog.to_regprocedure('public.track_chat_session_message()')
  ) then raise exception 'CHAT_SESSION_SCHEMA_INCOMPLETE: enabled metadata trigger'; end if;
  if not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = pg_catalog.to_regclass('public.chat_sessions')
      and t.tgname = 'chat_session_metadata_guard' and not t.tgisinternal
      and t.tgenabled in ('O', 'A')
      and t.tgfoid = pg_catalog.to_regprocedure('public.protect_chat_session_message_metadata()')
  ) then raise exception 'CHAT_SESSION_SCHEMA_INCOMPLETE: legacy metadata guard'; end if;
  if pg_catalog.to_regprocedure('public.compare_and_swap_chat_session_memory(uuid,text,text,text,text[])') is null then
    raise exception 'CHAT_SESSION_SCHEMA_INCOMPLETE: encrypted memory CAS';
  end if;
  return 'chat-session-consistency-v1';
end;
$$;
revoke all on function public.chat_session_consistency_preflight() from public, anon, authenticated;
grant execute on function public.chat_session_consistency_preflight() to service_role;

commit;
