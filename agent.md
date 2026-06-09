# Agent Instructions

Dette prosjektet er en tilbudsapp ("bidsite") for kundeanalyse, dokumentopplasting, RAG-basert kontekst, tilbudsartefakter og prosjektsparring.

## Formål

Formålet med webappen er å gjøre skyarkitekter og bid managers mer produktive ved å gjøre det mulig å jobbe parallelt med flere prosjekter og bids samtidig, i stedet for å håndtere ett prosjekt eller bid om gangen.

## Teknisk mål

Målet er at kodebasen skal utvikles mot enterprise-nivå: robust, sikker, vedlikeholdbar og skalerbar. Når flere brukere introduseres, skal løsningen støtte integrasjon med Azure for drift, identitet, tilgangsstyring og videre skalering.

## Stack og struktur

- `apps/frontend` er hovedappen: Next.js 15, React 19, TypeScript strict, App Router og Tailwind CSS 4.
- `apps/frontend/app` inneholder sider og API-ruter.
- `apps/frontend/components` inneholder React-komponenter. Gjenbruk `components/ui` og eksisterende prosjektkomponenter for ny UI.
- `apps/frontend/lib/server` inneholder serverlogikk, AI-flyt, dokumentbehandling, Supabase-klienter, repositories og use-cases.
- `apps/frontend/lib/client` inneholder klient-API-er og browser-hjelpere.
- `supabase` inneholder SQL-skjema, migrasjoner og ytelses-/sikkerhetsrelaterte SQL-filer.
- `scripts` inneholder repo-skript for RAG/backfill/evaluering.
- `infra/azure` dekker deploy-oppsett.

## Arbeidsregler

- Les relevant kode før du endrer. Følg eksisterende mønstre fremfor å innføre nye abstraksjoner.
- Behandle arbeidskopien som delt med bruker. Ikke revert eller overskriv endringer du ikke selv har gjort.
- Hold endringer tett på oppgaven. Unngå brede refaktorer uten eksplisitt behov.
- Bruk `@/` imports i frontendkoden når det passer med eksisterende sti-alias.
- Hold TypeScript strict-kompatibelt. Unngå `any` med mindre en ekstern pakke tvinger det og du avgrenser bruken.
- Ikke legg hemmeligheter i repoet. Bruk `.env.example` som oversikt over nødvendige miljøvariabler.

## Lokale kommandoer

Kjør kommandoer fra `apps/frontend` med mindre annet er nevnt:

```bash
npm install
npm run dev
npm run build
npm run lint
npm run rag:backfill
npm run rag:eval
```

Nyttige repo-skript:

```bash
node scripts/backfill_document_chunks.mjs
node scripts/rag_eval.mjs scripts/rag_eval_cases.example.json
node scripts/llm_quality_eval.mjs
```

Bruk `npm run build` som primær verifisering etter endringer i appen. For rene dokumentasjonsendringer holder det normalt med ingen testkjøring, men si fra eksplisitt.

## Miljøvariabler

Se `.env.example`. Viktige verdier:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `APP_ENCRYPTION_KEY`
- `APP_ACCESS_PASSWORD`
- `APP_SESSION_SECRET`
- `OPENAI_API_KEY`
- `OPENAI_EMBEDDING_MODEL`
- `PROJECT_JOB_WORKER_TOKEN`
- `DOCLING_*` for avansert dokumentingest

Serverruter og repositories bruker service-role Supabase-tilgang. Ikke eksponer service-role-nøkler eller server-only kode til klientkomponenter.

## AI, dokumenter og RAG

- Dokumentflyten bygger på parsing, `raw_text`, `structure_map`, chunking, embeddings og Supabase/pgvector.
- Hold dokument-ID-er, prosjekt-ID-er, tilgangskontroll, cache keys, validering og sortering deterministisk i kode.
- Bruk LLM til generering, query rewrite, semantisk vurdering og språkforbedring, ikke til vilkårlig databasetilgang.
- Nye AI-flyter bør hente prosjektkontekst via eksisterende serverfunksjoner i `lib/server`, ikke ved å sende store råtekster ukritisk til modellen.
- Svar som bygger på kundedokumenter bør være kildebaserte når flyten støtter det.
- Bevar dokumentroller som `primary_customer_document`, `primary_solution_document` og `supporting_document`.

## Supabase og database

- Legg skjemaendringer i `supabase` som eksplisitte SQL-filer, og oppdater `supabase/schema.sql` når repoets praksis tilsier det.
- Vurder indeksbruk og RLS/sikkerhet ved nye tabeller eller spørringer.
- Ikke drop indekser eller endre produksjonskritiske tabeller uten audit eller tydelig begrunnelse.
- Kryptert dokumentinnhold og søkeindekser må behandles bevisst, særlig ved fulltekstindeks eller metadata som kan lekke sensitive ord.

## Frontend-konvensjoner

- Appen er norskspråklig. Hold brukerrettet tekst på norsk.
- Bruk eksisterende shadcn/base-nova UI-komponenter fra `components/ui`.
- Bruk lucide-ikoner når en knapp eller handling trenger ikon.
- Ikke lag landingssider for appfunksjoner; bygg den faktiske arbeidsflaten brukeren trenger.
- Hold arbeidsverktøy tette, skannbare og utilitaristiske. Unngå dekorative kortlag og markedsføringspreg i prosjektflater.
- Sørg for at tekst ikke overlapper eller sprenger knapper, faner, sidepaneler eller kort ved mobil og desktop.

## API og serverlogikk

- API-ruter ligger under `apps/frontend/app/api`.
- Hold validering, auth/session-sjekker og server-only kall i serverlaget.
- Gjenbruk repositories i `apps/frontend/lib/server/repositories` og use-cases i `apps/frontend/lib/server/use-cases`.
- Når en flyt kan bli langvarig, bruk eksisterende project-job-mønster i stedet for å blokkere UI unødig.

## Deploy

- Azure Container Apps-oppsett ligger i `infra/azure`; Dockerfile ligger i `apps/frontend/Dockerfile`.
- `/api/health` brukes som helseendepunkt.

## Verifisering før levering

- Kjør relevante kommandoer for endringen, normalt `npm run build` fra `apps/frontend`.
- For UI-endringer: start devserver og sjekk aktuell side i browser når mulig.
- For Supabase/RAG-endringer: vurder om backfill, eval eller SQL-verifisering trengs.
- Oppsummer hva som ble endret, hvilke filer som ble berørt, og hvilke verifiseringer som ble kjørt eller ikke kjørt.
