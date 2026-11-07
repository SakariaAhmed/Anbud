# Rebuild document chunks

Run from a repository checkout after `npm ci` in `apps/frontend`, using the
same Node version as CI. The command loads the serving application's chunk
builder, encryption, fingerprint and atomic replacement RPCs through Jiti.
It requires development dependencies and is not a command for the stripped
production runner image.

Supply `DATA_API_URL`, `DATA_API_SERVICE_ROLE_KEY` and `APP_ENCRYPTION_KEY`
through the authorized environment. No credential files are loaded. Keep the
existing encryption key; do not generate a new key for this command.

```sh
node scripts/backfill_document_chunks.mjs --help
node scripts/backfill_document_chunks.mjs --limit=10
node scripts/backfill_document_chunks.mjs --apply --target=https://YOUR-DATA-API-ORIGIN --limit=10
```

The first invocation is a dry run. `--limit` applies separately to project and
service documents; omit it to scan all sources with keyset pages. The exact
URL origin is required for writes, including the port on loopback targets.
Project documents that have not reached `basic_ready` or `enhanced_ready` are
skipped. A dry run counts eligible rows without decrypting or rebuilding them.

Writes use each source's current chunk revision. Source changes cause the
atomic replacement RPC to reject stale work; existing chunks are not deleted
before a separate insert. A failure leaves earlier successful source commits
in place. Inspect the target and source state before restarting the command.

By default this rebuilds lexical chunks without calling embedding models.
This can replace existing embeddings with lexical-only chunks. To generate
embeddings, explicitly supply the existing model configuration and
`OPENAI_API_KEY`, and add `--with-embeddings` to an authorized `--apply` run.
That option makes paid requests; a dry run never does. Follow the existing
retrieval evaluation gates before treating a rebuild as quality-verified.
