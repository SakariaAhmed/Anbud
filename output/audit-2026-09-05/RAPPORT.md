# Undersøkelse av ingestion, revisjoner og samtidige arbeidsflyter

**Dato:** 5. september 2026. **Kode:** `0ba4e687cb310fcd7bee152f2841125c0aea3b66`. **Resultat:** ti grupper med bekreftede feil, med de største konsekvensene knyttet til tap av manuell tekst/historikk og sletting av ferdige resultater. Ingen produktfikser, deploy eller endringer i ekte kundedata er gjort.

## Prioritering

P1 betyr høy prioritet på grunn av tap av brukerarbeid. P2 betyr feil status, unødvendig arbeid eller en arbeidsflyt som ikke fullfører konsistent. Dette er teknisk alvorlighet i de reproduserte løpene; testene måler ikke hendelsesfrekvens i produksjon.

| Funn | Alvorlighet | Bekreftet konsekvens | Nye tester |
|---|---|---|---|
| F1 | P1 | Sen kildeoppdatering sletter analyse, manuell tekst/historikk og nedstrømsresultater. Tjenesteendringer har global rekkevidde. | D1, D4, DOC success, UI3 |
| F2 | P1 | Full analyse prøver på nytt etter en manuell redigering og overskriver teksten uten å bevare historikken. | W1, W1F |
| F3 | P1 | Gammel editor godtas med serverens ferske revisjon og overskriver en nyere redigering. | API1 |
| F4 | P1 | Feilet lagring lukker editoren og forkaster utkastet. | UI1 |
| F5 | P2 | «Klart» og `indexed_at` publiseres før chunk-operasjonen er ferdig. | ING1 |
| F6 | P2 | Forbedring lagrer artefakt før revurdering; fase to kan feile eller utelates. | PERF1, PERF2 |
| F7 | P2 | Feil ved siste snapshot-henting får en vellykket lagring til å returnere feil. | W4 |
| F8 | P2 | Overlappende handlinger gir feil busy-status; prosjektet mangler felles adgangskontroll for ulike jobbtyper. | UI2, JOB1, JOB2, JOB3 |
| F9 | P2 | API godtar jobber uten nødvendige forutsetninger; arbeideren avviser sent med ugjennomsiktig hash. | API2 × 2, ERR1 |
| F10 | P2 | Nettfeil blir dokumentfeil lokalt, og forsinkede snapshots kan fjerne nyere resultater i UI. | NET1, UI4, UI5 |

**Tilleggsutløser under F1:** D2 og D2B bekrefter at også lagring uten endring i faglig innhold kan invalidere resultater. Denne utløseren vurderes P2 alene, men forsterker datatapet under F1.

## F1 — Ferdige resultater slettes når kilden oppdateres senere

**Kode:** [Docling publiserer nytt innhold](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/lib/server/use-cases/project-workflows.ts:1126), [dokumenttrigger og sletting](/Users/sakariaahmed/.codex/worktrees/0532/anbud/database/schema.sql:234), [trigger uten innholdssammenligning](/Users/sakariaahmed/.codex/worktrees/0532/anbud/database/schema.sql:295), [global tjenesteinvalidasjon](/Users/sakariaahmed/.codex/worktrees/0532/anbud/database/schema.sql:654), [klientens ingestion-overvåking](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/components/projects/project-workspace-page.tsx:675).

**Hendelsesforløp:** Et hoveddokument blir `basic_ready`. Brukeren genererer analyse, redigerer teksten og lager vurdering/oppsummering. Bakgrunns-Docling fullfører senere og oppdaterer `raw_text`/`structure_map`. Den faktiske workflowen holder dokumentet `basic_ready` mens parseren kjører. Triggeren sletter deretter radene i `customer_analyses`, `solution_evaluations` og `executive_summaries`. Historikken ligger i analyseraden og forsvinner sammen med den. Klienten følger første jobb, men ignorerer `docling_enhancement_job_id`.

**Forventet:** Endret grunnlag må gjøre resultater utdaterte, samtidig som brukerarbeidet og tidligere versjoner bevares og brukeren får vite hvorfor statusen endres.

