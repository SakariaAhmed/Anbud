# Hastighet og genereringskvalitet — pågående arbeid

**Målet om betydelig raskere funksjoner og bedre genereringer overalt er ikke
oppfylt. Ingen produksjonsutrulling er utført.** Applikasjonsversjonene er merket ved hver måleserie. `766799a1` innførte
raskere første chatspørsmål; den påfølgende chatrettingen er dokumentert nederst. Store lokale forbedringer i lesing, lagring og klargjøring er målt,
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

Opprinnelig hard grense: **14 USD**, inkludert embeddings, retries og dommere.
Siste avstemming: **518 registrerte kall, 14,726669 USD konservativ
kostnadsøvregrense og ingen uavklarte reservasjoner**.
Evalueringsproxyen er stoppet.
Dette er ikke endelig fakturert beløp.

Brukeren har deretter skrevet «right now i have refilled the api credits to 14
dollars» i hovedoppgaven. I konteksten av det åpne budsjettspørsmålet er dette
registrert som **opptil 14 nye USD**, ikke en nullstilling av historikken.
Den kumulative grensen er derfor **27,393718 USD**, med **14 USD tilgjengelig**
ved påfyllet og **12,667049 USD igjen** etter de registrerte chat- og helhetsvurderingsforsøkene.
Tidligere ubrukt rest legges ikke til en gang til. Samme aktive
ledger bevarer alle 469 rader; førversjonen er arkivert byteidentisk. Autorisasjonen
med eksakt utsagn, kilde-ID, observert registreringstid og hasher ligger i
`verification/api-budget-refill-authorization-v1.json`.

Prioritert testbudsjett for de 14 nye dollarene er 4 USD til komplett forbedringsløp,
4 USD til utviklingsbaserte kvalitets-/hastighetsrettinger, 3 USD til øvrige
genereringer og regresjon, 2 USD til låst holdout og 1 USD til begrunnet feil-/testreserve.
Dette er delbudsjetter, ikke antatt faktura eller forhåndsgodkjenning av ukjente
payloads. Proxyen reserverer hvert kall og håndhever både kumulativ grense og
valgt delbudsjett, også etter omstart. Testplanen er registrert i
`verification/api-budget-refill-test-plan-v1.json`. 19 nettverksfrie harness-tester
bestod, inkludert uendret historikk, avvist uregistrert grenseøkning, pending-/feilkostnader,
gjenåpning og delbudsjett. Ingen nye kall var gjort ved denne registreringen.

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
Dette oversteg resten på 0,606282 USD før påfyllet, allerede før input, embeddings og retries. Det er en
konservativ reservasjonsberegning, ikke en påstand om faktisk fakturert kostnad.
Paret ble derfor ikke startet på antatt lavere usage før påfyllet. Ett komplett
utviklingspar er nå fullført som beskrevet nedenfor. Ingen outputgrenser,
modeller eller normal samtidighet er redusert for å få det til å passe.
Lagret utkast eller `pendingEvaluationResult` ville ikke alene vært fullføring;
ny vurdering må være lagret mot riktig artefakt og kilderevisjon.

## Komplett forbedringsløp på utviklingsgrunnlaget

`verification/perfect-workflow-v1/comparison.json` dokumenterer faktisk kø,
worker, nytt løsningsutkast, indeksering, kravdekning, helhetlig revurdering og
lagring på begge sider. To disponibele lokale databasekopier hadde identiske
prosjekt-/dokument-/analyse-/chunk-/artefakt-/jobbdata og samme allerede betalte
baselinevurdering. Opprinnelige fixturer ble ikke endret. Next-cache var forbikoblet;
HTTP-autentisering, nettleser, Azure og holdout inngikk ikke.

Baseline `3779e6f2` tok **113,421 s / 5 kall**, kandidat `29fb7689` tok
**110,162 s / 4 kall**. Forskjellen på **2,87 % i ett par** er ikke en dokumentert
betydelig eller statistisk sikker hastighetsgevinst. Helhetlig GPT-5.4-vurdering
tok omtrent 85,9 og 85,7 s og dominerte begge løp. Alle providerutfall var 200
og komplette. Begge lagret et nytt utkast med riktig jobb-ID og en revurdering
der `evaluated_generated_artifact_id` peker på dette utkastet. Ingen resume-snarvei
eller `evaluation_pending` ble godkjent som fullføring. Kilderevisjonen var uendret.

