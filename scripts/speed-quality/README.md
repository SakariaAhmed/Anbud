# Hastighets- og kvalitetskontroll, 2026-09-08

Dette er eksperimentharnessen for den avgrensede lokale kjøringen, ikke
applikasjonskode eller en produksjonsoperasjon. Se
[resultatrapporten](../../docs/speed-quality-2026-09-08.md) og
[bevisregisteret](../../docs/speed-quality-2026-09-08-evidence.json).

## Miljø og kostnad

Bruk Node 22 og frontendens eksisterende npm-avhengigheter. Skriptene kjøres fra
repo-roten; appens npm-kommandoer kjøres fra `apps/frontend`.

Kjøringen brukte disponibel lokal PostgreSQL 17/pgvector på port 55439,
PostgREST på 55440 og en separat baseline-DB på 55443. Lokale TLS-proxyer på
55441/55442 lot uendrede produksjonskontroller bruke HTTPS. Standalone Next-bygg
kjørte på 4318 (kandidat) og 4317 (baseline). Certifikater, DNS-preloader og de
tilfeldige lokale krypterings-/sesjonsnøklene er lokale forberedelser, ikke
produksjonskonfigurasjon. Baseline-koden er commit `3779e6f2`.

`output/speed-quality-2026-09-08/` er gitignored. Bevar originalfilene der;
eksakte modelleresultater og opprinnelig frossen analyse kan ikke rekonstrueres
bare ved å generere dem igjen. Bevisregisteret inneholder SHA-256-hasher.
`local-environment.json` inneholder bare lokale testnøkler, men skal likevel
aldri spores eller inkluderes i en rapportpakke.

Den samlede autoriserte grensen er fortsatt 14 USD. Gjeldende kostnadsøvregrense
står i rapporten og bevisregisteret. Ikke start en ny ledger for å omgå totalen.
Policy V3 korrigerte konservative langkontekstpriser for dokumentert korte Terra-
og Luna-kall; original ledger og avledede avstemmingsmanifester er bevart. Policy
V4 legger til eksplisitt priset Fast-forsøk. Ingen historisk forespørselsrad endres.
V5 avstemmer bare verifiserte cache-lesetokens etter fullført kall. Resten av input
beholder maksimal cache-skrivepris og 10 % margin; forhåndsreservasjonen antar
fortsatt null cachetreff. Original ledger før V5 og avledet manifest beholdes.

`budget-proxy.mjs` leser bare `OPENAI_API_KEY` fra en eksplisitt `--key-env`-fil;
den laster ikke andre variabler derfra. Hvert kall, retry og embedding reserveres
før videresending. Kun komplett validert usage kan erstatte en full reservasjon
med en konservativ kostnadsøvregrense. Ukjente utfall beholder reservasjonen.
Ikke kjør proxyer, genereringer eller dommere parallelt: per-operasjonstider og
request-ID-er ville da ikke være isolerte.
`--service-tier default` er standard; et eksplisitt `priority`-forsøk krever
forhåndsreservasjon til Fast-pris og logger faktisk returnert tier. Manglende eller
ukjent returnert Fast-tier beholder full reservasjon. Mini/Fast avvises; embeddings
bruker standard. Ingen av disse lokale proxyvalgene endrer applikasjonens tier.

## Verktøy og bevisgrenser

- `context-benchmark`, `auth-benchmark`, `snapshot-benchmark` og
  `generation-context-benchmark` måler faktiske avgrensede eiere. Dette er ikke
  modell-/nettleserlatens. SQL-fixturer må bare installeres i disponible databaser.
- `http-*` bruker autentiserte lokale Next-ruter. De sene `http-quiet-pairs`
  bruker separate DB-er med identiske testprosjekter og 30 vekslende par. Kjør uten samtidige
  bygg, skriving, browser-tester eller betalte kall. `--label=<navn>` bevarer
  tidligere målinger. Artefaktskrivingsharnessen muterer og gjenoppretter kun
  egne skrivefixturer; den må ikke brukes mot lesefixturer eller produksjon.
  Korrekt klartekst-serie bruker `--fixtures-label=plaintext-v3`, og skrivetesten
  bruker også `--paired-databases`. Historisk seeding krypterte feilaktig
  `content_markdown`; gamle målinger er derfor ikke representative klartekstbevis.
  `seed-local-read-fixtures --paired --label=<navn>` oppretter nye like fixturer
  på begge sider; `--for-writes` oppretter egne skrivefixturer. Tidligere data
  bevares. JSON-sammenligning kanoniserer bare objektnøkler, beholder alle verdier
  og arrayrekkefølger og registrerer separat råhash utenfor målt tid.
- `seed-local-*` muterer lokale fixturer. Live-seeding kan bruke betalte
  embeddings, og inkluderer parser, indeks, compiler og readiness-RPC. Den
  omgår Azure-opplasting og modellbasert metadata; dette er ikke full ingest-E2E.
