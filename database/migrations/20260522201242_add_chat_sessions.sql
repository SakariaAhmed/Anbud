create table if not exists chat_sessions (
  id text not null,
  project_id uuid not null references projects(id) on delete cascade,
  title text not null default 'Ny chat',
  summary_encrypted text not null default '',
  domain_hints text[] not null default '{}',
  pinned boolean not null default false,
  status text not null default 'active' check (status in ('active', 'archived')),
  message_count integer not null default 0,
  last_message_preview text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, id)
);

alter table chat_sessions enable row level security;

revoke all on table chat_sessions from anon;
revoke all on table chat_sessions from authenticated;

create index if not exists chat_sessions_project_updated_idx
  on chat_sessions(project_id, pinned desc, updated_at desc);

alter table chat_messages
  add column if not exists session_id text;

alter table chat_messages
  drop constraint if exists chat_messages_project_session_fk;

alter table chat_messages
  add constraint chat_messages_project_session_fk
  foreign key (project_id, session_id)
  references chat_sessions(project_id, id)
  on delete cascade;

create index if not exists chat_messages_project_session_idx
  on chat_messages(project_id, session_id, created_at asc)
  where session_id is not null;;