Egenscore for de forskjellige utkastene var **88 mot 84**, uten at dette er en
uavhengig kvalitetsdom. Kildegjennomgangen i `source-review.json` i samme mappe
viser at begge bevarer mange presise krav, mens kandidaten plasserer 24/7-modellen
under bekreftelse før produksjonssetting. Kandidaten skiller samtidig tydeligere
mellom foreslått endring og dokumentert leveranse i enkelte passasjer. Leverandørens
eksplisitte avvik kan ikke gjøres til bekreftet kapasitet bare for å få høyere score.
Kravdekningen gjelder opprinnelig leverandørdokument: kandidaten finner fem avvik
og tre støttede krav, mens baseline feilaktig markerer alle åtte som manglende.
Generert utkast vurderes separat i arkitektursammenligningen.

Paret kostet konservativt **0,405027 USD** av delbudsjettet på 4 USD. Proxy og
begge egne containere/databaser er stoppet og fjernet. Råresultater, logger og
oppryddingsbevis er bevart. Lokal fullføring av dette ene utviklingsparet lukker
et funksjonsgap; bred hastighets-/kvalitetsgodkjenning gjenstår.

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

## Begrenset parallell filsletting

Commit `29fb7689` lar den eksisterende Azure-adapteren slette høyst fire filer
samtidig. Tidligere ble alle slettinger utført sekvensielt. Alle bøtter og stier
valideres og duplikater fjernes før første sletting. `deleteSnapshots: include`
og idempotent `deleteIfExists` er bevart. Ved første observerte feil starter ikke
flere køelementer; alle allerede påbegynte slettinger må avslutte før feilen
returneres. Et separat feilflagg bevarer også avvisning med `undefined`, `null`
eller `false`. Den eksisterende lagring-før-database-rekkefølgen er uendret.

Førmåling ble tatt før rettingen. **Dette er syntetisk nettverkslatens, ikke
målt Azure- eller komplett prosjektsletting:** faktisk adapter med injisert
SDK-klient ventet 10 ms per fil, og 30 par målte køhåndteringen.

| Filer | Før → etter, median ms | Maksimalt aktive slettinger |
| --- | --- | --- |
| 1 | 12,067 → 12,067 | 1 → 1 |
| 24 | 282,835 → 71,473 | 1 → 4 |

Filsett og snapshots-argument var identiske, og ingen kall var aktive ved
vellykket retur. Ingen ekte Azure-kall, AI-kall eller databaseendringer inngikk.
Det er fortsatt et gap å måle faktisk Azure og hele sletteløpet med audit.

Seks nye regresjoner dekker overlapp/grense, snapshots/deduplisering,
forhåndsvalidering, tom input og avvisning med fire forskjellige feilverdier.
De fem samtidighetskontrollene feilet på sekvensiell baseline. Testene bruker
også faktisk `runStorageFirstDeletion`: database-callback kommer først etter
ferdig lagring og aldri etter lagringsfeil. Etter rettingen bestod **909 frontend-
og 125 rottester**, null feil/hopp, med lokale SQL-tester; lint og bygg bestod.
En ekstra eksplisitt DB-nekt-assertion ble deretter kontrollert med de fokuserte
lagringstestene. Målefilenes opprinnelige ownerhasher er bevart.

## Funksjons- og bevismatrise

Alle funksjoner er fortsatt i omfang. Modellresultater uten eksplisitt V5-merke
er fra den tidligere 44-parsmatrisen, ikke nye kjøringer på siste commit.
Enkelttider er ikke p95 eller sikker kausal effekt. Mini er en rådgivende dommer.

