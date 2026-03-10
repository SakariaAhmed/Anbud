# ANBUD (Re-Architected)

ANBUD is now re-architected for simpler hosting:

- Frontend + API: **Next.js** (single app)
- Database: **Supabase Postgres**
- AI: **OpenAI API** (server-side via Next route handlers)
- Hosting target: **Netlify + Supabase** (no Docker required for production)

## What changed

The previous FastAPI + worker runtime is replaced for active product flows by Next.js route handlers under:

- `apps/frontend/app/api/v1/bids/*`

Implemented bid features in the new server layer:

- Create/list/get/update bids
- Document upload (PDF/TXT) + raw text storage
- AI intake autofill from document
- Bid chat grounded in uploaded documents
- Event log (`bid_created`, `document_uploaded`, `chat_question`, `chat_answer`)
- Notes create/list

## Setup (local without Docker)

1. Copy env file:

```bash
cp .env.example .env
```

2. Fill required values in `.env`:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY` (optional, fallback mode works without it)

3. Create DB schema in Supabase SQL editor:

- Run [`supabase/schema.sql`](./supabase/schema.sql)

4. Start frontend app:

```bash
cd apps/frontend
npm install
npm run dev
```

5. Open:

- Frontend + API: [http://localhost:3000](http://localhost:3000)

## Netlify deployment

`netlify.toml` is provided at repo root for Next.js deployment.

Environment variables to set in Netlify:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`
- `OPENAI_MODEL` (optional, default `gpt-5-mini`)
- `NEXT_PUBLIC_API_BASE_URL` (leave empty for same-origin)
- `NEXT_PUBLIC_SITE_URL` (your site URL)

## Notes

- Legacy FastAPI/Docker files are still in the repo for compatibility during migration, but the active bid UI now uses Next.js API routes.
- OpenAI calls are server-side only.
