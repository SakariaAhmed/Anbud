# ANBUD

ANBUD er nå en smal Next.js-app for analyse av `Bilag 1` og `Bilag 2`.

## Hva appen gjør

- oppretter en sak
- laster opp `Bilag 1` og `Bilag 2` som `PDF`, `DOCX` eller `TXT`
- trekker ut krav fra Bilag 1
- bygger en kravmatrise
- lager en enkel kundeanalyse
- matcher krav mot leverandørens svar i Bilag 2
- viser et compliance-dashboard med `Besvart`, `Delvis besvart` og `Ikke besvart`

## Aktiv stack

- frontend + API: Next.js App Router
- database: Supabase Postgres
- AI: OpenAI API fra server-side route handlers

## Kom i gang

1. Kopier miljøfil:

```bash
cp .env.example .env
```

2. Sett nødvendige variabler:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY` valgfri, fallback-logikk finnes
- `OPENAI_MODEL` valgfri

3. Kjør ny database-schema i Supabase:

- [supabase/schema.sql](/Users/sakariaahmed/Code/anbud/supabase/schema.sql)

4. Start appen:

```bash
cd apps/frontend
npm install --legacy-peer-deps
npm run dev
```

5. Åpne:

- [http://localhost:3000](http://localhost:3000)

## Viktige filer

- [apps/frontend/app/page.tsx](/Users/sakariaahmed/Code/anbud/apps/frontend/app/page.tsx)
- [apps/frontend/app/bids/[id]/page.tsx](/Users/sakariaahmed/Code/anbud/apps/frontend/app/bids/[id]/page.tsx)
- [apps/frontend/app/api/v1/bids/[id]/analysis/route.ts](/Users/sakariaahmed/Code/anbud/apps/frontend/app/api/v1/bids/[id]/analysis/route.ts)
- [apps/frontend/lib/server/ai.ts](/Users/sakariaahmed/Code/anbud/apps/frontend/lib/server/ai.ts)