| Brukerfunksjon | Faktisk implementasjon | Før/etter-status |
| --- | --- | --- |
| Pålogging, bruker-/gruppe-/prosjekttilgang | auth-ruter, authorization, access-control-repository | Rolleoppslag 3→1 DB-kall; autentiserte ruter målt; full Entra-flyt og grupper med realistisk innhold gjenstår |
| Prosjektoversikt og oppretting/sletting | projects-ruter, data-store.listProjects/createProject/deleteProject | Eldre varm HTTP-oversikt 17,0→15,8 ms; ukachet owner etter lesefiks 11,07→7,20 ms. createProject-owner 3,31→3,15 ms, uendret logikk. Filsletting har separat syntetisk kømåling; komplette opprettings-/Azure-sletteruter er ikke målt |
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
| Kø/status/SSE/avbrytelse | project-jobs, jobs-ruter, lease fencing | Kø/lease/lagring kontrollert med faktisk kravsvarjobb; standardgrense fortsatt én. Lokal SSE med to klienter, frakobling og terminalstatus bestod. Reell lokal worker/SDK-transport stanset ved tapt lease etter ordinær 30 s heartbeat; ingen ny hastighetsgevinst eller bruker-cancel-API påstås |
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

Etter siste appendring bestod **909 frontendtester + 125 rottester**, null feil
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
401. Denne SSE-kontrollen alene tester ikke worker-avbrudd; senere lease-/transportkontroll er beskrevet under.

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

## Reelt worker-avbrudd ved tapt lease

Ingen appendring var nødvendig. En egen disponibel prosjektfixture med gyldig
fiktiv vurdering ble kølagt via faktisk `queueExecutiveSummaryJob` og kjørt med
`runQueuedProjectJob` mot lokal PostgreSQL/PostgREST. OpenAI SDK sendte en ekte
HTTP-forespørsel til en lokal server som bevisst aldri sendte svaret. API-nøkkelen
var en plassholder, og en fetch-guard tillot bare lokal database og denne serveren.
Ingen OpenAI-/Azure-kall eller endring av frosne genereringsdata inngikk.

Etter at transporten var bekreftet åpen, byttet testen bare denne jobbens lease-token.
Den ordinære, uendrede 30-sekunders heartbeat forsøkte å oppdatere med gammel lease
og fikk ingen matchende rad. Rå PostgREST-respons var `406/PGRST116` med eksplisitt
null rader; adapterens `maybeSingle` gjorde dette om til `data:null`, og heartbeat
meldte tapt lease. Deretter returnerte workeren og lukket SDK-forbindelsen.

Endelig kontroll `worker-lease-transport-v3` målte **29,957 s til worker-retur og
29,960 s til transportlukking** etter leasebyttet. Lease-loss-hendelsen kom først,
og kontrollen ventet på både retur og transportlukking før opprydding. Den egne
watchdogen var dermed ikke årsaken. Ingen ferdig-/feilstatus ble skrevet av gammel
worker, den nye leasen og running-status ble bevart, og ingen lederoppsummering
eller artefakt ble lagret. Alle oppdateringsforsøk etter takeover hadde leasefilter
og null treff. Fixture og tilhørende rader ble fjernet; kilde-revisjon, budsjettlogg
og frosne input var uendret.

V1 fullførte samme kjede uten detaljert DB-sporing. V2 beholdes som en feilet
harnessforventning: den forventet 200/[] i stedet for korrekt singular-respons
406 med null rader. V3 kontrollerer den eksakte feilkoden og null-rad-detaljen;
vilkårlig 406 godtas ikke. Dette er én avgrenset runtime-egenskap, ikke statistisk
før/etter-ytelse, live modellkvalitet eller en ny brukeroperasjon for avbrytelse.
Next-cache er forbikoblet i denne kontrollen; route-autentisering og flerworkerlast
inngår ikke. Appens eksisterende klientabort stopper statusventingen, mens workerens
avbrudd her utløses av tapt lease.

## Hva som nå krever annet verifikasjonsgrunnlag

Kjente store lokale lese-/lagringsflaskehalser er rettet og dokumentert. I de
undersøkte gjenværende modellstiene fant denne runden ingen ny betydelig forbedring
som kunne godkjennes uten å endre genereringsgrunnlaget og kjøre nye livepar.
Fjords siste chat tok 13,982 s: omskriving 2,434 s, embedding 0,231 s og svar
11,211 s hos leverandøren. Retrieval bruker omskrivingsresultatet; å hoppe over
omskriving eller endre modell/tier krever ny kvalitetskontroll. Lederoppsummeringen
har ett modellkall, og raskere DB-innlesing beviser ikke raskere eller bedre svar.

