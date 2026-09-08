# Hastighet og genereringskvalitet — pågående arbeid

**Målet om betydelig raskere funksjoner og bedre genereringer overalt er ikke
oppfylt. Ingen produksjonsutrulling er utført.** Siste applikasjonscommit er
`b65a512f` (siste AI-endring: `07b51e3e`). Store lokale forbedringer i lesing, lagring og klargjøring er målt,
men flere modellgenereringer er tregere og kvaliteten er ikke godkjent overalt.

Brukerens ønskede rekkefølge var hastighet → kvalitet → samlet regresjonskontroll.
Kvalitetsendringer ble gjort før hastighet for alle funksjoner var bekreftet.
Rapporten gir derfor ikke godkjenning av denne faseovergangen.

[Bevisregisteret](speed-quality-2026-09-08-evidence.json) beholder opprinnelig
44-parsmatrise og 14 nyere sammenligninger separat. Input-/kodehasher, providersvar,
dommer og råfiler er sporbare. Nye gjentakelser erstatter ikke eldre utfall.
Rådata i `output/speed-quality-2026-09-08/` er lokale og gitignored. Historiske
rapportversjoner finnes i git; metodefeil og mislykkede kjøringer er ikke slettet.

## Miljø og applikasjonsendringer

Baseline etter separat sikkerhetspatch er `3779e6f2`; opprinnelig main var
`f7abd3b583aca73a387fe760e28f4791b1838dcc`. Branch: `Feature/speed-quality`.
Node 22.14.0, eksisterende npm-låsfil, disponibel PostgreSQL 17/pgvector,
PostgREST og lokale HTTPS-proxyer med separate baseline-/kandidatdatabaser og
produksjonsbygg. Dette er ikke et etablert stagingmiljø eller produksjonsdata.

Endringene omfatter smalere prosjekt-/genereringsoppslag, SQL-snapshots, samlet
rolleoppslag, mindre unødvendig tekstarbeid og parallell henting av uavhengig
HLD-kontekst. Parseren bevarer krav-ID-er i overskrifter og fortellende tekst.
Kravsvar bevarer kildehenvisninger, forbehold og gjennomgangsmetadata. Enkeltbatcher
med høyst 18 krav bruker Luna; større batcher beholder GPT-5.4. Modelloverstyring,
opt-in, kilderevisjon og jobb-/leasekontroller er bevart.

Seksjonsregenerering skriver bare eide felt. HLD beholder Markdown og hele
avgrensede kildefakta. Avvik skal synliggjøres uten oppdiktet kundegodkjenning.
Ugyldig AI-output får en trygg, eksplisitt feil. Siste retting krever faktisk
migrerings-/bølgebeskrivelse før migreringskontroll legges til; applikasjonsantall
alene utløser den ikke. Eksakt fakta som allerede inngår ordrett i en lengre
kildetekst, gjentas ikke. Sene forbehold bevares. Responsive justeringer hindrer
mobiloverflyt på analyse-/artefaktflater.

## Budsjett og hele forbedringsløpet

Hard samlet grense: **14 USD**, inkludert embeddings, retries og dommere.
Siste avstemming: **467 registrerte kall, 13,329150 USD konservativ
kostnadsøvregrense, 0,670850 USD igjen og ingen uavklarte reservasjoner**.
Evalueringsproxyen er stoppet.
Dette er ikke endelig fakturert beløp.

Proxyen leser bare API-nøkkelen fra eksplisitt lokal nøkkelfil. Appen får en
plassholder; produksjonens data-/lagrings-/identitetskonfigurasjon lastes ikke.
Hvert kall reserverer bytebasert tokenøvregrense, maksimal output og 10 % margin
før videresending. Cachetreff antas aldri ved forhåndsreservasjon. Ukjente utfall
beholder hele reservasjonen. Samme logg og grense gjelder alle faser.