**Faktisk/testbevis:** D1 og den faktiske Docling-workflowen med simulert parserresultat endrer antall rader fra `[1,1,1]` til `[0,0,0]`. UI3 viser at bare første jobb overvåkes. DOC parser_failure og D3 viser derimot at parserfeil uten innholdsutskifting bevarer alle tre radene. Det er altså ikke enhver Docling-feil som sletter resultatene.

D4 viser at innsetting av en tjeneste med `inclusion_mode='selected'`, uten prosjektvalg, også sletter de tre radene. SQL-funksjonen gjør dette for alle prosjekter. Det kan være riktig å invalidere avledede resultater når tjenestekandidatene endres; tapet av manuelle bidrag er fortsatt problemet. Testen bekrefter databasereaksjonen, ikke hvor ofte en tjenesteendring utløses i produksjon.

D2 viser at `SET title=title, raw_text=raw_text, structure_map=structure_map` sletter alle resultater. D2B bruker den ekte analyselagringen med uendret brukerinnhold og sletter vurdering/oppsummering. [Analysens siste triggerdefinisjon](/Users/sakariaahmed/.codex/worktrees/0532/anbud/database/schema.sql:4569) invalidiserer også uten semantisk endring.

**Anbefalt løsning:** Bevar tidligere analyser og manuelle seksjonsversjoner som historikk; marker dem som utdaterte med kildeversjon. Definer eksplisitt om `basic_ready` er stabilt nok til autoritativ generering, eller la senere forbedring opprette en ny kildeversjon. Overvåk oppfølgingsjobben. Unngå no-op-invalidasjon med deterministisk innholdshash/sammenligning før kryptering; sammenligning av tilfeldig kryptert tekst alene er utilstrekkelig.

## F2 — Retry kan overskrive en manuell redigering, også med gyldig lease

**Kode:** [hele kundeanalysen prøves på nytt](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/lib/server/use-cases/project-workflows.ts:1158), [`previousAnalysis: null`](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/lib/server/use-cases/project-workflows.ts:1224), [historikk ved manglende tidligere analyse](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/lib/customer-analysis-history.ts:226), [lease-RPC](/Users/sakariaahmed/.codex/worktrees/0532/anbud/database/schema.sql:2620).

**Hendelsesforløp:** En full analyse starter på revisjon R. Under AI-kallet lagrer en bruker en manuell endring; revisjonen øker. Første AI-lagring avvises riktig. Workflowen tolker også denne konflikten som grunnlag for automatisk nytt forsøk, leser siste kilder og lagrer en ny full analyse med `previousAnalysis: null`.

**Forventet:** Automatisk retry skal ikke innebære tillatelse til å overskrive nyere manuelle bidrag. De må bevares, flettes eller gi en eksplisitt konflikt.

**Faktisk/testbevis:** W1 kjører to AI-forsøk og erstatter den manuelle teksten. W1F reproduserer samme utfall med `lease_fenced_save_customer_analysis` i ekte PostgreSQL og en aktiv analysejobb. Den manuelle teksten finnes heller ikke i den lagrede historikken etterpå. Lease-vernet beskytter mot feil arbeider, men skiller ikke automatisk ingestion-endring fra manuell redigering.

**Anbefalt løsning:** Skill kilderevisjon fra analyse-/redigeringsrevisjon og årsak til endringen. Avbryt eller be om eksplisitt overskriving ved en nyere manuell revisjon. Bevar historikk ved full regenerering og test kombinasjonen med siste-jobb-autoritet.

## F3 — Manuell lagring validerer ikke editorens opprinnelige versjon

**Kode:** [PUT leser body](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/app/api/projects/[id]/customer-analysis/route.ts:532), [serveren tar nytt snapshot](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/app/api/projects/[id]/customer-analysis/route.ts:560), [denne revisjonen brukes ved lagring](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/app/api/projects/[id]/customer-analysis/route.ts:601), [klientens payload](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/lib/client/project-api.ts:722).

**Hendelsesforløp:** A åpner en seksjon. B lagrer nyere tekst. A lagrer sitt gamle utkast etterpå. Serveren leser nå B sin revisjon og bruker den som forventet revisjon for A sin forespørsel.

**Forventet:** En gammel klientversjon må gi konflikt eller en kontrollert sammenslåing.