Samlet godkjenning krever fortsatt nye representative live hastighets-/kvalitetspar
for genereringene som er tregere, uavklarte eller ikke kvalitetsgodkjent, samt hele
forbedringsløpet. Den tidligere budsjettblokkeringen er fjernet med det eksplisitte
påfyllet ovenfor; verifikasjonsarbeidet gjenstår. To godkjente dommerkall er beskrevet nedenfor.
Lokal testkonfigurasjon har ingen Azure Storage-konto. Faktisk opplasting, metadata,
indeksering, Azure-sletting og Entra-flyt krever et tilgjengelig, isolert testmiljø
med riktig identitet og lagring. Dette er ikke en påstand om at Azure-miljøer ikke
finnes utenfor denne kjøringen, og produksjonskandidater regnes ikke som isolert test.

En separat lesekontroll med Azure CLI fant to tilgjengelige abonnementer. Et
case-sensitivt gruppesøk etter `anbud` eller `bidsite` fant bare `anbud-prod`,
med ti ressurser. Ingen separat testressurs ble identifisert i dette avgrensede
søket. Logiske databaser inne i serveren, andre gruppenavn, andre tilganger og
andre tenants ble ikke undersøkt. Vedlegget
`verification/azure-visible-resource-inventory-v1.json` er hovedoppgavens
normaliserte oppsummering av CLI-resultatene, ikke et rått CLI-transkript.
Ingen produksjonsressurser ble endret. Videre miljøverifisering trenger dermed
en konkret identifisert testressurs og passende testidentitet; dette søket gir
ikke grunnlag for å behandle produksjonsressursene som et testmiljø.

En senere, konkret foreslått kontroll kan likevel styrke eksisterende
kvalitetsbevis innen restbudsjettet: to GPT-5.4-dommere av allerede lagrede
V5-par, Fjord V3 og Kyst legacy. Offline-preflight med faktiske ferdige payloads
gir henholdsvis **0,140556 og 0,186800 USD**, samlet **0,327356 USD**. Det
etterlater minst **0,343494 USD** dersom begge bruker full reservasjon.
Dette inkluderer inputgrense, framing, 3500 outputtokens og 10 % margin, uten
antatte cachetreff eller retry. Payloadene matcher eksisterende Mini-vurderinger
byteidentisk bortsett fra modellnavnet; kilder og blind rekkefølge er uendret.
`verification/judge-preflight-gpt54-v1-total.json` registrerer begge filer og
hasher. Dette beskriver forhåndsreservasjonen mot daværende 0,670850 USD;
de to kallene ble deretter uttrykkelig frigitt og kjørt sekvensielt.

Begge fullførte med HTTP 200 og `stop`, uendret blind rekkefølge og faktisk
forespørselshash lik preflight. Ingen retries eller nye genereringer ble kjørt.
Fjords kall tok 5,681 s og kostet konservativt 0,024126 USD; Kysts tok 7,238 s
og kostet 0,040442 USD. Dette er dommerkallenes tid, ikke nye genereringstider.
De første 467 budsjettpostene er uendret. Proxyen ble stoppet etter de to kallene.

GPT-5.4 foretrakk baseline og avviste kandidatens noninferiority i begge par,
samme utfall som Mini. Begrunnelsene er ikke fullt sammenfallende. For Fjord
rapporterer GPT-5.4 ingen kritiske feil og peker på plassering/prioritering av
K-2, K-4 og K-6. Kildekontrollen bekrefter at baseline grupperer disse i sine
fem prioriteringer, mens kandidaten bevarer alle tre i `expected_solution_direction`
uten å løfte dem i prioriteringene. Den tidligere tilbakevisningen av full
utelatelse står dermed ved lag; en smalere innvending om synlighet er støttet.
Kontrakten presiserer imidlertid at kundeanalysen ikke er en komplett kravtabell,
og at maksimalt fem prioriteringer skal fremheve de viktigste kravene. Fravær fra
prioritetslisten alene er derfor ikke et etablert kontraktsbrudd. Dette er presisert
separat i `verification/v3-judge-contract-qualification-v1.json`.

