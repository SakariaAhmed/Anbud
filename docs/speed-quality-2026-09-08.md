# Hastighet og genereringskvalitet — pågående arbeid

Målet er fortsatt **ikke bekreftet**. Ingen produksjonsutrulling er bestilt eller utført.
Ønsket målrekkefølge er hastighet → kvalitet → samlet regresjonskontroll.
Kvalitetsendringer ble gjort mens hastighet for alle funksjoner fortsatt var
ubekreftet. Brukerens første bekreftelseskrav er dermed ikke passert; rapporten
kan ikke brukes som godkjenning av denne faseovergangen.

Siste applikasjonscommit er `5c1598e9` (kvalitetsrettingene i `3620dff6` og
`5ddc0ee5`). **Målet om raskere og bedre funksjoner overalt er ikke oppfylt.**
Store SQL-/innlesingsgevinster og konkrete kvalitetsforbedringer er dokumentert,
men flere genereringer har høyere enkelttider eller mangler godkjent parvis kvalitet.
Det gjenstår dessuten funksjonsdekning på blant annet faktisk Azure/Entra,
AI-anbefalinger fra en katalog med innhold og hele forbedringsløpet.

Det kompakte [bevisregisteret](speed-quality-2026-09-08-evidence.json) har 44
verifiserte input-par og filhasher til råbevisene. Samlet konservativ kostnadsøvregrense
ble **13,903332 USD av 14 USD**. Evalueringsproxyen er stoppet; ingen flere modellkall
er planlagt. Rålogger og resultater beholdes lokalt og er ikke lagt i git-historikken.

Siste appkontroll: **898 frontendtester + 118 rottester**, ingen feil/hopp, alle
fire SQL-testdatabaser lokalt. Lint, produksjonsbygg og hemmelighetsskanning bestod.
Ti separate tester av evalueringsharnessen bestod. Etter den siste responsive
klasseendringen bestod lint/bygg og autentisert nettleserkontroll på 1440 og 390 px.
Kravsvarjobben fullførte gjennom API/lease/lagring, og PDF-eksporten ble åpnet og
visuelt kontrollert på begge sider. ARM- og AMD64-container-smoke samt en liten
offline AMD64-konvertering bestod. Dette er lokale kontroller, ikke produksjons-
eller Azure-ende-til-ende-verifikasjon.

## Baseline og miljø

- Ren arbeidskopi og HEAD/main `f7abd3b583aca73a387fe760e28f4791b1838dcc` ved start.
- Branch `Feature/speed-quality`. Sikkerhetspatch kontrollert med `git apply --check`
  og tatt inn separat som `3779e6f2`. Den andre sikkerhetsarbeidskopien er ikke endret.
- Node 22.14.0 og `npm ci` med eksisterende låsfil.
- Disponibel lokal PostgreSQL 17/pgvector og PostgREST for syntetiske testdata.
  Dette er ikke produksjon eller et etablert stagingmiljø.
- Azure Blob Storage krever faktisk Azure-identitet og HTTPS i eksisterende kode.
  Lokal database alene gir derfor ikke full ende-til-ende-opplastingsverifikasjon.

## Budsjett

Hard samlet grense: **14 USD** for nye OpenAI API-kall. Nøkkelen leses direkte fra
eksisterende lokal konfigurasjon av en separat lokal evalueringsproxy. Applikasjonen
får kun en lokal plassholdernøkkel; produksjonens database-, lagrings- og identitets-
konfigurasjon lastes ikke inn. Ingen produksjonsdokumenter brukes.

`scripts/speed-quality/budget-proxy.mjs` reserverer konservativ full kostnad før
hvert videresendt kall. Alle retries blir egne rader. Historiske reservasjoner
beholdes uendret. En eksklusiv lås hindrer samtidige proxyprosesser med samme logg.
Tekstinput budsjetteres med UTF-8-bytes + 4096 tokens og 10 % prismargin.
Maksimal input-/cache-skrivepris brukes; GPT-5.4 bruker kortkontekstpris bare når
hele tokenøvregrensen inklusive output er under 256 000 (dokumentert terskel 272K).
Ukjente modeller, filer/bilder/lyd, verktøy og eksternt bevart kontekst avvises.

Først ble alle reservasjoner beholdt også som forbruksgrense. Fra policy
`verified-usage-or-full-reservation-v2` avstemmes vellykkede HTTP-svar med komplett,
validert tokenbruk mot en konservativ kostnadsøvregrense. Cache regnes til full
inputpris, reasoning regnes som output, og 10 % margin beholdes. Manglende,
uventet eller inkonsistent usage og ukjente utfall beholder full reservasjon.
**Bekreftet kostnadsøvregrense + alle uavklarte/pågående reservasjoner + neste
forhåndsreservasjon kan aldri overstige 14 USD.** Opprinnelige reservasjoner,
usage, prisgrunnlag og avstemt øvregrense finnes hver for seg i loggen.
Dette er ikke en påstand om endelig fakturert beløp.

