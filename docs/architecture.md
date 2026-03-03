# ANBUD Re-Architecture (Netlify + Supabase)

## Stack

- Frontend + API: Next.js (App Router + Route Handlers)
- Database: Supabase Postgres
- AI: OpenAI API from server-side route handlers
- Hosting target: Netlify (single deploy unit) + Supabase

## Runtime model

The bid product now runs from one Next.js app:

- UI pages in `apps/frontend/app/*`
- API endpoints in `apps/frontend/app/api/v1/bids/*`

No FastAPI runtime or separate worker process is required for active bid flows.

## API surface

Implemented under `apps/frontend/app/api/v1/bids/*`:

- `GET/POST /api/v1/bids`
- `GET/PATCH /api/v1/bids/{id}`
- `POST /api/v1/bids/intake/autofill`
- `GET/POST /api/v1/bids/{id}/documents`
- `POST /api/v1/bids/{id}/chat`
- `GET /api/v1/bids/{id}/events`
- `GET/POST /api/v1/bids/{id}/notes`

## Data model (Supabase)

Schema SQL is in `supabase/schema.sql`.

Main tables:

- `bids`
- `bid_documents`
- `bid_events`
- `bid_notes`

## Event model

Normalized immutable events:

- `bid_created`
- `document_uploaded`
- `chat_question`
- `chat_answer`

## Service modules

- `lib/server/supabase.ts` service-role client
- `lib/server/ai.ts` intake extraction + bid chat answers (OpenAI + fallback)
- `lib/server/documents.ts` PDF/TXT extraction
- `lib/server/bids-db.ts` shared DB mapping + event/touch helpers

## Tenant scoping

All queries scope by `tenant_id` from `x-tenant-id` header, defaulting to `default`.