**Faktisk/testbevis:** API1 kjører den ekte PUT-funksjonen, sender et gammelt `expected_source_revision` sammen med tekst, får 200 og overskriver B sin aktive tekst. Feltet ignoreres. B sin tekst bevares i historikken i denne manuell/manuell-varianten; dette er stille overskriving av aktiv tekst, ikke bevist permanent historikktap som i F2. Testen bruker støttet `analysis_text`; seksjonspayloaden går gjennom samme snapshot-/lagringsgrense.

**Anbefalt løsning:** Send editorens `analysis_revision` eller ETag og sjekk den atomisk. Returner 409 med bevaring av utkast. Vurder seksjonsvis revisjon dersom uavhengige seksjoner skal kunne redigeres samtidig.

## F4 — Feilet lagring forkaster utkastet

**Kode:** [`runAction` fanger feil uten å kaste videre](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/components/projects/project-workspace-page.tsx:1012), [editoren tømmer seg etter await](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/components/projects/project-analysis-tab.tsx:2996).

**Hendelsesforløp:** Brukeren lagrer en seksjon mens nettverket eller serveren feiler. `runAction` setter feilmeldingen og returnerer som en vellykket Promise. `onSaveSectionEdit` fortsetter, lukker editoren og setter utkastet til null.

**Forventet:** Editor og utkast skal forbli åpne og tilgjengelige for ny lagring.

**Faktisk/testbevis:** UI1 kjører begge originale callbackene sammen. Feilmeldingen blir satt, samtidig som `editingSection === null` og `sectionDraft === null`. Ingen nettleser er brukt; selve kontrollflyten er testet direkte.

**Anbefalt løsning:** Returner eksplisitt suksess/feil eller kast feilen videre fra `runAction`. Tøm utkast bare ved bekreftet lagring. Bevar gjerne et lokalt utkast gjennom oppfriskning.

## F5 — Dokumentet kan være «klart» før indeksoperasjonen er ferdig

**Kode:** [status og tidsstempel lagres først](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/lib/server/repositories/data-store.ts:3071), [chunk-operasjonen kommer senere](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/lib/server/repositories/data-store.ts:3148).

**Hendelsesforløp:** Ingestion/fullført Docling skriver dokumenttekst med `enhanced_ready` og `indexed_at`. En annen leser ser dette før `replaceProjectDocumentChunks` har fullført. Embedding-/chunk-operasjonen feiler, og dokumentet settes deretter til `failed`.

**Forventet:** Status som lover brukbar indeks skal først publiseres når den nødvendige indeksversjonen faktisk finnes.

**Faktisk/testbevis:** ING1 kjører den ekte repository-funksjonen og lease-fencede dokument-RPC-en. Inne i den injiserte chunk-operasjonen observerer en separat SQL-lesning `enhanced_ready`, et satt `indexed_at` og null chunks. Etter den injiserte feilen er status `failed` og tidsstempelet null. Ingen RAG-/LLM-generering ble kjørt i dette vinduet; feil generert tekst er derfor en mulig følge, ikke et testresultat.

**Avgrensning:** Metadatafiksen holder nå det vanlige hovedkundedokumentet i `processing` gjennom denne delen. ING2 og META bekrefter dette. Andre klare statuser, blant annet Docling-forbedring, har fortsatt vinduet. Dokumentintelligence-laget er valgfritt og fanger egne feil; manglende valgfri evidence er ikke i seg selv rapportert som en feil.

**Anbefalt løsning:** Skriv innhold som `processing`, erstatt chunks med revisjonsvern og publiser klar status i en avsluttende atomisk operasjon som verifiserer indeksrevisjon. Sett `indexed_at` først der.

## F6 — «Forbedre systemløsning» kan fullføre bare første fase

**Kode:** [artefakt genereres og lagres](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/lib/server/use-cases/project-workflows.ts:1564), [revurdering starter etterpå](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/lib/server/use-cases/project-workflows.ts:1587), [tidlig suksess uten revurdering](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/lib/server/use-cases/project-workflows.ts:1593).

**Hendelsesforløp:** Ny løsning lagres. Henting av revurderingsgrunnlag feiler eller en nødvendig kilde/analysen har forsvunnet før fase to.