Output inklusive reasoning begrenses normalt til 8000 tokens i evalueringen.
Første helhetlige løsningsvurdering brukte alle 8000 til reasoning og avsluttet
med `finish_reason=length`; den er en mislykket prøve, ikke en produksjonsfeil
eller gyldig kvalitetsbaseline. Helhetsvurderingen og kravsvar-batcher får 16000 tokens i
både ny baseline og kandidat; øvrige grenser er uendret. Proxyens tokengrenser er ikke en produksjonsendring. Den separate applikasjonsendringen bruker Luna som standard bare for enkeltbatch-kravsvar; øvrige produksjonsmodeller er uendret.
Priskilde kontrollert 2026-09-08: [OpenAI API Pricing](https://developers.openai.com/api/docs/pricing).

De første genereringene brukte en bufferende proxy. Etter streamingrettingen
videresendes byte fortløpende. Leverandørens første tekstdelta måles fra innkommende
proxyforespørsel, inklusive venting før headere. Genereringsrunneren registrerer
også første ikke-tomme tekst fra appens chatgenerator (som holder tilbake 120 tegn
for kildenormalisering). Ingen tidligere måling omtolkes til TTFT.

## Funksjons- og bevismatrise

Alle rader trenger representativ før/etter-verifikasjon. «Ikke målt» innebærer ingen
påstand om forbedring. Kald/varm, små/store kilder og samtidige prosjekter skal
registreres separat. p95 krever tilstrekkelig antall repetisjoner; små AI-utvalg
rapporteres som enkelttider eller median med eksplisitt utvalgsstørrelse.

| Brukerfunksjon | Faktisk implementasjon | Før/etter-status |
| --- | --- | --- |
| Pålogging, bruker-/gruppe-/prosjekttilgang | auth-ruter, authorization, access-control-repository | Rolleoppslag 3→1 DB-kall; autentiserte ruter målt; full Entra-flyt og grupper med realistisk innhold gjenstår |
| Prosjektoversikt og oppretting/sletting | projects-ruter, data-store.listProjects/createProject/deleteProject | Oversikt 17,0→15,8 ms median, ingen stor gevinst; oppretting/sletting ikke målt |
| Prosjektdetalj og navigasjon | getProjectDetail/getProjectShell, felles klientcache | Stor vurdering 331→53 ms median; lokal autentisert desktop/mobil kontrollert på analyse og kravsvar |
| Lesing/lagring av analyser og artefakter | customer-analysis/generate/artifact-authority-ruter | Stor vurdering 322→42 ms median; stor artefaktlagring 1077→115 ms; avsluttende lesekontroll 315→47 ms |
| Tjenestebibliotek og valgte tjenester | service-descriptions-ruter og repositorium | Tomme HTTP-kontrollister samt separat eierkontroll med tre tjenester/dokumenter og direkte valg-RPC bestod. Ca. 8 ms uendret. Ekte isolert HTTP GET/PATCH og Next-invalidering bestod; browser-cache og AI-kvalitet med kataloginnhold gjenstår |
| Opplasting, parsing, indeksering, metadata og nedlasting | documents-ruter, documents.ts, document-chunks, dokumentjobber | Originalbytes ved HTTP-nedlasting bevart; parserregresjoner og liten offline AMD64-Docling-konvertering bestod. Ikke målt ende-til-ende; lokal Azure-lagring mangler |
| Chat med kilder/vedlegg | ai/project-chat.ts, chat-rute | Innlesingen har identiske argumenter og færre DB-kall. Siste modellpar 13,27→13,98 / 10,70→14,24 s; ingen samlet hastighets-/kvalitetsgodkjenning |
| Kundeanalyse | analyzeCustomerDocuments, legacy/v3 | Legacy og v3 har høyere enkelttider i siste par. Modeller uendret; kvalitetsgodkjenning gjelder ikke alle varianter |
| Regenerering av analyseseksjoner | regenerateCustomerAnalysisSection | Alle ni seksjoner har frosne par på begge case. Eierreplay bevarer øvrige felt 18/18; kvalitet og hastighet er ikke forbedret overalt |
| Kravsvar/rekonstruksjon | bilag1_rekonstruksjon i generateProjectArtifact | Siste par 54,44→50,92 / 51,50→37,81 s. Kvalitetsdom positiv bare på holdout; ingen samlet godkjenning |
| Forbedret kravsvar | forbedret_kravsvar, repair/handoff | Siste enkeltbatch 31,17→17,04 / 38,60→22,98 s, begge kvalitetsvinnere. Faktisk jobb lagrer 8 krav/5 korrekte gjennomgangsflagg. 32-kravsmåling 92→55 s fra tidligere policykontroll; opt-in bevart |
| Løsningsutkast | losningsutkast | Siste par 11,54→6,83 / 7,78→5,48 s. Utviklingsavvik synliggjøres; holdout ikke godkjent av dommer |
| High-level design | generateHighLevelDesign | Stor prøve omtrent uendret. Siste små par 21,24→13,84 / 14,41→12,54 s; holdoutkvalitet ikke godkjent. Markdown og systemomfang bevart av nye regresjoner |
| Tilbudsstrategi | tilbudsstrategi | Siste par 23,64→23,70 / 18,36→21,09 s; begge kvalitetsvinnere, ingen dokumentert hastighetsgevinst |
| Verdiargumentasjon | verdiargumentasjon | Siste par 10,72→13,27 / 6,88→9,54 s; begge kvalitetsvinnere, lengre svar og høyere tid |
| Anbefalt arkitektur | anbefalt_arkitektur | Siste par 14,57→12,67 / 10,71→15,42 s; holdout ikke godkjent, ingen samlet gevinst |
| Gjennomføring og risiko | gjennomforing_og_risiko | Siste par 17,41→12,33 / 15,43→11,76 s; begge kvalitetsvinnere. Bindende krav holdes fast ved avvik |
| Løsningsvurdering/kravdekning | evaluateSolutionDocument, direct-solution-evaluation | Siste små par 101,02→106,72 / 107,23→99,16 s, begge kvalitetsvinnere; ingen hastighetsgevinst i begge case |
| Forbedringsløp | perfect_system_solution i project-workflows | Ikke målt |
| Lederoppsummering | ai/executive-summary.ts | Innlesingen halverer DB-kall. Siste modellpar 3,33→4,74 / 3,09→5,05 s; begge kvalitetsvinnere mot samme avledede vurdering, men tregere |
| Kø/status/SSE/avbrytelse | project-jobs, jobs-ruter, lease fencing | Kø/lease/lagring kontrollert med faktisk kravsvarjobb; standardgrense fortsatt én. Lokal SSE med to klienter, frakobling og terminalstatus bestod; ikke worker-avbrudd eller før/etter-latens |
| Eksport | komponentenes eksporthandlinger | Faktisk kravsvar-PDF med 8 krav/5 varsler, begge sider visuelt kontrollert; én eksport ca. 876 ms, ingen før/etter-gevinst påstås |

## Bekreftede kildefunn og hypoteser

- Prosjektlesinger og kravgrupper har allerede parallellisering. Den er baseline.
- Autorun har standard én tung jobb per prosess og konfigurerbar grense 1–4.
  Databaselåser beskytter fortsatt prosjekter; økt samtidighet alene beviser ikke
  kortere modelllatens eller bedre throughput under rate limits.
- Dokumentdigest har prosesscache; kompilert kundeanalysekontekst har allerede
  vedvarende lagring. Ikke innfør en duplikatcache.
- `compactText` normaliserer hele kilden selv når bare et lite prefiks brukes.
  Dette er et mulig CPU-/allokeringsproblem for store dokumenter; måles før endring.
- High-level design venter på dokumentdigest før uavhengig retrieval starter.
  En eventuell overlapping må bevare kilder, cancellation og feilsemantikk.

## Verifikasjonslogg

### Bekreftede lokale hastighetsfunn

Alle tall under kommer fra faktisk implementasjon. SQL-/HTTP-fixturene er
syntetiske; HTTP-kallene bruker ekte innlogging, route-guards og disponibel
PostgreSQL/PostgREST. Utviklingsserverens første kompilering inngår ikke i de varme
medianene. Dette er ikke dokumentasjon på produksjonens responstider.

| Måling | Før p50 | Etter p50 | Utvalg/avgrensning |
| --- | ---: | ---: | --- |
| Kort tekstutdrag, 5 mill. tegn → 22 000 tegn | 63,62 ms | 0,13 ms | 30 vekslende par, 5 repetisjoner per prøve; identisk output |
| Samme størrelse med bare/innledende blanktegn | 2,48 ms | 2,48 ms | Tidligere oppdaget regresjon rettet; hver kildeposisjon skannes én gang |
| Detalj-API, stor vurdering, ett prosjekt | 574,8 ms | 308,2 ms | 30 varme kall per versjon |
| Detalj-API, stor vurdering, tre samtidige prosjekter | 631,7 ms | 370,1 ms | 90 varme kall per versjon |
| Artefaktstatus-API, stor vurdering, ett prosjekt | 572,8 ms | 315,9 ms | 30 varme kall per versjon |
| Artefaktstatus-API, stor vurdering, tre prosjekter | 623,5 ms | 333,0 ms | 90 varme kall per versjon |
| Prosjektrolle, eier | 3,97 ms / 3 DB-kall | 2,60 ms / 1 DB-kall | 30 vekslende par; inkluderer ikke middleware/sesjonsvalidering |
| Prosjektrolle, ingen tilgang | 3,39 ms / 3 DB-kall | 2,66 ms / 1 DB-kall | Samme avvisning, ferskt oppslag hver gang |

Alle responsbody-hasher fra den parvise HTTP-kontrollen var identiske. Små
prosjekter fikk beskjedne gevinster; jobbstatus var omtrent uendret. p95 for enkelte
uforandrede kontrollrader var høyere i etterkjøringen, og må følges opp i sluttkontrollen.

SQL-instrumentering viste seks gjentatte avhengighets-/hashberegninger per
vurderingssnapshot og 168 ved artefaktstatus for sju vurderingsavhengige artefakter.
`MATERIALIZED` avgrenser gjenbruk til én SQL-setning. Ingen tilstand caches mellom
forespørsler. Artefakter som ikke bruker vurderingen hopper over denne hashberegningen.
Store artefakttekster på 200 000 tegn per artefakt ble også målt: ingen avhengighet
ga omtrent uendret tid; delvis og full vurderingsavhengighet ble raskere.
Den separate migrasjonen er idempotent og bevarer STABLE, invoker, RLS og RPC-grants.
Se [PostgreSQL om CTE-materialisering](https://www.postgresql.org/docs/17/queries-with.html#QUERIES-WITH-CTE-MATERIALIZATION).

Rolleoppslaget bruker nå eksisterende `resolve_project_role`, som allerede var
middleware-eier for direkte grants, gruppegrants og opprinnelig eierskap.
Serverens ferske kontroll av principal/sesjon og alle direkte route-guards består.
Feil og ugyldige roller avvises før prosjektdata leses.

Live-baseline for to små, uavhengige kundeanalyser: 113,58 sekunder til begge var
ferdige; første analyse var observert ferdig etter 59,21 sekunder. Med to samtidige autorun-jobber tok samme par 60,10 sekunder. Dette beviser
ikke kapasitet for tunge parser-/kravjobber ved 1 CPU / 2 GiB; standardgrensen
er derfor tilbake på én. Køtid og aktive jobber logges nå. Én varm
enkeltkjøring tok 55,13 sekunder og avsluttet med providerens `finish_reason=stop`.
De to første genereringene mangler registrert finish_reason i proxyloggen;
gyldig JSON og vellykket lagring er registrert, men erstatter ikke det manglende feltet.
Dette er små utvalg, og brukes ikke til AI-p95 eller generell kvalitetskonklusjon.

Frosne utviklings-/holdout-kilder er korte, fiktive anbud med åtte eksplisitte krav
hver. De skiller mellom motstrid og manglende belegg. Eksisterende fiktiv Nordic-PDF
er også indeksert, men viste seg å ha bare 3894 tegn etter parsing. Den må derfor
ikke omtales som et tilstrekkelig stort dokument-/batchingtilfelle.
Et separat fiktivt grunnlag med 32 forskjellige obligatoriske krav er nå skrevet
(17 727 tegn kundegrunnlag / 3039 tegn løsningsgrunnlag). Indeksering og liveprøver
gjenstår. Komplette inngangsobjekter fra lagret baseline er frosset for de to små
casene, inklusive analyse, dokumenter, tjenestekandidater og valgte avhengigheter.
Helhetlig lederoppsummering skal bruke samme frosne baselinevurdering i begge varianter.

Baseline på faktisk genereringsfunksjon er fullført for HLD og fem øvrige
artefakttyper i begge små caser, med enkelttider 6,88–23,64 sekunder. Ingen
holdout-svar er brukt til justering av prompter. Alle modellkall kan kobles til
kostnadsloggen og komplette request-hasher. Dette målepunktet omfatter lokal
retrieval og ekte modell, men ikke kø, route-auth, lagring eller nettleserrendering.
Kravsvar, analyse/v3, vurdering og chat er fortsatt under måling.

HLD starter nå uavhengig dokumentdigest og retrieval samtidig. En test med
kontrollerte ventepunkter bekrefter overlapping, at sluttgenereringen venter på
begge kilder, og at evidensfeil stopper sluttgenerering. Live før/etter på større
kilder gjenstår; testen alene er ingen måling av modellens hastighetsgevinst.

- Budsjettets fire lokale regresjoner og streamingtesten bestod: vedvarende reservasjon/lås/retries,
  konservative token-/outputgrenser og avvisning av ubudsjetterte kall.
- Live embedding- og genereringskall er startet. Løpende tokenbruk, historiske reservasjoner og konservativ avstemt kostnad
  ligger i `output/speed-quality-2026-09-08/api-budget.json`. Ukjente utfall
  avstemmes aldri ned.
- Komplett baseline: 871 frontendtester + 112 rottester bestod, uten feil eller hopp.
  Etter tekst-/SQL-endringene: 874 + 112 bestod, uten feil eller hopp.
  Auditens 43 ekte SQL-regresjoner bestod også. Lint bestod. Endringer etter dette
  (rolleoppslag/samtidighet) trenger en ny samlet kjøring.
- Kvalitetsendringer er ennå ikke startet. Frosset grunnlag/holdout, parvis
  vurdering, faglig aksept og alle sluttkontroller gjenstår.

### Senere kontrollpunkter

- En Bilag 1-prompt som ba om færre gjentakelser ga 54,44→36,12 s på utviklingscasen
  og 51,50→43,17 s på holdout. Ett par per case beviser ikke modellens stabile p95.
  Den blinde dommeren fant bevart kravdekning, men et vesentlig kildeproblem i
  utviklingssvaret: intern retrieval-kvalitet ble fremstilt som kilde om kunden.
  **Promptforsøket er forkastet og reversert.** Det telles ikke som levert gevinst.
- Mobilkontroll ved 390×844 fant at analyseoverskrift/beskrivelse ble klemt av
  redigeringsknappen. Den delte SectionSurface legger nå knappen under tittelen
  på små skjermer. Kontrollert med ekte lokal innlogging på desktop og mobil;
  prosjektsøk, prosjektåpning og dokumentnavigasjon ble også gjennomført.
  Dette er en funksjonskontroll, ingen måling av forbedret nettleserlatens.
- Begge små helhetlige løsningsvurderinger fullførte ved 16000-grensen, med stop,
  på 101,02 og 107,23 sekunder. De fleste genereringstyper i matrisen har nå
  en liten baseline. Legacy-analyse måles også ved samme funksjonsgrense som modellprøvene. Det store grunnlaget er indeksert og har lagret analyse
  (66,89 sekunder observert jobbfullføring). Store kravbatcher gjenstår.
- En eksplisitt modellprøve på utviklingsgrunnlaget bruker gpt-5.6-luna med
  baselinekode/prompter og uendrede kilder. Ingen produksjonsmodell er endret.
  Både hastighet og faglig likeverdighet må godkjennes før en modellpolicy endres.


### Produksjonsbygg på lokal testmaskin

Sikkerhetsbaselinen `3779e6f2` og kandidaten `bb89a96b` er bygget separat med
samme Node-versjon, låsfil og miljø. Standalone-pakkene kjører med faktisk
`NODE_ENV=production`. En lokal HTTPS-gateway til disponibel PostgREST oppfyller
appens interne HTTPS-krav; produksjonsvalideringen er ikke svekket. Lokal CA og
DNS-overstyring gjelder bare testprosessene. Ingen Azure-tjeneste er målt her.

| Rute / samtidige prosjekter | Før p50 / p95 | Etter p50 / p95 |
| --- | ---: | ---: |
| Stor prosjektdetalj / 1 | 331,00 / 344,36 ms | 53,05 / 62,97 ms |
| Stor prosjektdetalj / 3 | 380,53 / 407,03 ms | 87,18 / 94,35 ms |
| Stor artefaktstatus / 1 | 322,06 / 333,09 ms | 41,93 / 51,16 ms |
| Stor artefaktstatus / 3 | 350,00 / 371,23 ms | 47,77 / 57,73 ms |

Alle 12 målerader har identiske respons-hashmultisett før/etter. Små
prosjektdetaljer/artefaktstatus fikk 16,8–32,9 % lavere median. Kontrollruten for
jobbstatus er omtrent uendret eller raskere. Small/jobs/3 hadde p95 30,73→32,33 ms;
dette ene avviket på 1,60 ms er ikke alene bevis på regresjon. Hver rad har 30
eller 90 varme kall; første forespørsel er registrert separat. Rådata og kontroll:
`http-production-before.json`, `http-production-after.json`,
`http-production-comparison.json` under rapportens output-katalog.

Komplett testkjøring etter rolleoppslag/HLD/samtidighetslogging: **877 frontendtester
+ 114 rottester**, ingen feil eller hopp, med alle fire SQL-testdatabaser konfigurert
lokalt. Lint, begge produksjonsbygg, rotvalidatorene og secrets-scan bestod.
Dette gjelder de to implementasjonscommitene; evalueringsharness og senere arbeid
skal kontrolleres separat før sluttføring.

Originalt Sundvik-grunnlag med 32 krav i overskrifter ga bare tre generiske
kravrader. Dette beholdes som en faktisk parserregresjon, ikke omdefinert til en
vellykket batchprøve. En separat variant med eksplisitte `L-01:`-linjer ga alle 32
ID-er uten nettverk/API-kall. Den brukes til å måle store kravbatcher. Den faktiske
forberedelsen i vurderingsworkflowen ble også undersøkt uten modell: utviklingscasen
har åtte kildekrav, men ingen matchede svarutdrag. Dette er et påvist problem ved
evidensforberedelsen, og skal håndteres i kvalitetsfasen med egne regresjoner.


### Flere funksjoner, større batcher og regresjonsoppfølging

- Utvidet produksjonsbygg-kontroll: alle 18 rader har identiske respons-hasher.
  Stor artefaktliste fikk median 455,59→50,23 ms. Analyse-, vurderings-, leder-
  oppsummerings-, tjeneste-, chatthistorikk- og tilgangsruter samt to ekte lokale
  originalnedlastinger ble målt. Tom tjenesteliste og manglende valgfrie resultater
  er kontrolltilfeller, ikke bevis for store innholdsmengder. De syntetiske
  lesefixturene mangler historiske kunnskapsmanifest og er stress-/legacytilfeller.
- Flere kontrollruter hadde større p95 i den fasevise etterkjøringen. Oppfølgingen
  bruker en separat identisk DB-kopi med baseline-SQL, to produksjonsbygg og 30
  vekslende par uten samtidige modellkall, bygg eller skriv. Disse utslagene ble
  ikke gjentatt: small customer-analysis p95 32,77→28,05 ms, small executive-summary
  30,30→27,37, large service-descriptions 72,54→33,68, large executive-summary
  96,29→50,36. Small service-descriptions var omtrent uendret, 31,94→32,65 ms.
  Store artefaktlister beholdt gevinsten 316,45→56,40 ms median. Ulikheten fra
  forrige serie viser hvorfor lokal belastning og variasjon må rapporteres.
- Manuell artefaktlagring og sletting ble kjørt på egne fixturer med gyldig
  kunnskapsmanifest for redigeringsforelderen. Første forsøk ble korrekt avvist
  fordi manifestet manglet; dette ble rettet i fixtureoppsettet. Hver av 30 målte
  runder + oppvarming kontrollerte tekst, versjon, forelder, manual_edit og
  gjenopprettet versjonsliste etter sletting. Inputhash er lik før/etter.
  Stor lagring: 1077,26→114,61 ms median; stor sletting: 498,63→64,44 ms.
  Dette omfatter full route og respons, men ikke nye modellgenereringer eller
  andre skrivetyper. De første timingkjøringene kontrollerte is_current;
  source_is_current kontrolleres eksplisitt i en separat funksjonsprøve.
- Tomme og utdaterte SQL-tilfeller ble kontrollert. En egen regresjon i første
  materialiseringsendring ga unødvendig hashing når alle kilderevisjoner var
  utdaterte (0,10→1,53 ms). Rettet i `603b1198`; nå 0,103→0,106 ms, med identisk
  output. Ny SQL-regresjon krever null vurderingshashkall for tomme artefakter,
  utdaterte prosjektrevisjoner og utdaterte tjenesterevisjoner. Store aktuelle
  avhengigheter beholdt gevinsten: 238,58→14,94 ms. Migrasjonen er kun brukt lokalt.
- Den første 32-kravsvarprøven traff evalueringsproxyens 8000-tokensgrense i én
  batch. Appen reparerte svaret, men prøven godkjennes ikke som uavkortet baseline.
  Batchfasen får derfor 16000 tokens i både ny baseline og kandidat, på samme måte
  som helhetsvurderingen. Øvrige grenser og 14 USD-totalen er uendret. Ny baseline
  fullførte alle provider-svar med stop: kravsvar 91,69 s og vurdering 125,91 s.
  Tidligere mislykket prøve og kostnad beholdes i loggen.
- Luna-prøvene viser ikke at én modell er raskest for alle funksjoner. På liten
  utviklingscase var analyse, HLD, kravsvar, vurdering og Bilag 1 raskere, mens
  chat, lederoppsummering og flere andre artefakter var tregere. Ingen produksjons-
  modell er endret; kildekontroll, holdout og store par må avgjøre eventuell
  avgrenset modellpolicy. Hastighetsfasen og hele målet er fortsatt uferdig.


### Avgrensede genereringsendringer under kontroll

Første-spørsmål-endringen i chat ga tidligere første tekst og identiske kilde-
referanser, men holdout-dommeren fant svakere kildepresisjon. Koden og tilhørende
rutetest er derfor tatt ut av kandidaten; patch og resultater beholdes som
forkastet forsøk. Ingen holdout-svar ble lest for å justere endringen. Den brede
Luna-utprøvingen endrer heller ikke chat, analyser, vurdering eller øvrige artefakter.

Kravsvarprøvene støtter en avgrenset policy: Luna brukes som standard bare når
kravlisten får én batch (inntil 18 krav med standardoppsett). Flere batcher og
reparasjoner beholder analysemodellen. `OPENAI_REQUIREMENT_RESPONSE_MODEL` styrer
standardmodellen for enkeltbatchen; eksplisitte modellvalg respekteres, og mini/
nano-beskyttelsen beholdes. Andre genereringer beholder sine modeller.

En bredere Luna-standard for 32 krav ble forkastet: én kjøring feilet etter 82,54 s,
og analysemodellen som reparasjon fullførte en annen på 117,66 s, mot baseline
91,69 s. Disse forsøkene beholdes med kostnad. For 19–79 krav reduseres ordinær
batchstørrelse fra 24 til 12 med analysemodellen. To kjøringer på de samme 32
kravene fullførte på 66,86 og 54,63 s. Begge fikk parvis ikke-svakere-vurdering;
den siste ble ikke vurdert som kvalitetsvinner. Alle 32 ID-er var med. Grensen
for minst 80 krav beholder batchstørrelse 28 og er ikke live-verifisert av denne
prøven. Dette dokumenterer hastighet på valgte størrelser, ikke godkjent kvalitet
for hele produktet. Eksisterende kritiske kvalitetsfeil gjenstår.

Siste samlede kontroll av disse endringene: 879 frontendtester og 116 rottester,
ingen feil eller hopp, med alle fire SQL-testdatabaser lokalt. Produksjonsbygget
bestod. Tidligere oppgitte testtall gjelder eldre kandidatversjoner.

`getProjectGenerationContext` laster navn og gjeldende vurdering/dependency med
samme snapshot-fence som tidligere. Chat, lederoppsummering og forbedringsløpet
slipper unused UI-data; lederoppsummeringen slipper også dobbel vurderingslesing.
30 vekslende par med reelle repositorieeiere og identiske DB-kopier bevarte alle
modellsynlige felt og dependency: chat 9→5 DB-kall, lederoppsummering 10→5.
Stor chatinnlesing 295,12→27,66 ms; stor lederinnlesing 307,41→28,02 ms.
Dette er innlesing, ikke modellens eller hele jobbens svartid. En regresjonstest
simulerer kildeendring under lesing, manglende vurdering og backendfeil. De 43
audit-regresjonene med reell SQL og additive oppgradering bestod etter endringen,
inklusive avbrutt revurdering og gjenopptakelse fra lagret delresultat.

Proxyen ber fra nå av om usage i fremtidige chat-strømmer via SDK-ens dokumenterte
`stream_options.include_usage`. Historiske strømmer uten usage beholder full
reservasjon. Ingen tidligere kostnad estimeres ned, og avbrutte strømmer er fortsatt
fullt reservert. Feltet påvirker rapportering, ikke kildetekst eller modellvalg.


### Kontroll av siste hastighetskandidat og første kvalitetsregresjoner

Innlesingsendringen er lagret separat i `bdd88ba1`, batch-/modellpolicy i
`ff1fde6f`. Lint og produksjonsbygg bestod; samlet 879 + 116 tester uten feil/hopp.
Den større HLD-prøven var omtrent uendret: 25,59→26,34 s. Alle digest-/embedding-
input var like; sluttinput varierer med de genererte digestene. Dommeren godkjente
ikke paret som ikke-svakere. Overlappingen er derfor ikke en dokumentert samlet
hastighets-/kvalitetsgevinst, selv om den deterministiske testen bekrefter samtidig
oppstart av uavhengige innlesinger.

Quiet-kontrollen for tilgang og nedlasting har nå 30 vekslende par per rute,
identiske bytes, nedlastingshash mot originalkilden og ingen samtidige betalte
kall. Medianer var omtrent uendret: tilgang small 33,03→31,14 ms, large
31,02→30,29 ms; nedlasting small 22,20→22,25 ms, large 22,97→22,51 ms.
Tidligere p95-utslag ble ikke gjentatt. Rådata:
`http-quiet-access-download-pairs.json`.

Kvalitetsarbeidet starter med deterministiske etterbehandlingsfeil, påvist før
retting. «Maksimal gjenopprettingstid er 90 minutter» fikk feilaktig påført at
målet ikke var tallfestet. En avgrenset naturalspråkvariant bevarer nå varigheten;
ukjente og negerte varigheter samt uvedkommende tall kontrolleres separat.
Leveransefrister i januar/februar/mars/juli traff heller ikke den tidligere
ufullstendige månedslisten. Alle tolv norske måneder og en faktisk uspesifisert
frist testes. Dette er ikke i seg selv verifisert forbedring av hele genereringen;
frosne par og endelig workflow-kontroll gjenstår.


Første kandidatretting av svarbelegg kobler åtte av åtte svar i utviklingscasen
mot null tidligere; eksplisitt 32-kravscase kobler 30 svar, med to bevisst manglende.
Den originale overskriftsvarianten har fortsatt bare tre ekstraherte krav og er
ikke rettet av denne endringen. Ingen nettverk eller modell ble brukt i diagnosen.

En faktisk utviklingsvurdering med første evidenskandidat (`quality-evidence-v1`)
fullførte med komplette provider-svar på 111,26 s mot baseline 101,02 s. Den fant
fem dokumenterte avvik, to gode svar, ett uklart og ingen manglende; baseline hadde
åtte manglende. Blind dommer foretrakk kandidaten og fant den ikke svakere.
Dette er en kvalitetsforbedring på én case, ikke en hastighetsgevinst eller full
kvalitetsgodkjenning. Gjennomgangen fant at en umerket generell pris-/oppstarts-
merknad ble knyttet bare til siste svarlinje. Etterfølgende retting avgrenser
linjesvar ved blanklinje, mens eksplisitte svaroverskrifter beholder underavsnitt
og underoverskrifter. Egen før/etter-regresjon dekker begge grensene. Denne siste
koden er dermed nyere enn den første betalte vurderingen.

Vurderingens registry/validator brukte dessuten «Dokumenttekst krav-ID» som samme
identitet for flere ulike krav. Den kjente parseretiketten beholdes nå som locator,
mens reelle rad-ID-er brukes til eksakt validering. Ombyttede ID-er avvises fortsatt,
og reelle Tabell ID-referanser beholder kontrakten sin.


Den første kvalitetsrettingen er lagret i `5b6e4d33`. 887 frontendtester og 116
rottester bestod uten feil/hopp med lokal SQL; lint og produksjonsbygg bestod.
Ny utviklingsvurdering med den korrigerte svaravgrensningen (`quality-evidence-v2`)
ga alle forventede klassifikasjoner: tre gode og fem dårlige, ingen manglende eller
uklare. Den fullførte på 111,18 s. Holdout-kjøringen er også fullført med komplette
provider-svar; innholdet leses ikke for justering. Parvise dommerkontroller kjører.
Kravsvarpromptene er nå under arbeid for å bevare dokumenterte avvik og merke
konkrete nye leveranser som forslag som må bekreftes, samtidig som kundens bindende
krav og tekniske innhold beholdes. Dette promptarbeidet er ennå ikke godkjent av
live-par eller inkludert i den ovennevnte commiten.


### Samlet kvalitetskandidat `3620dff6`

`quality-evidence-v2` ble foretrukket og vurdert som ikke svakere i begge blinde
par (utvikling og holdout). Utviklingscasen klassifiserer alle åtte riktig: fem
avvik og tre oppfylte krav. Tider 111,18 s / 103,55 s. Dette er kvalitetsbevis på
disse parene, ikke bevis på at vurderingen er raskere. Holdout-svarene er ikke
lest for promptjustering.

`quality-requirement-prompt-v1` bevarer dokumenterte avvik og skiller forslag som
krever bekreftelse fra faktisk leveranse. Begge blinde par foretrekker kandidaten
og vurderer den som ikke svakere. Tidene var 17,48 s / 33,55 s mot 31,17 s / 38,60 s.
Denne versjonen satte imidlertid ikke manuell gjennomgang på forslagene. Den
historiske `quality-requirement-review-v2` har også feilaktig count=0 og false;
den brukte formuleringen «foreslår», som den første metadatarettingen ikke fanget.
Disse livefiler bevares uendret. Nåværende kontroll av «foreslår/foreslås/foreslått»
spilt av mot de åtte faktiske v2-svarene gir korrekt fem kilderader K-1, K-2, K-3,
K-4 og K-7 med stabil ID og rekkefølge. Ny live-kandidat skal kontrollere hele flyten.

Den originale Sundvik-casen ekstraherer nå 32 erklært obligatoriske L01–L32-krav
fra Markdown-overskriftene mot tre tidligere. Alle akseptansekriterier og originale
kildeutdrag beholdes. Svaret «S01 – svar på L01» knyttes bare til målet L01;
originaldokumentets kompakte ID-er var årsaken, ikke en bindestrekforskjell.
30 svar kobles, og bare bevisst ubesvarte L24/L31 mangler. Et eget, entydig alias
kan koble L01 til L-01, men avviser tvetydige kilder og beholder ledende nuller.
Den separate eksplisitte 32-kravsvarianten får også sin reelle kilderekkefølge.
Dette er nettverksfrie kontroller av faktiske parsere; stor live-vurdering gjenstår.

Kandidaten bevarer sene forbehold i allerede avgrensede kildefragmenter og skiller
ulike fragmenter som deler tekstprefiks. HLD-etterbehandlingen beholder hvert
kontinuitetsmål med sitt systemomfang og slutter å kombinere først funnet RTO/RPO
fra ulike systemer. Leveransekrav omtales ikke automatisk som tidsfrister. Nye
regresjoner dekker dette. Felles promptregler skiller verktøystatus fra kundefakta,
krav fra dokumentert leveranse og avvik fra foreslått løsning. Oppgavespesifikke
regler krever konkrete prioriteringer, komponenter, kildeverdier og verifikasjon.
Disse bredere endringene er foreløpig kandidater, ikke samlet kvalitetsgodkjenning.

Samlet kodekontroll av `3620dff6`: **894 frontendtester + 116 rottester**, ingen
feil eller hopp, alle fire SQL-databaser disponibelt lokalt; lint og produksjonsbygg
bestod. Den senere lokale runner-docling-kontrollen er beskrevet nedenfor; Azure/Entra ende-til-ende er fortsatt ikke dekket.

De åtte tidligere umålte analyseseksjonene har nå baseliner på begge små frosne
case (`baseline-sections`). Regenerert tjenesteseksjon har tom katalog og kan ikke
brukes som kvalitetsbevis på reelle tjenesteanbefalinger. Dommerinput for seksjoner
avgrenses til felt fra `customerAnalysisRegenerationContract`; alle felt utenfor
kontrakten sammenlignes deterministisk, med eksplisitt unntak for section_histories.
En endring utenfor kontrakten avvises før dommerkall. Historiske dommerfiler endres
ikke. Fire harness-tester for frosne input og seksjonsgrense består.

Etter seksjonsbaseliner var konservativ avstemt kostnadsøvregrense **10,595398 USD**,
med **3,404602 USD** igjen. Den gamle myke genereringsreserven på 2,5 USD er redusert
til 0,8 USD for den planlagte siste kandidatmatrisen og parvise dommere. Proxyens
harde 14 USD-total, reservasjon før hvert kall, margin og usage-validering er
uendret. `quality-expanded-v1` kjører sekvensielt på alle 22 operasjoner og begge
små frosne case. Ingen parallelle betalte jobber kjøres, og holdout-output leses
ikke under utviklingsgjennomgangen. Faktisk sluttstatus og kostnad gjenstår.


### Avsluttende kontroll og gjenstående bevisgap

Alle 44 `quality-expanded-v1`-genereringer fullførte med frosne identiske input og
komplette provider-utfall. Tolv målrettede korrigeringer fullførte deretter som
`quality-final-corrections-v1`. De betalte originalfilene er ikke omskrevet.
Tidene er enkelttider, ikke p95 eller isolerte bevis på årsak til endret modelllatens.
For eksempel økte lederoppsummeringen til tross for nesten identisk tokenantall,
mens verdiargumentasjonen faktisk ga vesentlig lengre svar. «Ingen tregheter» er
ikke et bestått kriterium for hele applikasjonen.

Det første brede Mini-dommeroppsettet ga 26 kundeanalyse-/seksjons-/HLD-/leder-
operasjoner tilgang til kilder de faktiske generatorene ikke fikk. Disse dommene
utelates som kvalitetsbevis. Alle 26 par er vurdert på nytt med `task-sources-v2`:
kundeanalyse, seksjoner og HLD får kundekilder/støttekilder; lederoppsummering får
bare de faktisk brukte analysesammendragene, vurderingen og arkitektursammenligningen.
De øvrige 18 parene gjelder funksjoner som bruker både kunde- og leverandørgrunnlag.
Mini-resultatene er en separat protokoll fra tidligere GPT-5.4-dommere.

Av de 44 valgte dommene vurderer Mini innholdet som ikke svakere i 28 par og som
vinner i 20. Dette er **ikke en godkjenningsprosent for produktet**. Manuell
utviklingsgjennomgang fant feil i enkelte dommerbegrunnelser: identiske tomme
nøkkelordslister ble dømt som ulike kvalitetsproblemer, og ett behovspunkt ble
kritisert for å mangle detaljer som faktisk stod der. Tom tjenestekatalog og tomt
nøkkelorduttrekk dokumenterer ikke funksjonsforbedring. Negative dommer bevares;
de er ikke automatisk bekreftede faktafeil. Holdout-output er ikke lest for tuning.

Den avsluttende koden retter tre etterbehandlingsfeil uten nye kilder eller modeller:
HLD beholder Markdown-linjeskift/punktlister; kontrolltekst beholder avsluttende
forbehold i avgrensede kildefakta; seksjonsregenerering merger bare mål-felt tilbake
etter normalisering, inklusive avledede nøkkelordtellinger. Et nettverksfritt replay
av 18 betalte seksjonsresultaters mål-felt gjennom den faktiske regeneratoren endret
verken mål-feltene eller øvrige felt og bevarte caller-input. Dette er eierverifikasjon,
ikke en ny provider-kjøring eller full rårespons-replay.

Korrupt rolle-/kontrolltekst i et faktisk strategisvar ble bevart som historisk feil.
Ny generert prosa med slike markører avvises før lagring med en fast, trygg feilmelding.
Ved seksjonsregenerering valideres bare de nye mål-feltene; gammel korrupt strategi
blokkerer ikke et rent sammendrag. Opprinnelige kildeutdrag, diagrammer og andre
ikke-genererte felt endres ikke av vakten. Både falsk passering og for bred avvisning
ble demonstrert med røde regresjoner før retting.

Siste kravsvarprompt starter med dokumentert avvik og merker den nye leveransen
som et forslag som krever bekreftelse. Utviklingsgjennomgangen bekreftet K-1/2/3/4/7
som fem avvik, K-5/6/8 som dokumentert leveranse, og alle fem riktige live-metadataflagg.
Løsningsutkastet viser de fem avvikene og merkede forslag; gjennomføringsplanen
lukker avvik uten å gjøre et bindende Norge-krav til et udokumentert unntak.
Den faktiske kravsvarjobben `2ca4dd16-9291-40c3-8e1c-0d7de088ab19` fullførte på
15,00 s intern total / 16,09 s inkludert polling. Artefaktet er lagret med riktig
jobbkobling, 8/8 kilderader, 5 korrekte review-refs og `is_current/source_is_current=true`.
Dette er et lokalt workflow-bevis, ikke et sammenlignbart før/etter-jobbtidspar.

Autentisert headless Chromium kontrollerte analyse og kravsvar ved 1440×1000 og
390×844 uten JavaScript-feil eller sideoverflow. En reell smal artefaktheader ble
rettet med handlinger på egen mobilrad; tittelen fikk 300 px lesebredde. Ferdige
skjermbilder ligger i `browser-final/mobile-header/`. Den eldre `desktop-analysis.png`
viser bare innlasting og brukes ikke som ferdig layoutbevis. PDF-eksporten beholdt
alle åtte krav og fem varsler på to A4-sider; begge sider ble rendret og kontrollert.
Ingen PDF-hastighetsgevinst er dokumentert.

Siste rolige API-kontroll har 30 vekslende par per rute, identiske responshasher,
originalbytes ved nedlasting og ingen samtidige modellkall, bygg eller skriving.
Stor artefaktlesing: median 315,05→46,66 ms, p95 332,16→52,01 ms. Stor
lederoppsummeringslesing: 58,85→40,69 ms, p95 65,08→53,15 ms. Tomme tjenestelister,
tilgang og dokumentnedlasting var omtrent uendret; enkelte små p95-forskjeller
beviser ikke nye årsaker. Rådata: `http-quiet-final-control-pairs.json` og
`http-quiet-final-access-download-pairs.json`.

Fullgenererte kundeanalyser i de parvise filene er eldre enn den siste rettingen av
220-tegnskuttet i etterbehandlingen. Den rettingen har deterministisk regresjon,
men ingen ny full modellkjøring. Stor original Sundvik-vurdering etter alle
parserrettinger, AI-generering med tjenestekataloginnhold, fullstendig forbedringsløp,
Azure-opplasting/metadata/indeksering, Entra, worker-avbrudd og bred produksjons-
samtidighet er fortsatt ikke komplett før/etter-verifisert. Lokal AMD64-smoke og
den lille konverteringskontrollen nedenfor dekker bare den avgrensede funksjonen.
Disse gapene kan ikke
fylles med grønne enhetstester, tomme kontrollister eller bedre enkelttall.

Autentisert readiness returnerte 503 i det lokale miljøet: runtime og PostgREST var friske, men én påkrevd konfigurasjon og Azure Blob-proben manglet. Anonym readiness var korrekt avvist med 401; liveness returnerte 200. Dette er et dokumentert miljøgap, ikke en grønn readiness-påstand. OpenAI-komponenten kontrollerer bare konfigurert nøkkel og beviser ikke et aktivt modellkall.

Lokal `runner-docling` bygget og bestod Docker health/liveness med exit 0 og
image-størrelse 1 623 366 674 bytes. Buildx-registeret for
`w6q3qfid7slo3b0j6axs3ak4o` bekrefter **linux/arm64**; produksjonsworkflowen
krever **linux/amd64**. Dette er derfor en lokal ARM-smoke, ikke verifikasjon av
produksjonsimaget, dokumentkonvertering eller Azure. Første forsøk ble avbrutt
fordi Docker credential helper hang; samme offentlige pinned images bygget med
separat tom Docker-konfigurasjon. Smoke-scriptet fjernet sitt image etter testen;
plattformen er bekreftet i det bevarte byggregisteret uten et nytt bygg.

Det samme `runner-docling`-targetet ble deretter bygget for **linux/amd64** med
eksisterende Dockerfile og pinned base-images. Buildx-registeret
`z267z7bm90v1lc2fawmjlnnn8` og faktisk image inspect bekrefter plattformen;
imaget bruker `node` og er 1 694 373 677 bytes. Docker health/liveness bestod.
Det samme imaget konverterte den eksisterende lille Nordic Utilities-PDF-en
(3 sider, 5858 bytes) til Markdown og JSON **uten nettverk**. Appens eksplisitte
Docling-argumenter ble brukt, med OCR avslått for denne digitale PDF-en.
Alle 12 kontrollerte kildefakta ble bevart: kunden, 140 applikasjoner, RTO/RPO,
D1–D5, tilbudsfristen og blackout-periodens datoer og cutover-forbud. JSON hadde
proveniens fra side 1, 2 og 3; Markdown hadde 3866 tegn. Konverteringen tok
24,48 s under lokal AMD64-emulering; dette er ingen produksjonslatensmåling.
OCR, Next-orkestrering og Azure-ingest er ikke prøvd av denne CLI-kontrollen.
Det egne imaget og konverteringscontaineren ble fjernet etter vellykket kontroll.
Bevis finnes i `verification/docling-amd64/` og bygg-/smokeloggene.

SSE-kontrollen brukte en egen manuelt opprettet lokal jobbstatus, to autentiserte
HTTP-klienter og faktisk statusrute. Begge mottok `running`; frakobling av én
stoppet verken den andre klientens heartbeat eller den lagrede jobbstatusen.
En manuelt lagret `failed`-status ble levert, og strømmen lukket. Anonym tilgang
ga 401. Testprosjekt og jobb ble slettet, og API-kostnadsloggen var uendret.
Dette tester abonnentfrakobling og statuslevering, ikke worker-utførelse,
brukerstyrt jobbavbrudd eller før/etter-hastighet. Ruten har ikke et eget
avbruddsendepunkt; lease-avbrudd har separat regresjonsdekning.

En egen disponibel database med kopiert skjema fikk tre fiktive tjenester med
krypterte dokumenter. Faktiske baseline-/kandidat-repositorier returnerte identiske
resultater i 30 vekslende par, både med og uten opt-in-sammendrag. Valgt og relevant
backup-tjeneste, irrelevant lønnstjeneste, dokumentkobling og dekryptering bestod.
Den faktiske valg-RPC-en byttet valg, dedupliserte og tømte dem. Median uten
sammendrag var 8,32→8,29 ms; med sammendrag 8,15→7,85 ms. Dette er omtrent
uendret, ikke betydelig raskere. Next-cache var forbikoblet i begge eiere; samme
kandidatskjema ble brukt for begge kodeversjoner. Ingen HTTP-skriving,
cacheinvalidering, AI-anbefaling eller Azure-opplasting er bevist av denne testen.
Databasen/containeren ble fjernet; frosne AI-fixturer og API-budsjett ble bevart.

Katalogkontrollen ble deretter utvidet med en separat lokal standalone-app og
faktiske HTTP GET/PATCH-ruter. Anonym lesing/skriving ga 401, ugyldige valg ga
400, og varme kataloglesinger ble fulgt av tre korrekt lagrede og gjenleste
valgtransisjoner: ett valg, to identiske ID-er deduplisert til ett valg og tomt valg.
Dette kjørte den faktiske Next-invalideringen uten mock. Første forsøk delte
standalone-treets diskcache med en annen lokal app og fikk feilaktig dennes tomme
katalog; feilloggen er bevart. Ny kjøring isolerte også runtime/diskcache og bestod.
Dette er rettet testisolasjon, ikke en påstått produksjonsfeil eller appretting.
Nettleserens klientcache og AI-anbefalinger er fortsatt ikke dekket av kontrollen.

## Gjenstående arbeid etter denne kontrollen

| Bevisbehov | Kan utføres uten nye modellkall? | Hva det vil bevise |
| --- | --- | --- |
| Videre nettleserkontroll av tjenestevalg/klientcache og flere eksporttyper | Ja, med egne isolerte fixturer | Browser-atferden; tjenestevalgenes HTTP GET/PATCH og Next-invalidering er nå kontrollert |
| Fullstendig friskt kundeanalyseløp etter siste etterbehandlingsretting; stor original Sundvik; befolket AI-katalog; hele forbedringsløpet | Nei, krever nye reserverte modellkall og parvis kvalitetskontroll | Endelig modellatferd på disse inngangene |
| Gjentatte før/etter-genereringer, p95, kvalitetsdommer og representative samtidige AI-jobber | Nei, krever flere betalte repetisjoner og definert last | Variasjon og samlet latens; ett par per funksjon er utilstrekkelig |
| Entra, Azure-lagring og full ingest med faktiske tjenester | Krever et autorisert egnet miljø; metadata/indeksering kan også bruke modeller | De faktiske identitets-, lagrings- og ingestintegrasjonene |

Den kostnadsfrie kontrollen gjør ikke alle disse gjenværende bevisene unødvendige.
Samlet mål er fortsatt aktivt og ikke oppfylt; ingen høyere budsjettramme eller
produksjonsoperasjon er antatt autorisert.
