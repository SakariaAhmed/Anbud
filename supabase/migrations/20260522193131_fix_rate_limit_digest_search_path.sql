create or replace function check_app_rate_limit(
  p_scope text,
  p_identity_hash text,
  p_limit integer,
  p_window_ms integer
)
returns table (
  allowed boolean,
  retry_after_seconds integer
)
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_key text;
  v_count integer;
  v_reset_at timestamptz;
  v_window interval;
  v_limit integer;
begin
  v_limit := greatest(coalesce(p_limit, 1), 1);
  v_window := make_interval(secs => greatest(coalesce(p_window_ms, 1000), 1000) / 1000.0);
  v_key := encode(digest(coalesce(p_scope, '') || ':' || coalesce(p_identity_hash, ''), 'sha256'), 'hex');

  insert into app_rate_limits as limits (
    key,
    scope,
    identity_hash,
    count,
    reset_at,
    updated_at
  )
  values (
    v_key,
    coalesce(p_scope, ''),
    coalesce(p_identity_hash, ''),
    1,
    now() + v_window,
    now()
  )
  on conflict (key) do update
  set
    count = case
      when limits.reset_at <= now() then 1
      else limits.count + 1
    end,
    reset_at = case
      when limits.reset_at <= now() then now() + v_window
      else limits.reset_at
    end,
    updated_at = now()
  returning count, reset_at
  into v_count, v_reset_at;

  allowed := v_count <= v_limit;
  retry_after_seconds := case
    when allowed then 0
    else greatest(1, ceil(extract(epoch from (v_reset_at - now())))::integer)
  end;
  return next;
end;
$$;

grant execute on function check_app_rate_limit(text, text, integer, integer) to service_role;
revoke execute on function check_app_rate_limit(text, text, integer, integer) from anon;
revoke execute on function check_app_rate_limit(text, text, integer, integer) from authenticated;;