**Forventet:** Brukeren skal få presis delstatus og kunne fortsette revurderingen av samme artefakt. En fullført forbedringsjobb må ikke implisere at revurdering også er fullført når den mangler.

**Faktisk/testbevis:** PERF1 viser en workflow som kaster feil etter en reell artefakt-INSERT; artefakten og de eldre downstream-radene eksisterer fortsatt. PERF2 viser retur uten feil med bare artefakt og prosjekt når grunnlaget mangler. Generatoren og fase-to-lesningen er injiserte IO-grenser i disse testene.

**Viktig begrensning:** Testene beviser delvis lagring og manglende revurdering. De beviser ikke at gammel vurdering/oppsummering blir presentert som gjeldende. Koden har provenance-/currentness-kontroller, og dette er svakere enn den tidligere hypotesen om «gammel vurdering vises som gyldig». Ekte modelltimeout midt i revurdering og automatisk gjenopptakelse av hele denne workflowen er ikke kjørt.

**Anbefalt løsning:** Modellér fasene eksplisitt, lagre artefakt-ID som checkpoint og gjenoppta vurderingen av samme versjon. Vis `revurdering gjenstår`/delvis fullført. Ikke returner vanlig suksess ved manglende grunnlag. Bevar eksisterende lease- og idempotensvern.

## F7 — Sluttlesning kan gjøre en lagret analyse til en feilrespons

**Kode:** [snapshot hentes etter lagring](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/lib/server/use-cases/project-workflows.ts:1233), [arbeiderens feilklassifisering](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/lib/server/project-jobs.ts:796), [samme mønster i manuell PUT](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/app/api/projects/[id]/customer-analysis/route.ts:617).

**Hendelsesforløp:** Analyse-RPC-en committer. Den etterfølgende prosjektlesningen feiler med nett-/databasefeil. Workflowen kaster feil selv om analysen er lagret.

**Forventet:** Allerede lagret resultat må identifiseres som lagret; en valgfri UI-oppfriskning skal kunne prøves separat.

**Faktisk/testbevis:** W4 lagrer i ekte PostgreSQL, injiserer timeout bare i siste `getProjectSnapshot`, observerer avvist workflow og verifiserer at analysen fortsatt finnes med riktig tekst. At en vanlig slik feil blir `failed`/`result:null` hos arbeideren følger av den leste catch-grenen; selve terminalskrivingen er ikke kjørt ende til ende i W4.

**Anbefalt løsning:** Skill resultatcommit fra best-effort snapshot. Returner/checkpoint lagret resultat-ID og la klienten hente prosjektstatus på nytt. Test gjenopptakelse etter feil mellom commit og terminalrapportering slik at det ikke genereres en ny variant unødvendig.

## F8 — Busy-status og jobbgrenser beskytter ikke en samlet prosjektflyt

**Kode:** [én busy-streng](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/components/projects/project-workspace-page.tsx:346), [handlingens finally nullstiller](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/components/projects/project-workspace-page.tsx:1027), [faner sjekker egen jobbtype](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/components/projects/project-workspace-shell.tsx:770), [egen kontroll for vurdering](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/components/projects/project-workspace-shell.tsx:808), [prosesslokal scheduler](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/lib/server/project-jobs.ts:113), [ingestion går utenom](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/lib/server/project-jobs.ts:158), [DB-deduplisering](/Users/sakariaahmed/.codex/worktrees/0532/anbud/database/schema.sql:3273).

**Hendelsesforløp:** A starter analyse. B starter en annen handling, via fane, bruker eller replika. Første handling fullfører mens den andre fortsatt kjører.

**Forventet:** UI må beholde status for alle aktive handlinger. Backend må ha en eksplisitt prosjektpolicy for konflikter mellom generering og kildeendringer, uavhengig av nettleser og replika.

**Faktisk/testbevis:** UI2 kjører de originale `runAction`-callbackene overlappende og viser `busy=null` før jobb B er ferdig. JOB1 køer tre forskjellige jobbtyper i samme prosjekt. JOB2 bekrefter at identisk aktiv input dedupliseres, men ulik modell gir ny jobb. JOB3 kjører den ekte schedulerkoden med to separate globale tilstander; to tunge jobber overlapper selv med grense 1 per tilstand.