For Kyst støtter feltkontrollen baselinefordelen for 180 dagers loggoppbevaring
og konkret opplæring, driftsdokumentasjon og overtakelsesprøve i de undersøkte
feltene. Begge diagrammer har samme type generiske svakhet. Kandidaten bevarer
H-8 med normal/tredoblet last og tydelige forutsetninger, så Minis påstand om
baselinefordel akkurat der er ikke etablert. GPT-5.4 peker selv på en begrensning
i baselines H-8-presisjon. Dette er kildeadjudikasjon av frosset holdout; ingen
prompter, modeller eller genereringer er tilpasset etter innsynet.

`verification/two-gpt54-judges-reconciliation-v1.json` registrerer kallene;
`two-gpt54-judges-source-field-evidence-v1.json` og
`two-gpt54-judges-source-adjudication-v1.json` i samme mappe bevarer grunnlag og
avgrenset tolkning separat. Opprinnelige Mini-resultater er uendret. To dommere
som foretrekker baseline styrker beviset for at kvalitetsmålet fortsatt ikke er
oppfylt, men høyere dommermodell gir ingen automatisk fasit. Dette erstatter ikke
nye genereringer, gjentatte hastighetsmålinger eller hele forbedringsløpet.

## Gjenstående mål

- Betydelig hastighetsgevinst også for uendrede, tregere og umålte funksjoner,
  med representativ last og tilstrekkelige repetisjoner.
- Parvis kvalitetsgodkjenning av alle endelige genereringer på utvikling og
  holdout, inkludert uenige dommer og inkonsistent kravklassifisering.
- Bredere kvalitets- og ytelsesgodkjenning av hele forbedringsløpet; det første
  lokale utviklingsparet har nå nye utkast og riktig lagrede revurderinger på begge sider.
- Faktisk Azure/Entra/ingest, grupper og produksjonslik samtidighet. Lokalt
  worker-avbrudd ved tapt lease er kontrollert med åpen SDK-transport, men ikke
  produksjonslast eller en bruker-cancel-operasjon. Ingen produksjonsutrulling
  følger av denne rapporten.

### Første chatspørsmål – fire utviklingspar

Adaptiv omskriving hopper nå over et selvstendig første spørsmål, også når API-ruten allerede har lagt det aktuelle spørsmålet i historikken. Tidligere samtale, samtaleminne og eksplisitt aktivert omskriving beholdes. Én modellforespørsel forsvinner. De to parene med rutens meldingsformat målte 13,797 → 10,891 og 17,622 → 12,254 sekunder; første tekst kom etter 4,747 → 1,736 og 6,691 → 1,853 sekunder. Separat tom-historikkpar: 16,256 → 12,118 sekunder. Langt kildegrunnlag: 8,227 → 7,780 sekunder. Få repetisjoner gir ikke p95 eller generell kvalitetsaksept.

Alle fire opprinnelige dommerresultater er bevart, inkludert to noninferiority-feil. Begge lange svar mister opplæring/driftsmøter fra kilden; kildeutdrag og komplett referanseliste må forbedres separat. En dommer blander manglende leverandørbekreftelse med manglende kundekrav for sletting, og reelle blokkreferanser manglet i dommerens kildebundle. Dette avgrenser disse begrunnelsene uten å fjerne de faktiske kvalitetsgapene. Se `verification/chat-first-question-v1/comparison.json` og kildebevisene ved siden av.

Verifisert: 910 frontendtester, 129 rottester, alle SQL-tester på disponibel lokal database, 20 harness-tester, lint uten advarsler og produksjonsbygg. Ingen produksjonsendring. Budsjettet har 502 registrerte forespørsler, konservativ total 13,991005 USD, brukt av nytt påfyll 0,597287 USD og 13,402713 USD igjen. Proxyen er stoppet uten ventende kall.

### Chatens kildeutvalg og sporbarhet

Faktisk promptopptak skilte mellom manglende utvalg (opplæring og leverandørens driftsmøtesvar) og avkorting av en valgt blokk (kundens driftsmøtekrav). Søket bruker nå spørsmålets konkrete termer, og modellen mottar hele de valgte tekstblokkene. Chunk-eieren begrenser også struktur-/tabellrader til 4800 tegn og retrieval til 16 blokker. Produktnavn blir ikke lenger automatisk gjort til et positivt kundekrav. Alle kildene beholdes gjennom repository, API og det eksisterende sammenleggbare kildefeltet.

