# Chat history and memory migration

Apply `database/migrations/20261107090000_chat_session_history_and_memory.sql`
before promoting the new application. The release schema preflight requires
`chat_session_consistency_preflight()` to return `chat-session-consistency-v1`.
It checks the page indexes, canonical metadata columns, enabled message and
legacy-write guards, and encrypted memory CAS function without writing data.

Message inserts, deletes, and legacy session assignment maintain the exact
message count and latest preview in PostgreSQL. Older application versions may
still send stale counts and previews during rollout or rollback; those direct
values cannot replace the message-derived metadata. Migration replay repairs
metadata transactionally and preserves existing encrypted memory.

New versions append encrypted session memory through compare-and-swap, retrying
an explicit concurrent conflict with the newly stored summary. The RPC restores
its temporary write context on both success and failure. Direct blind summary
updates from older application versions are rejected with
`CHAT_MEMORY_CAS_REQUIRED`, so they cannot erase a successful modern append.
The old route already treats its summary update as optional after saving the
individual messages.

This is a compatibility boundary, not a guarantee of identical memory behavior
across old and new versions: turns completed solely by an old version remain in
the durable conversation and can be retrieved, but its rejected memory update
is not automatically replayed into the summary. An extended rollback therefore
leaves summary enrichment paused for those turns. Prefer a short overlap and
complete the rollout before relying on summary continuity. Repairing or
rebuilding summaries is separate work; this migration does not invent summaries
or call a model. Existing encrypted snapshot-only session IDs are materialized
lazily in bounded batches by the new application without changing their
original encrypted evidence.