V3 korrigerte verifiserte korte Terra-/Luna-kall fra langkontekstpris. V4 priset
et eksplisitt lokalt Fast-forsøk med forespurt og returnert tier. V5 trekker bare
fra dokumenterte, konsistente cache-lesetokens etter fullført kall. Øvrig input
regnes fortsatt til maksimal cache-skrivepris, reasoning som output og 10 % margin.
Tvetydig metadata gir ikke rabatt. Originale ledgere før V3/V5 og avledede
manifester er bevart; forespørselsrader er ikke skrevet om. V5 korrigerte 92 av
437 daværende rader fra 13,608617 til 12,462544 USD før nyere kall.

Prisgrunnlag: [OpenAI-priser](https://developers.openai.com/api/docs/pricing),
[prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching),
[Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra),
[Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) og
[Fast](https://developers.openai.com/api/docs/guides/fast-mode).
Kortkontekst krever inputøvregrense + maksimal output under 256K, strengere enn
dokumentert 272K-terskel. Appens tierstandard er uendret.

Et komplett `perfect_system_solution`-par trenger nytt løsningsutkast,
kravdekning og helhetlig revurdering på begge sider. Bare outputdelen av full
reservasjon er minst
`2 × (8000 × 4,5 + 8000 × 15 + 16000 × 15) × 1,1 / 1000000 = 0,871200 USD`.
Dette overstiger 0,670850 USD før input, embeddings og retries. Det er en
konservativ reservasjonsberegning, ikke en påstand om faktisk fakturert kostnad.
Hele paret er derfor ikke startet på antatt lavere usage. Ingen outputgrenser,
modeller eller normal samtidighet er redusert for å få det til å passe.
Lagret utkast eller `pendingEvaluationResult` ville ikke alene vært fullføring;
ny vurdering må være lagret mot riktig artefakt og kilderevisjon.

## Korrigerte lokale målinger

Tidligere seeding krypterte feilaktig `generated_artifacts.content_markdown`,
som skal inneholde klartekst. Begge sider fikk samme feil. Tidligere lese-/skrive-
målinger og `browser-exports-paced-v2` er beholdt, men er ikke representative
klartekst-/formatbevis. Faktiske AI-fixturer, kravsvarjobben og dens PDF var uberørt.

Ny `plaintext-v3` har samme testprosjekt-/artefakt-ID-er, tidsstempler og innhold
på begge sider, med klartekst kontrollert gjennom HTTP. Dette betyr like
fixturer, ikke at alle andre DB-rader er identiske. Forsøk v1/v2 avdekket ulike
DB-genererte aktivitets-/medlemskapstider og er bevart. V3 avdekket bare ulik
objektnøkkelrekkefølge i `artifact_counts_by_type`. Sammenligningen kanoniserer
utelukkende objektnøkler; alle felt, verdier og arrayrekkefølger bevares.
Råhash beholdes separat; hashing skjer utenfor målt tid.

Endelig leseserie: **26 grupper × 30 vekslende par = 780 par**, alle bestått,
med identiske JSON-verdier og uten samtidige betalte kall. Store prosjekter har
400 kravrader og omtrent 692 KB vurdering. Lokale varme medianer, millisekunder:

| Operasjon | Før | Etter |
| --- | ---: | ---: |
| Stor prosjektdetalj | 348,87 | 61,02 |
| Stor artefaktoversikt | 336,65 | 47,89 |
| Stor autoritetsstatus | 329,41 | 45,66 |
| Tre store prosjektdetaljer samtidig | 414,35 | 101,55 |
| Tre store autoritetsoppslag samtidig | 362,07 | 54,39 |
| Stor løsningsvurdering, lesing | 104,16 | 43,05 |
| Stor lederoppsummering, lesing | 102,55 | 41,64 |
| Stor artefakt, PATCH | 768,51 | 91,24 |
| Stor artefakt, DELETE | 355,21 | 55,11 |
| Liten artefakt, PATCH / DELETE | 61,75 / 43,27 | 44,75 / 34,05 |
| Stor chat, klargjøring | 317,33 | 29,08 |
| Stor lederoppsummering, klargjøring | 322,02 | 27,84 |

Tre store detaljers p95 var 453,14→143,42 ms; autoritetsoppslag 397,60→65,06.
Skrivetestene har 30 prøver per side og 31 verifiserte gjenlesinger; før-serien
kjøres før etter-serien, og egne fixturer gjenopprettes. Klargjøringen har 30 par
og reduserer DB-lesinger fra 9/10 til 5; dette er ikke hele modellgenereringen.
Tilgangslisten er omtrent 31 ms begge sider, og stor listes p95 økte fra 36,90
til 46,84 ms. Jobbstatus/små tjenestelister er omtrent uendret.

## Videre leseforbedring etter første samlede kontroll

Commit `b65a512f` fjerner et forventet feiloppslag i prosjektmetadata. Gjeldende
skjema har `title/client_name`, mens koden først spurte etter
`name/customer_name/industry`. Lesingen henter nå den lille metadataraden én
gang og bruker eksisterende eksplisitt feltmapping. Det bevarer prioriteringen
av alternative navn og `industry` når begge kolonnesett finnes. Eier-ID og andre
interne felt sendes ikke ut gjennom mappingen. Dokument-/artefaktinnhold ligger
i andre tabeller. Tre runtime-regresjoner dekker gjeldende, alternativt og dobbelt
kolonnesett; testen på gjeldende skjema feilet på den faktiske ekstrarunden før retting.

Førmåling ble lagret før appendringen. Endelig `project-schema-read-only-v2.json`
har 30 vekslende par med samme fulle returverdier mot samme lokale DB:

| Repository-operasjon | Før → etter, median ms | DB-forespørsler |
| --- | --- | --- |
| Lite prosjekt, shell | 13,508 → 10,166 | 6 → 5 |
| Prosjektoversikt | 11,069 → 7,198 | 5 → 4 |
| Lite prosjekt, genereringsgrunnlag | 11,118 → 8,053 | 5 → 4 |
| Prosjektoppretting | 3,307 → 3,147 | 2 → 2; ingen retting/gevinst påstås |

**Metodepresisering:** `unstable_cache` er forbikoblet på begge sider, i tillegg
til at cacheinvalidering er stubbet. Råfilenes første scope-tekst nevnte bare
invalidering; denne presiseringen og en separat metodefil korrigerer beskrivelsen
uten å skrive om målingene. Dette er varme prosess-/DB-kall med ukachet funksjon,
ikke varm Next-cache, autentisert HTTP eller komplett brukeropplevelse. Opprettede
prosjekter fjernes direkte i disponibel DB utenfor målt tid; dette måler ikke
prosjektsletting. Bare ID og DB-genererte tidsstempler unntas ved sammenligning
av to nye prosjekter; alle andre opprettingsverdier sammenlignes.

En forsøksvariant snudde også INSERT-rekkefølgen og ga færre kall ved oppretting.
Den ble trukket tilbake fordi alternative/overlappende skjemaer ellers kunne få
endrede navne-defaults eller miste `industry`. De målingene er bevart med sin
opprinnelige kodehash som forkastet kandidat, ikke som sluttresultat.

Det nye produksjonsbygget ble i tillegg kontrollert med **120 autentiserte
HTTP-par**, sammenlignet med opprinnelig baseline `3779e6f2`, uten samtidige
betalte kall og med uendret ledger. Små detaljer: 41,426→32,984 ms; tre små
samtidig: 56,003→44,961 ms. Store detaljer: 345,552→54,682 ms; tre store samtidig:
403,513→89,356 ms. Alle JSON-verdier var identiske. Dette måler samlet endring
siden opprinnelig baseline; den isolerte ekstra gevinsten fra `b65a512f` er
repository-parene over. Tidligere 780-pars serie gjelder bygget før denne rettingen.

Etter rettingen bestod 903 frontendtester og 125 rottester, null feil/hopp,
med alle fire SQL-testvariabler mot disponibel PostgreSQL. Lint og nytt
produksjonsbygg bestod. Ingen modellkall, modellendring, migrasjon eller
produksjonsutrulling ble gjort i denne runden.

## Funksjons- og bevismatrise

Alle funksjoner er fortsatt i omfang. Modellresultater uten eksplisitt V5-merke
er fra den tidligere 44-parsmatrisen, ikke nye kjøringer på siste commit.
Enkelttider er ikke p95 eller sikker kausal effekt. Mini er en rådgivende dommer.

| Brukerfunksjon | Faktisk implementasjon | Før/etter-status |
| --- | --- | --- |
| Pålogging, bruker-/gruppe-/prosjekttilgang | auth-ruter, authorization, access-control-repository | Rolleoppslag 3→1 DB-kall; autentiserte ruter målt; full Entra-flyt og grupper med realistisk innhold gjenstår |
| Prosjektoversikt og oppretting/sletting | projects-ruter, data-store.listProjects/createProject/deleteProject | Oversikt 17,0→15,8 ms median, ingen stor gevinst; oppretting/sletting ikke målt |
| Prosjektdetalj og navigasjon | getProjectDetail/getProjectShell, felles klientcache | Korrekt klartekst: stor detalj 348,87→61,02 ms, 30 par; desktop/mobil kontrollert |
| Lesing/lagring av analyser og artefakter | customer-analysis/generate/artifact-authority-ruter | Korrekt klartekst: stor oversikt 336,65→47,89 ms; PATCH 768,51→91,24 ms; DELETE 355,21→55,11 ms |
| Tjenestebibliotek og valgte tjenester | service-descriptions-ruter og repositorium | Isolert repository/RPC, HTTP og browser-cache med tre tjenester/dokumenter bestod. Separate AI-par med katalogbeskrivelser: utvikling 7,872→8,050 s, holdout 4,250→3,121 s; begge likeverdige, holdout tom |
| Opplasting, parsing, indeksering, metadata og nedlasting | documents-ruter, documents.ts, document-chunks, dokumentjobber | Originalbytes ved HTTP-nedlasting bevart; parserregresjoner og liten offline AMD64-Docling-konvertering bestod. Ikke målt ende-til-ende; lokal Azure-lagring mangler |
| Chat med kilder/vedlegg | ai/project-chat.ts, chat-rute | Innlesingen har identiske argumenter og færre DB-kall. Siste modellpar 13,27→13,98 / 10,70→14,24 s; ingen samlet hastighets-/kvalitetsgodkjenning |
| Kundeanalyse | analyzeCustomerDocuments, legacy/v3 | Siste V5 legacy 60,923→61,709 / 56,551→52,956 s; v3 36,884→42,078 / 29,128→33,038 s. Ikke samlet kvalitetsgodkjent |
| Regenerering av analyseseksjoner | regenerateCustomerAnalysisSection | Alle ni seksjoner har frosne par på begge case. Eierreplay bevarer øvrige felt 18/18; kvalitet og hastighet er ikke forbedret overalt |
| Kravsvar/rekonstruksjon | bilag1_rekonstruksjon i generateProjectArtifact | Siste par 54,44→50,92 / 51,50→37,81 s. Kvalitetsdom positiv bare på holdout; ingen samlet godkjenning |
| Forbedret kravsvar | forbedret_kravsvar, repair/handoff | Siste enkeltbatch 31,17→17,04 / 38,60→22,98 s, begge kvalitetsvinnere. Faktisk jobb lagrer 8 krav/5 korrekte gjennomgangsflagg. 32-kravsmåling 92→55 s fra tidligere policykontroll; opt-in bevart |
| Løsningsutkast | losningsutkast | Siste par 11,54→6,83 / 7,78→5,48 s. Utviklingsavvik synliggjøres; holdout ikke godkjent av dommer |
| High-level design | generateHighLevelDesign | Siste V5-par 21,245→15,075 / 14,410→13,989 s; begge Mini-vinnere. Markdown og hele avgrensede kildefakta bevart |
| Tilbudsstrategi | tilbudsstrategi | Siste par 23,64→23,70 / 18,36→21,09 s; begge kvalitetsvinnere, ingen dokumentert hastighetsgevinst |
| Verdiargumentasjon | verdiargumentasjon | Siste par 10,72→13,27 / 6,88→9,54 s; begge kvalitetsvinnere, lengre svar og høyere tid |
| Anbefalt arkitektur | anbefalt_arkitektur | Siste par 14,57→12,67 / 10,71→15,42 s; holdout ikke godkjent, ingen samlet gevinst |
| Gjennomføring og risiko | gjennomforing_og_risiko | Siste par 17,41→12,33 / 15,43→11,76 s; begge kvalitetsvinnere. Bindende krav holdes fast ved avvik |
| Løsningsvurdering/kravdekning | evaluateSolutionDocument, direct-solution-evaluation | Tidligere små par 101,02→106,72 / 107,23→99,16 s, begge vinnere. Original Sundvik V5: 105,096→111,619 s; dekning 3→32 krav, kvalitetsvinner, tregere |
| Forbedringsløp | perfect_system_solution i project-workflows | Ikke kjørt som komplett før/etter-par; konservativ helreservasjon overstiger gjenstående budsjett |
| Lederoppsummering | ai/executive-summary.ts | Innlesingen halverer DB-kall. Siste modellpar 3,33→4,74 / 3,09→5,05 s; begge kvalitetsvinnere mot samme avledede vurdering, men tregere |
| Kø/status/SSE/avbrytelse | project-jobs, jobs-ruter, lease fencing | Kø/lease/lagring kontrollert med faktisk kravsvarjobb; standardgrense fortsatt én. Lokal SSE med to klienter, frakobling og terminalstatus bestod; ikke worker-avbrudd eller før/etter-latens |
| Eksport | komponentenes eksporthandlinger | 30 klare tekst-/listepar: MD 32,90→31,68 ms, Word 29,88→30,20 ms, PDF 570,81→566,60 ms; omtrent uendret. Separate funksjonskontroller av tabell og diagram |

## Siste kvalitetskontroller og metodegrenser

De ferske V5-parene for legacy, v3 og HLD har samme frosne input som baseline,
uendret kildegrunnlag og fullførte providersvar. Disse tre funksjonstypene er de
som kaller siste migreringsretting. Øvrige resultaters opprinnelige kodehasher
beholdes. Legacy-utvikling er Mini-vinner, holdout ikke godkjent. V3-holdout er
likeverdig, utvikling ikke godkjent. Begge HLD-par er vinnere.

Mini påstod at v3-utviklingen manglet K2/K4/K6. Uavhengig kildekontroll fant
alle tre i `expected_solution_direction[1..3]`: MFA også for konsulenter,
kvartalsvis gjenopprettingstest og månedlig kostnadsrapport per applikasjon med
avvik. Adjudikasjonsfilen bevarer utdrag, JSON-stier og hasher; originaldommen
er uendret. Dette avkrefter tre påstander, men gir ikke en samlet kvalitetsseier.

Sundvik-baseline fant bare 3 krav. Kandidaten fant **32/32**, alle 20 grovt
merkede motsigelser fikk «Dårlig», og L24/L31 fikk «Mangler». Graderingen er
ikke feilfri: flere øvrige krav mangler faktisk akseptansebevis, men skillet
mellom «Godt», «Uklart» og «Dårlig» er inkonsistent. Gullmerking ble ikke endret
for grønnere resultat. V4-forsøket stoppet på budsjettreservasjon etter delvis
dekning og er bevart som mislykket; V5 fullførte normalt med sju kall.

Ny tjenestefixture kopierer opprinnelige frosne input og endrer bare
`serviceCandidates`: to relevante tjenester og én irrelevant lønnstjeneste.
Utvikling valgte begge relevante ID-er på begge sider, holdout ingen. Øvrige
seksjonsfelt ble bevart. Dette er faktisk AI fra katalogbeskrivelser, men ikke
ett sammenhengende løp fra lagrede tjenestedokumenter til anbefaling. Tom holdout
beviser ikke kvalitetsforbedring. Holdout ble ikke brukt til prompttilpasning.

Fast-forsøket ga 45,765 s mot fersk standard 69,447 s med faktisk priority-tier.
Inputhashene var ulike, blant annet retrieval-score 75,77 mot 75,78. Råprompt er
ikke bevart, så dette beviser ikke at Fast alene ga forskjellen. Begge svar
predaterer siste migreringsretting. Appens tierstandard ble ikke endret.

Dommeren får nå bare kilder funksjonen faktisk har. 26 historiske dommer med
for bredt kildegrunnlag er beholdt, men utelatt som godkjenningsbevis. 18/18
seksjonskontroller kjørte faktisk eier med tidligere betalte normaliserte felt;
det er ikke nye providersvar. Små utvalg og dommerfeil hindrer samlet godkjenning.

## Regresjon og visuell kontroll

Etter siste appendring bestod **903 frontendtester + 125 rottester**, null feil
og null hopp, med alle fire SQL-testdatabaser på disponibel PostgreSQL. Lint og
produksjonsbygg bestod. Senere harnessendringer har **16 beståtte nettverksfrie tester**. Jobbskjema-,
workflowgrense- og releasekontroll, syntakskontroll av alle harnessfiler,
hemmelighetsskanning og whitespacekontroll bestod også.

Autentisert Chromium kontrollerte analyse/kravsvar på 1440/390 px uten JS-feil
eller horisontal overflyt. Ekte lokal kravsvarjobb gikk gjennom API, kø, lease,
generering og lagring. Dens PDF har to visuelt kontrollerte A4-sider med alle
åtte krav og fem varsler. Isolert servicedatabase med tre tjenester og krypterte
dokumenter testet repository/RPC, GET/PATCH, dokumentvisning, tastaturvalg,
SPA-cache, hard reload og kontrollert 503-tilbakeføring på desktop/mobil; den ble
fjernet. SSE testet to klienter, frakobling, heartbeat, terminalstatus og anonym
401. Dette er ikke worker-avbrudd.

Eksportserien `plaintext-v4` fullførte 30 par per format med identisk Markdown/
Word, to PDF-sider og SVG/PNG. Medianer i ms: MD 32,90→31,68, Word 29,88→30,20,
PDF 570,81→566,60. Tidene inkluderer automatisering og nedlasting, men ikke
1100 ms pause mellom nedlastinger. Seks faser, lister og forbehold er klartekst.
Tabellradene var feilaktig separert med blanklinjer og ble pipetekst; V4 er
ikke tabellbevis. Separat `table-functional-v6` fullførte ett par per format med gyldig GFM-tabell.
Alle åtte PDF-sider fra V4/V6 før/etter er rendret og visuelt kontrollert;
sidekommandoer og bildepiksler er identiske innen hvert par. V6-tabellen, seks
faser, forbehold og avslutning er leselige uten klipping. Eksportert Word-HTML
er identisk før/etter og rendret i Chromium; SVG/PNG har ni leselige noder.
Dette er ikke en ny 30-pars ytelsespåstand eller native Word-verifikasjon.

Første standalone-oppstart fikk assets kopiert etter oppstart og ga 404. Ny
oppstart etter kopiering ga 200 for alle kontrollerte referanser. Dette var
serveroppsett, ikke appendring. Feilede fixture-/selectorforsøk er beholdt.
ARM-/AMD64 runner-docling-smoke bestod. En liten digital PDF ble konvertert
offline på AMD64, ikke-root, med 12 fakta og proveniens fra tre sider. Emulert
24,48 s er ikke produksjonslatens; OCR og Azure-ingest inngikk ikke. Lokal
liveness var 200; readiness 503 grunnet manglende Azure-konfigurasjon.

## Gjenstående mål

- Betydelig hastighetsgevinst også for uendrede, tregere og umålte funksjoner,
  med representativ last og tilstrekkelige repetisjoner.
- Parvis kvalitetsgodkjenning av alle endelige genereringer på utvikling og
  holdout, inkludert uenige dommer og inkonsistent kravklassifisering.
- Hele forbedringsløpet med nytt utkast og lagret revurdering på begge sider,
  innen autorisert budsjett.
- Faktisk Azure/Entra/ingest, grupper, produksjonslik samtidighet og worker-
  avbrudd. Ingen produksjonsutrulling følger av denne rapporten.