Langt utviklingssvar dekker nå de undersøkte kravene og forbeholdene korrekt. To nye blindede Mini-dommere med separat locator-aware protokoll foretrekker kandidatene; gamle dommer beholdes. Begge fullførte svar er langsommere: langt 7,780 → 9,446 sekunder, lite 10,891 → 15,629. Langt svar fikk første tekst tidligere, 3,757 → 2,824 sekunder; lite fikk den senere, 1,736 → 4,888. Småsvaret gjentar flere poenger og har en upresis formulering om kostnadsprognose. Det er ikke erklært feilfri kvalitet eller generell hastighetsgevinst.

912 frontendtester og 129 rottester, inkludert alle disponible SQL-tester, samt 20 harness-tester, lint og bygg passerer. To nye owner-regresjoner feiler på eldre kode. Faktisk kryptert lagring, gjeninnlesing og API beholder 16 kilder; visuelt kontrollert ved 1440/390 px med tastaturåpning og uten sideoverflow. HTTP-sletting ved opprydding ga500 i miljøet uten Azure-konfigurasjon; det eksakte tomme testprosjektet og meldingene ble fjernet gjennom lokal PostgREST. Dette er ikke en vellykket ende-til-ende-test av prosjektsletting. Se `verification/chat-evidence-v1/comparison.json`, browserbevis og separat cleanup-reconciliation.

Gjeldende budsjett: 512 forespørsler, total 14.059523 USD, nytt påfyll brukt 0.665805 USD, igjen 13.334195 USD. Proxyen er stoppet; ingen ventende kall. Alle469 historiske rader er uendret. Eldre budsjettall i de daterte avsnittene er historiske. Ingen produksjonsutrulling.

### Full systemartefakt og riktig prioritet i helhetsvurderingen

Vurderingen fikk tidligere bare de første3800/4500 tegnene av artefakten som skulle scores, samtidig som systemprompten krevde sammenligning mot eldre kundeanalyse. Nå får den hele artefakten, og systemprompten prioriterer oppgitt artefakt; kundeanalysen er fallback når artefakt mangler. En faktisk owner-test med motsatte sene MFA-forpliktelser feiler på førversjonen og passerer etter retting. 913 frontendtester, 129 rottester med alle SQL-kontroller, lint og bygg passerer.

I det frosne lange utviklingseksemplet fant før-svaret ikke systemartefaktens sene MFA-unntak; etter-svaret beskrev løfte→sen tilbaketrekking eksplisitt. Dette er et konkret kildekvalitetsfunn, men Mini-dommeren ga samlet NI=false og foretrakk førversjonen. Dommen er bevart. Flere konkrete begrunnelser motsies av etter-svarets tekst; kildeadjudikasjon avgrenser disse uten å erklære samlet kvalitetsseier. Råd om å fjerne forbehold kan fortsatt misforstås når de brukes i neste forbedringsrunde; nødvendige leverandørbekreftelser må ikke bli oppdiktet.

Fire faktiske holistic-kall brukte samme importerte kravdekning fra det fullførte perfekte utviklingsparet. De er isolerte vurderingsmålinger, ikke ny helarbeidsflyt. Langt moteksempel:88,516→100,519 sekunder. Eksakt uendret tidligere generert artefakt: GPT-5.4 91,376 sekunder mot Terra93,655 med ellers identisk prompt, medium resonnering og svarkontrakt. Terra fikk NI=true, men vant ikke. GPT-5.4 beholdes; ingen målbar fartsgevinst begrunner bytte. Cachetreff og få repetisjoner begrenser konklusjonen. Se `verification/holistic-artifact-v1/comparison.json`.

Gjeldende budsjett er518 kall, konservativ total14,726669 USD, nytt påfyll brukt1,332951 USD og12,667049 USD igjen. Ingen ventende kall; proxyen er stoppet. Ingen produksjonsutrulling.

### Kompakte kravfunn – målinger og funnet sitatfeil