**Avgrensning:** JOB3 er en modell av prosessisolasjonen rundt ekte schedulerkode, ikke en Azure-belastningstest. Samtidig kjøring er ikke automatisk datakorrupsjon: nyere-jobb-fencing og revisjonskontroller finnes og eksisterende tester består. Konsekvensene som er direkte bevist her er feil UI-status, adgang til konkurrerende arbeid og mekanismer som muliggjør F1/F2/F7.

**Anbefalt løsning:** Spor aktive handlinger med ID/antall og avled busy fra relevante konflikter. Definer hvilke jobbkombinasjoner som kan kjøre sammen og håndhev dette atomisk per prosjekt. Bevar parallellitet mellom uavhengige prosjekter og eksisterende revisjonsvern.

## F9 — Forutsetningsfeil oppdages etter at jobben er godtatt og skjules bak hash

**Kode:** [API velger jobbtype](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/app/api/projects/[id]/jobs/route.ts:62), [202-respons](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/app/api/projects/[id]/jobs/route.ts:142), [vurderingens sene krav](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/lib/server/use-cases/project-workflows.ts:1322), [oppsummeringens sene krav](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/lib/server/use-cases/project-workflows.ts:1501), [produksjonsfeilmelding](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/lib/server/safe-errors.ts:66).

**Hendelsesforløp:** Prosjektet mangler kundeanalyse eller vurdering. Klienten kaller jobb-API direkte, fra gammel UI-tilstand eller etter samtidig invalidasjon. Serveren svarer 202; arbeideren finner først senere at forutsetningen mangler.

**Forventet:** Kjent manglende grunnlag skal avvises tidlig med presis og handlingsrettet 409/422-status. Arbeideren må fortsatt sjekke på nytt for samtidige endringer.

**Faktisk/testbevis:** API2-testene kjører den originale POST-funksjonen, køwrapperne, ekte enqueue-RPC og de relevante workflowenes innledende validering. Begge får 202 før kjent precondition-feil. Auth/rate-limit er injisert som tillatt i denne testen; dette er ikke en test av middleware. ERR1 bekrefter at følgende kjente feil blir støttehash i produksjonsmodus:

| Feil | Reprodusert hash |
|---|---|
| Kilderevisjon endret | `4df10a8f27dea78363160c57` |
| Kundeanalyse mangler | `b408d4abe1e43f2086a8aabb` |
| Vurdering mangler | `b5ccf74d416a4f5a431e6f74` |

Dette verifiserer hash-mappingen, ikke hvem som utløste historiske logghendelser. Produksjonslogger er ikke brukt til å attribuere handlinger til kunder.

**Anbefalt løsning:** Innfør typede, tillatte domenefeil med HTTP-status og norsk veiledning. Kontroller kjente forutsetninger ved enqueue, og gjenta kontrollen i arbeideren. Behold hash/redigering av detaljer for ukjente interne feil.

## F10 — Transportfeil og gamle snapshots gir uriktig lokal dokument-/analysestatus

**Kode:** [polling uten retry rundt fetch](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/lib/client/project-api.ts:283), [watcher markerer dokument failed ved catch](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/components/projects/project-workspace-page.tsx:775), [gammelt jobbsnapshot brukes på dagens state](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/components/projects/project-workspace-page.tsx:752), [snapshot overskriver flags og nuller analyse](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/components/projects/project-workflow-status.ts:125).

**Hendelsesforløp A:** Én midlertidig polling-feil avbryter overvåkingen. Dokumentjobben kan fortsatt kjøre eller allerede være ferdig på serveren. Klienten markerer likevel dokumentet som `failed`.

**Hendelsesforløp B:** En annen fane har fullført analyse. Et forsinket svar fra en eldre ingestion-jobb inneholder `customer_analysis_generated=false`. Dette gamle snapshotet legges oppå den nyere lokale tilstanden.

**Forventet:** Skill kontaktproblemer fra serverbekreftet jobbfeil. Ikke la et eldre snapshot erstatte nyere prosjektstatus.