- `freeze-generation-inputs` lagrer fulle inngangsobjekter. `generation-matrix`
  krever identiske frosne input, uendret kilde-revision og et nytt resultatnavn.
  Både funksjonsutfall og provider-completion må være gyldige.
  `freeze-service-inputs` lager en separat mekanisk kopi med tre fiktive
  `serviceCandidates`, uten å endre opprinnelig frossent grunnlag. Matrix/dommerkall
  med `--inputs=populated-services` må begge bruke samme nye inputfil. Dette er
  generering fra katalogbeskrivelser, ikke integrasjon med lagrede tjenestedokumenter.
- `judge-pairs` bruker nå `task-sources-v2`: dommeren får kun kilder som den
  faktiske funksjonen får. Kundeanalyse/seksjoner/HLD får ikke leverandørdokumentet;
  lederoppsummering får bare de avledede sammendragene den bruker. Historiske
  dommerfiler med feil kildegrense er beholdt, ikke godkjenningsbevis.
  Mini og GPT-5.4 er separate protokoller. Ingen enkel dommer er en fasit.
- `section-evidence` skiller vurdering av mål-felt fra deterministisk kontroll
  av øvrige felt. Bare seksjonens kontrakt, avledede nøkkelordtellinger og
  historikkhåndtering har lov å endres. `inspect-final-section-preservation`
  kjører faktisk eier uten nettverk med tidligere betalte, normaliserte mål-felt.
  Dette er ikke råprovider-replay eller ny live-kvalitet.
- `live-jobs` bruker ekte lokal auth, kø, lease, generering og lagring. Det siste
  artefaktløpet er én eksplisitt liten case, ikke throughput eller stor last.
- `browser-final-check` bruker separat headless Chromium og bare lokal fiktiv
  data. Sett `PLAYWRIGHT_MODULE` til en allerede installert Playwright-pakke hvis
  den ikke finnes i modulstien. `--label=<navn>` skiller QA-runder. Appgenerering
  klikkes ikke; PDF-eksport testes mot et eksisterende artefakt.
- `sse-local-check` oppretter og fjerner en egen lokal statusfixture. Den tester
  autentisering, to abonnenter, frakobling, heartbeat og terminalstatus uten
  worker eller modellkall. Dette er ikke et komplett jobbavbruddsløp.
- `populated-service-check` oppretter en egen tom database med kopiert skjema og
  tre fiktive tjenester med dokumenter. Den måler faktiske repository-eiere med
  Next-cache forbikoblet, og tester valg-RPC direkte. Container og database fjernes
  etterpå; de frosne AI-fixturene endres ikke. Dette er ikke AI-anbefalingskvalitet.
  `--http` legger til faktisk autentisert GET/PATCH med en egen standalone-runtime
  og diskcache på port 4320, samt isolert TLS-gateway på 55446. Det tester
  invalideringskallet og gjenlesing, ikke nettleserens cache.
  `--browser --label=<navn>` bruker samme isolerte miljø til autentisert Chromium
  på desktop og mobil. Den prøver tastaturvalg, dokumentvisning, SPA-gjenbesøk,
  hard reload og tilbakeføring ved en kontrollert 503, uten nye eiertidsmålinger.
- `browser-export-check --label=<navn>` bevarer fremdrift og delvise målinger ved
  feil. Det oppretter og fjerner et eget likt klartekstartefakt i begge DB-er,
  eksporterer i 30 vekslende par og legger
  inn 1100 ms mellom nedlastinger utenfor målt tid. Word er HTML-basert `.doc`,
  ikke `.docx`; PDF krever separat renderkontroll. Diagrammene har bare én
  funksjonskontroll hver. Tidligere upacet timeout beholdes som et uavklart forsøk.
  `--samples=1` er bare en funksjonskontroll og rapporterer ikke p95. V4-seriens
  tabell hadde blanklinjer mellom radene: behold den som tekst-/listeytelse.
  V6 har gyldig tabell i Word-HTML og visuelt kontrollert PDF. Delivery-siden
  viser bare uttrukne faser, så intro-tabellen kan ikke brukes som UI-selector.
- `docling-amd64-check` krever det allerede bygde, egne imaget
  `anbud-speed-quality-docling:amd64-20260908`. Det verifiserer faktisk AMD64 og
  ikke-root-bruker, og konverterer den eksisterende lille Nordic Utilities-PDF-en
  uten nettverk med CLI-argumenter fra appens parser. OCR er eksplisitt av for
  denne digitale PDF-en. Kjør den etter container-smoke med `--keep-image`, og
  fjern bare det egne imaget etter kontrollen. Emulert tid er ikke produksjonslatens.
- `write-result-index` skriver et kompakt avledet register. `--refresh` oppdaterer
  dette registeret eksplisitt; opprinnelige betalte resultater skal ikke endres.

Nettverksfrie tester av kostnadsregler, input-grenser og dommergrunnlag:

```sh
node --test scripts/speed-quality/*.test.mjs
```

Rapporten skiller dokumenterte forbedringer, mislykkede forsøk, metodefeil og
gjenstående dekning. Grønne tester, tomme tjenestelister eller et godt enkeltpar
betyr ikke at målet for alle funksjoner er oppfylt.