Modellen skrev tidligere komplette kravfunn som normaliseringen erstattet med tekst fra den eksisterende kravdekningen. En intern variant lar modellen velge eksakte radnumre og bygger samme offentlige funn fra disse radene. Selvstendige seksjonsfunn skrives fortsatt fullt ut. Valgt rekkefølge, kildedokument og identiske lokale krav-ID-er beholdes, også når to dokumenter bruker samme sitat. Radnumre må finnes i det faktisk viste vurderingsgrunnlaget.

Det første låste utviklingsparet ga **81,122 → 85,313 sekunder**, med identiske åtte kravrader og byteidentiske fem felles ferdige kravfunn. Modellen skrev mindre synlig tekst, men brukte mer resonnering; totalt økte output fra6815 til7102 tokens. Før hadde12032 cachede inputtokens, etter ingen. Mini ga NI=true og foretrakk førversjonen. Dette er ingen dokumentert hastighetsgevinst eller sikker årsakssammenheng. Se verification/compact-findings-v2/comparison.json og separat kildekontroll. Begge svar anbefaler fortsatt å gjøre ubekreftede leveranser ubetingede; dette er et eget kvalitetsgap.

En forhåndsregistrert gjentakelse med motsatt rekkefølge stoppet etter første kall: kandidaten brukte99,668 sekunder og returnerte gyldige kravvalg, men et eksakt seksjonssitat med norske «anførselstegn» ble feilaktig avvist. Førkall og dommer ble ikke kjørt. Den opprinnelige feilen og råsvaret beholdes i verification/compact-findings-v3. Sitatnormaliseringen støtter nå også norske anførselstegn. Det samme råsvaret passerer hele vurderingsfunksjonen lokalt med seks kildebelagte funn; dette er replay uten modellkall, ikke en ny vellykket live-måling. Endret negasjon og oppdiktet tekst avvises fortsatt.

919 frontendtester,129 rottester med alle disponible SQL-kontroller, lint og bygg passerer etter rettingen. Kompaktformatets effekt vurderes fortsatt; ingen generell hastighets- eller kvalitetsgodkjenning følger av disse forsøkene. Ved stopp etter522 kall var konservativ total15,168900 USD, nytt påfyll brukt1,775182 USD og12,224818 USD igjen, uten ventende kall. Opprinnelige regnskapsutkast som feilaktig summerte historiske fulle reservasjoner er tydelig merket og beholdt; gjeldende rapport bruker den felles verifiserte regnskapseieren. Ledgeren er uendret.

En separat, låst kontroll av resonneringsnivå med samme kompaktprompt ga86,489 →58,701 sekunder (32,1 prosent kortere), men Mini avviste NI og foretrakk normal resonnering. Kildekontrollen bekrefter alle åtte kravrader og at K-4 fortsatt omtales, selv om det ikke er blant de seks valgte funnene. Begge svar har råd om ubekreftede løfter; dommerens fulle skår på kildefasthet er derfor ingen absolutt fasit. Se verification/holistic-reasoning-v2/comparison.json. Appens modell- og resonneringsinnstillinger ble ikke endret.

Kompaktimplementeringen er deretter fjernet fra appen fordi forsøkene ikke begrunner ekstra kompleksitet med samlet kvalitets- og hastighetsgevinst. Patch, tester, alle målinger og feil er arkivert. Den generiske sitatrettingen beholdes og testes gjennom den eksisterende full-funn-banen i faktisk evalueringsowner. Tvetydig matching ved samme lokale krav-ID og identisk bevis i to dokumenter er fortsatt en separat kildeidentitetsrisiko i den eldre normaliseringen; kompaktforsøket løste dette bare i sin egen, nå fjernede bane.

Ved stopp etter525 kall var konservativ total15,437355 USD, nytt påfyll brukt2,043637 USD og11,956363 USD igjen. Ingen ventende kall; proxyen er stoppet. Ingen produksjonsutrulling.

Den endelige sitatrettingen uten kompaktkode passerer913 frontendtester,129 rottester med alle disponible SQL-kontroller,20 harness-tester, lint og bygg. Den utvidede owner-testen feiler på førkoden fordi seksjonsfunnet erstattes av et annet kravfunn. Se verification/legacy-quote-v1/verification.json.
