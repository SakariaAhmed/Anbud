# Regresjoner for arbeidsflyt og samtidighet

Testene startet som reproduksjoner i audit 5. september 2026. De krever nå rettet oppførsel og dekker F1–F10 i rapporten.

```sh
node apps/frontend/lib/server/audit-20260905/run.mjs --full
```

Krever Docker, psql, Node og frontendavhengighetene. Kjøreren bruker en unik, disponibel PostgreSQL 17/pgvector-container på localhost, og fjerner den i finally. Ingen kundedata, produksjonsendepunkter eller LLM-kall brukes. Loggene skrives til output/remediation-2026-09-05. CI kjører regresjonene og migreringstesten separat fra den ordinære testsuiten.

Med --full kjøres også npm test og repoets utrullingskontrakter. Migreringen kjøres to ganger mot forrige skjema med eksisterende syntetisk analyse; innholdet skal bevares. Derfor trengs Git-historikken for baselinecommit 0ba4e687cb310fcd7bee152f2841125c0aea3b66.

Harnessen henter funksjonskropper direkte fra TypeScript/React-koden. IO injiseres; SQL/RPC-er, kryptering, domeneregler og historikk kjøres faktisk. UI-callbacktestene erstatter ikke nettlesertesting. Concurrency-testen bruker to samtidige PostgreSQL-sesjoner. Checkpoint-testene tester atomiske lagringer og gjenfinning av resultater etter avbrudd. En separat lokal nettleserkontroll bruker ekte Next, React og PostgREST med syntetiske data.