**Faktisk/testbevis:** NET1 viser at første fetch-feil avslutter polling. UI4 viser at watcher-catch markerer et lokalt `basic_ready`-dokument som `failed` uten en serverrapportert feil. UI5 kjører ekte watcher og `applyProjectSnapshot`; nyere analyseobjekt blir null og flagget false etter gammelt svar. React-rendering, reelle nettbrudd og flere nettleserfaner er ikke kjørt.

**Anbefalt løsning:** Bruk begrenset retry/reconnect og egen status «Mistet kontakt – sjekker igjen». Hent ferskt snapshot ved terminal jobbstatus, eller avvis snapshots med eldre monoton revisjon. Prosjektets artefaktautoritet har allerede en request-sequence-kontroll; gi analyse-/dokumentflyten tilsvarende vern.

## Vern som ble verifisert, og hypoteser som ikke skal regnes som funn

- META kjører den aktuelle ingestion-workflowen og bekrefter `processing` både under inferens og under metadataoppdatering, før sluttstatus blir `enhanced_ready`.
- W2 bekrefter én vellykket retry med nye dokumenttekster når kilden endres under analysen. W3 bekrefter at to konflikter stopper uten å lagre en stale analyse. D5 bekrefter atomisk avvisning av en gammel revisjon.
- ING3 kjører ekte lease-RPC etter takeover og bekrefter at gammel arbeider ikke skriver dokumenttekst. ING4 bekrefter at et slettet dokument ikke gjenopprettes.
- ING5 bruker den faktiske `set_primary_project_document`-RPC-en til å bytte hoveddokument mens gammel ingestion fortsatt har den gamle rollen i input. Repositoryet beholder den nye rollen og bruker den ved chunking. En direkte demotion-UPDATE er med hensikt avvist av kompatibilitetsvernet; den ble erstattet med korrekt RPC i testfixturen.
- DOC parser_failure og D3 bevarer basic-innhold og resultater når forbedringsparseren feiler uten innholdsutskifting.
- Identiske aktive forespørsler dedupliseres. Eksisterende tester dekker også nyere-jobb-autoritet, foreldre-/barnelåsing, gamle leases, gjenopptakelse, idempotente oppfølgingsjobber og atomisk terminalaudit. Disse bestod.
- Det er ikke bekreftet at gamle artefakter eller vurderinger kan passere currentness-kontrollene som gjeldende. Det er heller ikke bekreftet at eldre deployjobber omgår dagens claim-/lease-vern.

## Testmiljø, resultater og reproduksjon

Den siste samlede kjøringen var `node apps/frontend/lib/server/audit-20260905/run.mjs --full`.

| Testgruppe | Bestått | Feilet | Hoppet over |
|---|---:|---:|---:|
| Eksisterende tilgangstester | 54 | 0 | 0 |
| Eksisterende tjenestetester | 2 | 0 | 0 |
| Eksisterende adaptertester | 14 | 0 | 0 |
| Eksisterende hovedsuite | 776 | 0 | 0 |
| Jobb-/Azure-/migrasjonskontrakter | 37 | 0 | 0 |
| Nye reproduksjoner og kontroller | 34 | 0 | 0 |
| **Totalt** | **917** | **0** | **0** |

`REPRO`-tester forventer den observerte feilatferden. Grønne reproduksjoner er bevis på at feilen finnes. `CONTROL`-tester forventer vern som allerede skal virke. De nye filene passerer ESLint med `--max-warnings=0`.

Testene kjørte mot en ny disponibel PostgreSQL 17-container med pgvector 0.8.1 og hele det kanoniske `database/schema.sql`. Ingen DB-test ble skipped. [Miljømetadata](/Users/sakariaahmed/.codex/worktrees/0532/anbud/output/audit-2026-09-05/test-environment.json) angir nøyaktig versjon. Lokal Node var 23.7.0; CI bruker 22.14.0. `npm ci --ignore-scripts` ga en engine-advarsel for en ESLint-avhengighet, men testene og avgrenset lint fullførte.

