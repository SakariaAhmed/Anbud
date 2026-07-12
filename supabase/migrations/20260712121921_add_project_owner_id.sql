alter table public.projects add column if not exists owner_id text;
create index if not exists projects_owner_activity_idx on public.projects(owner_id, last_activity_at desc);
comment on column public.projects.owner_id is 'Pseudonymous application user identifier derived from Entra; no email or name is stored.';
