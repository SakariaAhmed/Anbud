# Anbud

Anbud er en moderne Next.js-app for kundedokumentanalyse, løsningsvurdering, generator og prosjektbasert sparring i tilbudsarbeid.

Appen er laget for prosjekter der et tilbudsteam må forstå kunden raskt, avdekke eksplisitte og implisitte krav, vurdere hvor godt et løsningsutkast faktisk svarer, og generere sterkere strategier, verdiargumenter og utkast.

## Hva appen gjør

- oppretter prosjektarbeidsflater
- laster opp kundedokumenter, løsningsdokumenter og støttedokumenter
- parser `PDF`, `DOCX`, `TXT` og `Markdown`
- genererer strukturert kundeanalyse som JSON
- vurderer løsningsdokument mot kundebehov og analyse
- genererer nye artefakter som strategi, verdiargumentasjon og løsningsutkast
- tilbyr chat med prosjektkontekst og lagret prosjektminne

## Produktflate

- `/`
  Dashboard med prosjektoversikt og status
- `/projects/new`
  Opprett nytt prosjekt
- `/projects/[id]`
  Arbeidsflate med tabs for:
  - Dokumenter
  - Kundeanalyse
  - Løsningsvurdering
  - Generator
  - Chat

## Stack

- frontend + backend: Next.js App Router + TypeScript
- styling: Tailwind CSS
- database: Supabase Postgres
- AI: OpenAI API
- dokumentparsing: `pdf-parse`, `mammoth`
- kryptering av dokumentinnhold i backend før lagring i database

## Datamodell

V2 bruker disse konseptene:

- `projects`
- `documents`
- `customer_analyses`
- `solution_evaluations`
- `generated_artifacts`
- `chat_messages`

Hvert prosjekt kan ha:

- ett primært kundedokument
- ett primært løsningsdokument
- mange støttedokumenter

## Miljøvariabler

Kopier miljøfil:

```bash
cp .env.example .env.local
```

Sett disse variablene:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `APP_ENCRYPTION_KEY`
- `OPENAI_API_KEY`

## Viktig: database-reset

Kjør hele [supabase/schema.sql](/Users/sakariaahmed/Code/anbud/supabase/schema.sql) i Supabase SQL editor.

Denne fila:

- sletter gammel appdata
- dropper gamle `bid_*`-tabeller
- oppretter nytt v2-schema for prosjektappen

Det er en bevisst reset av databasen.

## Lokal oppstart

```bash
cd /Users/sakariaahmed/Code/anbud/apps/frontend
npm install
npm run dev
```

Åpne deretter `http://localhost:3000`.

## Verifisering

Følgende er verifisert i denne versjonen:

- `npm run build`
- `npx tsc --noEmit`

## Viktige filer

- [apps/frontend/app/page.tsx](/Users/sakariaahmed/Code/anbud/apps/frontend/app/page.tsx)
- [apps/frontend/app/projects/new/page.tsx](/Users/sakariaahmed/Code/anbud/apps/frontend/app/projects/new/page.tsx)
- [apps/frontend/app/projects/[id]/page.tsx](/Users/sakariaahmed/Code/anbud/apps/frontend/app/projects/[id]/page.tsx)
- [apps/frontend/app/api/projects/route.ts](/Users/sakariaahmed/Code/anbud/apps/frontend/app/api/projects/route.ts)
- [apps/frontend/app/api/projects/[id]/customer-analysis/route.ts](/Users/sakariaahmed/Code/anbud/apps/frontend/app/api/projects/[id]/customer-analysis/route.ts)
- [apps/frontend/app/api/projects/[id]/solution-evaluation/route.ts](/Users/sakariaahmed/Code/anbud/apps/frontend/app/api/projects/[id]/solution-evaluation/route.ts)
- [apps/frontend/app/api/projects/[id]/generate/route.ts](/Users/sakariaahmed/Code/anbud/apps/frontend/app/api/projects/[id]/generate/route.ts)
- [apps/frontend/app/api/projects/[id]/chat/route.ts](/Users/sakariaahmed/Code/anbud/apps/frontend/app/api/projects/[id]/chat/route.ts)
- [apps/frontend/lib/server/ai.ts](/Users/sakariaahmed/Code/anbud/apps/frontend/lib/server/ai.ts)
- [apps/frontend/lib/server/prompts.ts](/Users/sakariaahmed/Code/anbud/apps/frontend/lib/server/prompts.ts)
- [apps/frontend/lib/server/projects-db.ts](/Users/sakariaahmed/Code/anbud/apps/frontend/lib/server/projects-db.ts)
- [apps/frontend/lib/server/documents.ts](/Users/sakariaahmed/Code/anbud/apps/frontend/lib/server/documents.ts)
- [supabase/schema.sql](/Users/sakariaahmed/Code/anbud/supabase/schema.sql)