[Harnessen](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/lib/server/audit-20260905/harness.mjs) henter originale funksjonskropper med TypeScript AST. Den utfører faktiske workflows/callbacker og reelle SQL-RPC-er/triggere. Parser/AI, transport, cache, keyword-ekstraksjon og enkelte IO-hjelpere er kontrollert injisert; PERF-generering er en fixture med virkelig INSERT. Dette er ikke en egen implementasjon av revisjonslogikken, men heller ikke en komplett nettleser-/PostgREST-/modellintegrasjon.

Ingen produktkode ble endret, derfor ble ingen ny Next-produksjonsbuild eller UI-visuell verifisering kjørt. Hele appens lint ble ikke kjørt; lint var avgrenset til nye `.mjs`-filer. Sletting, feilinjeksjon og global tjenesteinvalidasjon traff bare disponible lokale databaser. Kjøreren fjerner sin container etterpå.

**Artefakter:** [Testkode](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/lib/server/audit-20260905/reproduction.test.mjs), [kjører](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/lib/server/audit-20260905/run.mjs), [kjøreveiledning](/Users/sakariaahmed/.codex/worktrees/0532/anbud/apps/frontend/lib/server/audit-20260905/README.md), [nye testresultater](/Users/sakariaahmed/.codex/worktrees/0532/anbud/output/audit-2026-09-05/reproduction-tests.log), [eksisterende testresultater](/Users/sakariaahmed/.codex/worktrees/0532/anbud/output/audit-2026-09-05/existing-tests.log), [kontraktresultater](/Users/sakariaahmed/.codex/worktrees/0532/anbud/output/audit-2026-09-05/contracts-tests.log).

## Nåværende deploy og gjenstående usikkerhet

Arbeidskopien var ren ved oppstart. Prosjektinstruksjonene ble lest fra `agent.md`; ingen `AGENTS.md` ble funnet i repositoryet eller overliggende kataloger. Brukerens tidligere nevnte auth-/layoutendringer fantes ikke som lokale endringer her, og disse filene er ikke rørt.

Read-only Azure-kontroll 5. september viste:

- Web og arbeider bruker samme image: `sha256:36d559964d2192d617ed4a252d6394662a546ae0e7408b217a6b1bfdd1037e34`.
- ACR knytter imaget til taggen `0ba4e687cb310fcd7bee152f2841125c0aea3b66`, opprettet 2. september 2026 kl. 13:13 UTC.
- Aktiv webrevisjon `anbud--authadmin-20260905` er `Healthy` og har 100 % trafikk. Revisjonsnavnet alene sier ikke at ny produktkode er deployet; imaget matcher fiksen.
- Både web og arbeider har `DOCLING_ENHANCEMENT_MODE=async`, `DOCLING_ASYNC_AUTO_RUN=off` og `DOCUMENT_ANALYSIS_VERSION=off`. Auto-run av er ikke det samme som at køet forbedring aldri kjøres: den vanlige arbeideren kan hente køjobber. Dockerfile/byggeworkflow angir Docling på for `runner-docling`; faktisk effektiv image-env ble ikke lest fra en kjørende container.

[Deploybevis](/Users/sakariaahmed/.codex/worktrees/0532/anbud/output/audit-2026-09-05/deploy-verification.json), [web-konfigurasjon](/Users/sakariaahmed/.codex/worktrees/0532/anbud/output/audit-2026-09-05/azure-web.json) og [arbeiderkonfigurasjon](/Users/sakariaahmed/.codex/worktrees/0532/anbud/output/audit-2026-09-05/azure-worker.json) inneholder bare utvalgte ikke-hemmelige felt. Produksjonsdatabasen og kundelogger ble ikke lest. Det er derfor ikke verifisert at deployet databaseskjema er identisk med det kanoniske lokale skjemaet, eller at noen av de nye funnene faktisk har rammet en kunde.

Følgende gjenstår som **uverifiserte risikoer**, ikke bekreftede feil: ekte flerbruker/flerreplika-belastning; refresh midt i en jobb; SSE som reconnecter lenge etter mottatt første event; reopplasting med samme fil mens gammel jobb kjører; rollebytte mens gammel metadata-inferens fortsatt pågår; ekte modelltimeout i fase to av forbedring; og gjenopptakelse etter commit men før terminalaudit. Disse bør testes med egne testbrukere og disposabelt prosjekt før en eventuell retting godkjennes for produksjon.
