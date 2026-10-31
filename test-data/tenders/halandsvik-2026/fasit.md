# Fasit – Hålandsvik kommune, skyplattform og drift (e2e 2026-10-31)

Skrevet før noen pipeline-kjøring. SHA-256 for `fasit.json` ved forfatting: `342e452390cccb9c06979d5116665e1403d689471b90ed8c8996cb32671fdf66`.

## Dokumenter

- `01_Konkurransegrunnlag_Halandsvik_kommune.pdf` – primary_customer_document (PDF, 4 s., rettelse i kap. 9 s. 4)
- `02_Bilag_1_Kravspesifikasjon_Halandsvik_kommune.pdf` – supporting_document / kravdokument (PDF, 3 s., 24 krav)
- `03_Bilag_2_Evaluering_og_tildeling_Halandsvik_kommune.docx` – supporting_document / vedlegg (DOCX, vekter og modell)
- `04_Losningsnotat_Atea_Halandsvik.docx` – primary_solution_document (DOCX, Ateas løsningsnotat med forbehold)

## Krav (24: 15 skal, 9 bør)

| ID | Type | Side | Plassering | Ordrett kravtekst | Forventet kravsvar |
|---|---|---:|---|---|---|
| K-2.1 | skal | 1 | prosa med ID først | Leverandøren skal ha et styringssystem for informasjonssikkerhet som er sertifisert etter ISO/IEC 27001:2022. Gyldig sertifikat skal legges ved tilbudet. | oppfylt: ISO/IEC 27001:2022, sertifikat NO-ISMS-48211. |
| K-2.2 | bør | 1 | prosa med ID først | Leverandøren bør ha minst tre referanseprosjekter fra de siste fem årene der leverandøren har driftet skybaserte fagsystemer for kommuner eller fylkeskommuner med mer enn 500 brukere. | delvis: Bare to referanser (Vestre Lia kommune, Søre Bø interkommunale IKT); kravet ber om tre. Svaret må ikke påstå tre. |
| K-2.3 | skal | 1 | prosa med ID først | Leverandøren skal utpeke en navngitt kundeansvarlig og en teknisk kontaktperson som begge behersker norsk muntlig og skriftlig. | oppfylt: Ingrid Sæther (kundeansvarlig) og Bjørn Østvik (teknisk), norskspråklige. |
| K-3.1.1 | skal | 1 | Tabell 3-1 (over sideskift s. 1–2) | Alle kundedata, inkludert sikkerhetskopier og logger, skal lagres og behandles i datasentre innenfor EØS. | oppfylt: Alle data i Norge (Norway East/West). |
| K-3.1.2 | skal | 1 | Tabell 3-1 (over sideskift s. 1–2) | Plattformen skal driftes fra minst to geografisk adskilte datasentre med en avstand på minst 30 km mellom primær- og sekundærlokasjon, slik at bortfall av ett datasenter ikke medfører tap av data. | oppfylt: Norway East (Oslo) og Norway West (Stavanger), over 300 km. |
| K-3.1.3 | bør | 1 | Tabell 3-1 (over sideskift s. 1–2) | Leverandøren bør tilby lagring i datasentre i Norge for særlige kategorier av personopplysninger, uten tillegg i pris. | oppfylt: Lagring i Norge inngår i fastprisen. |
| K-3.1.4 | bør | 1 | Tabell 3-1 (over sideskift s. 1–2) | Plattformen bør drives med minst 90 % fornybar energi, dokumentert med opprinnelsesgarantier eller tilsvarende. | oppfylt: 100 % fornybar, opprinnelsesgarantier. |
| K-3.2.1 | skal | 1 | Tabell 3-1 (over sideskift s. 1–2) | Leverandøren skal etablere kryptert forbindelse (IPsec VPN eller privat linje) mellom kommunens nett i Hålandsvik rådhus og skyplattformen, med en båndbredde på minst 1 Gbit/s. | oppfylt: IPsec VPN 1 Gbit/s. |
| K-3.2.2 | skal | 1 | Tabell 3-1 (over sideskift s. 1–2) | All administrativ tilgang til plattformen skal skje med flerfaktorautentisering via et eget administrasjonsnett som er logisk adskilt fra brukertrafikken. | oppfylt: MFA og separat administrasjonsnett. |
| K-3.2.3 | bør | 2 | Tabell 3-1 (over sideskift s. 1–2) | Leverandøren bør støtte IPv6 i hele plattformen innen 12 måneder etter kontraktsinngåelse. | ikke_oppfylt: IPv6 er ikke planlagt i kontraktsperioden. Svaret må ikke love IPv6. |
| K-3.3.1 | skal | 2 | Tabell 3-1 (over sideskift s. 1–2) | Leverandørens driftssenter skal være bemannet 24 timer i døgnet, 7 dager i uken, og ligge innenfor EØS. | oppfylt: Oslo 24/7 med reservesenter i Kraków (Polen, EØS). |
| K-3.3.2 | skal | 2 | Tabell 3-1 (over sideskift s. 1–2) | Personell med administrativ tilgang til kommunens miljø skal ha levert politiattest som ikke er eldre enn tre måneder ved tiltredelse. | oppfylt_med_merknad: Politiattest ved tiltredelse; tremånedersgrensen er ikke uttrykkelig bekreftet i notatet. |
| K-3.3.3 | bør | 2 | Tabell 3-1 (over sideskift s. 1–2) | Leverandøren bør stille med et fast team på minst fire navngitte driftsressurser for Hålandsvik kommune, hvorav minst én har sertifisering på ekspertnivå innen den tilbudte skyplattformen. | oppfylt: Fire navngitte ressurser, to med Azure Solutions Architect Expert. |
| K-4.1.1 | skal | 2 | tabell 4.1 | Tilgjengeligheten for kritiske fagsystemer (Gerica, Visma Flyt Skole og Acos WebSak) skal være minst 99,8 % per måned, målt i tidsrommet 06:00–22:00 alle dager. | oppfylt: 99,8 % 06:00–22:00. |
| K-4.1.2 | skal | 2 | tabell 4.1 | Leverandøren skal gjenopprette kritiske fagsystemer innen 8 timer (RTO) etter en alvorlig hendelse, med et maksimalt datatap på 1 time (RPO). **Gjeldende (rettelse):** Leverandøren skal gjenopprette kritiske fagsystemer innen 4 timer (RTO) etter en alvorlig hendelse, med et maksimalt datatap på 15 minutter (RPO). | oppfylt_mot_endret_krav: Svaret må gjelde endret krav: RTO 4 timer og RPO 15 minutter (ikke 8 timer / 1 time). Atea leverer nøyaktig 4 t / 15 min. |
| K-4.1.3 | bør | 2 | tabell 4.1 | Leverandøren bør levere en månedlig tjenestenivårapport med trendanalyse og forslag til forbedringstiltak innen femte virkedag i påfølgende måned. | oppfylt: Månedlig rapport innen femte virkedag. |
| K-4.2.1 | skal | 2 | innrykket liste | Kritiske hendelser skal besvares innen 15 minutter hele døgnet, og kommunens IT-vakt skal varsles på telefon innen 30 minutter. | oppfylt: 15 min respons, varsling innen 30 min. |
| K-4.2.2 | skal | 2 | innrykket liste | Leverandøren skal kunne stille med tekniker fysisk på Hålandsvik rådhus innen 4 timer ved kritiske hendelser, hele døgnet. | avvik: Forbehold: fysisk oppmøte innen 4 t bare hverdager 07:00–17:00, ellers inntil 8 t. Minstekrav er ikke oppfylt; forbeholdet må bevares, og svaret må ikke påstå full oppfyllelse. |
| K-4.2.3 | bør | 2 | innrykket liste | Leverandøren bør gjennomføre en felles beredskapsøvelse med kommunen minst én gang per år, inkludert full gjenoppretting av minst ett kritisk fagsystem fra sikkerhetskopi. | oppfylt: Årlig beredskapsøvelse med full gjenoppretting. |
| K-5.1 | skal | 2 | prosa med ID først | Leverandøren skal inngå databehandleravtale med kommunen i tråd med personvernforordningen artikkel 28, basert på kommunens mal i Bilag 5. | oppfylt: Signerer kommunens databehandleravtale. |
| K-5.2 | skal | 2 | prosa med ID først | Sikkerhetsbrudd som berører personopplysninger skal meldes til kommunen uten ugrunnet opphold og senest 24 timer etter at leverandøren ble kjent med bruddet. | oppfylt: Varsler sikkerhetsbrudd innen 24 timer. |
| K-5.3 | bør | 2 | prosa med ID først | Kommunen bør kunne forvalte egne krypteringsnøkler (kundestyrte nøkler) for lagring av særlige kategorier av personopplysninger. | opsjon_tilleggspris: Kundestyrte nøkler (Managed HSM) inngår ikke i fastprisen, prises som tilleggsopsjon. Må ikke fremstilles som inkludert. |
| K-6.1 | skal | 3 | prosa med ID først | Leverandøren skal levere en exitplan senest 3 måneder etter kontraktsinngåelse. Exitplanen skal minst omfatte: a) eksport av alle data i åpne, dokumenterte formater, b) tidsplan for tilbakeføring til kommunen eller ny leverandør, og c) ansvarsfordeling og bistand ved overføring til ny leverandør. | oppfylt: Exitplan med a, b og c innen 3 måneder. |
| K-6.2 | bør | 3 | prosa med ID først | Leverandøren bør gjennomføre migreringen fra dagens løsning uten nedetid for kritiske fagsystemer i kommunens åpningstid (08:00–15:30). | oppfylt: Migrering i helgevinduer uten nedetid i åpningstid. |

## Erstattede verdier

- **Tilbudsfrist**: 3. november 2026 kl. 12:00 (01_Konkurransegrunnlag_Halandsvik_kommune.pdf s. 2 (tabell 5.1)) → **10. november 2026 kl. 12:00** (01_Konkurransegrunnlag_Halandsvik_kommune.pdf s. 4 (kap. 9, Rettelse nr. 1 av 14.10.2026, punkt 1))
- **Krav K-4.1.2**: Leverandøren skal gjenopprette kritiske fagsystemer innen 8 timer (RTO) etter en alvorlig hendelse, med et maksimalt datatap på 1 time (RPO). (02_Bilag_1_Kravspesifikasjon_Halandsvik_kommune.pdf s. 2 (tabell 4.1)) → **Leverandøren skal gjenopprette kritiske fagsystemer innen 4 timer (RTO) etter en alvorlig hendelse, med et maksimalt datatap på 15 minutter (RPO).** (01_Konkurransegrunnlag_Halandsvik_kommune.pdf s. 4 (kap. 9, punkt 2))

## Nøkkelfakta for kundeanalysen

- F01 (kunde): Oppdragsgiver er Hålandsvik kommune (ca. 14 200 innbyggere, 1 150 ansatte). – 01_Konkurransegrunnlag_Halandsvik_kommune.pdf s. 1–2
- F02 (kunde): Anskaffelsen gjelder skyplattform og drift av kommunale fagsystemer (ca. 40 fagsystemer) med overgang fra eget serverrom. – 01_Konkurransegrunnlag_Halandsvik_kommune.pdf s. 2
- F03 (prosedyre): Åpen anbudskonkurranse etter anskaffelsesforskriften del III; ikke adgang til forhandlinger. – 01_Konkurransegrunnlag_Halandsvik_kommune.pdf s. 1, 3
- F04 (frister): Spørsmålsfrist 20. oktober 2026 kl. 12:00. – 01_Konkurransegrunnlag_Halandsvik_kommune.pdf s. 2
- F05 (frister): Gjeldende tilbudsfrist er 10. november 2026 kl. 12:00 (endret ved rettelse nr. 1 fra 3. november). – 01_Konkurransegrunnlag_Halandsvik_kommune.pdf s. 4 (rettelse)
- F06 (frister): Vedståelsesfrist 28. februar 2027. – 01_Konkurransegrunnlag_Halandsvik_kommune.pdf s. 2
- F07 (kontrakt): Kontrakt 3 år fra 1. mars 2027, opsjon på forlengelse 1 + 1 år, SSA-D. – 01_Konkurransegrunnlag_Halandsvik_kommune.pdf s. 1–2
- F08 (verdi): Anslått samlet verdi inkl. opsjoner NOK 18 400 000 ekskl. mva.; basis 3 år NOK 11 200 000. – 01_Konkurransegrunnlag_Halandsvik_kommune.pdf s. 2
- F09 (opsjoner): Opsjon 2: utvidelse til Nordre Fjære kommune (ca. 600 brukere, NOK 2 400 000). – 01_Konkurransegrunnlag_Halandsvik_kommune.pdf s. 2
- F10 (evaluering): Vekter: Pris 40 %, Kvalitet 35 %, Gjennomføring og kompetanse 15 %, Miljø og bærekraft 10 % (sum 100 %). – 03_Bilag_2_Evaluering_og_tildeling_Halandsvik_kommune.docx tabell 1
- F11 (evaluering): Underkriterier Kvalitet: 2.1 Arkitektur og sikkerhet 20 %, 2.2 Drift, beredskap og tjenestenivå 15 %. – 03_Bilag_2_Evaluering_og_tildeling_Halandsvik_kommune.docx tabell 1
- F12 (evaluering): Skal-krav er minstekrav som gir avvisning; bør-krav evalueres. – 02_Bilag_1_Kravspesifikasjon_Halandsvik_kommune.pdf s. 1; 03_Bilag_2_Evaluering_og_tildeling_Halandsvik_kommune.docx kap. 3
- F13 (krav): Gjeldende RTO 4 timer og RPO 15 minutter for kritiske fagsystemer (K-4.1.2 endret). – 01_Konkurransegrunnlag_Halandsvik_kommune.pdf s. 4
- F14 (krav): Tilgjengelighet minst 99,8 % per måned kl. 06:00–22:00 for Gerica, Visma Flyt Skole og Acos WebSak. – 02_Bilag_1_Kravspesifikasjon_Halandsvik_kommune.pdf s. 2
- F15 (krav): Data og driftssenter innenfor EØS; driftssenter kan ligge utenfor Norden (spørsmål og svar). – 02_Bilag_1_Kravspesifikasjon_Halandsvik_kommune.pdf s. 1–2; 01_Konkurransegrunnlag_Halandsvik_kommune.pdf s. 4
- F16 (krav): Fysisk tekniker på Hålandsvik rådhus innen 4 timer hele døgnet ved kritiske hendelser (K-4.2.2). – 02_Bilag_1_Kravspesifikasjon_Halandsvik_kommune.pdf s. 2
- F17 (kvalifikasjon): Kvalifikasjonskrav: omsetning minst NOK 25 millioner, to driftsoppdrag siste tre år, ISMS. – 01_Konkurransegrunnlag_Halandsvik_kommune.pdf s. 3
- F18 (kjøpsdriver): Kjøpsdriver: serverrom i rådhuskjelleren med dårlig brannsikring, 30 min reservestrøm, tilsynsrapport 2025. – 01_Konkurransegrunnlag_Halandsvik_kommune.pdf s. 2

## Kvalifikasjonskrav uten ID (ikke kravsvar-scope)

- Leverandøren må ha hatt en årlig omsetning på minst NOK 25 millioner i siste avlagte regnskapsår.
- Leverandøren må dokumentere minst to gjennomførte driftsoppdrag av tilsvarende art og omfang de siste tre årene.
- Leverandøren må ha et ledelsessystem for informasjonssikkerhet, dokumentert med sertifikat eller tilsvarende beskrivelse.

## Feller

- T01 Historisk distraktor: Bilag 1 s. 2, «Bakgrunn» under kap. 4: «Under den forrige driftsavtalen med Fjellnett Drift AS (2019–2025) skulle sikkerhetskopier tas ut på bånd hver fredag og fraktes til kommunens serverrom på Kvernhusbakken, og leverandøren måtte gjenopprette data manuelt fra bånd ved behov. Ordningen ble avviklet i februar 2025 og videreføres ikke.» Fortid (skulle/måtte), ingen krav-ID. Skal ikke bli krav i ledger/kravsvar og ikke fremstilles som gjeldende krav (båndkopi, Kvernhusbakken) i analysen.
- T02 Erstattet tilbudsfrist: 3. november 2026 kl. 12:00 (tabell s. 2) er erstattet av 10. november 2026 kl. 12:00 (rettelse s. 4). Den gamle datoen må ikke oppgis som gjeldende frist.
- T03 Erstattet krav K-4.1.2: Original 8 timer RTO / 1 time RPO i Bilag 1 er erstattet av 4 timer / 15 minutter via rettelse i et annet dokument (konkurransegrunnlaget). Kravsvar og analyse må bruke 4 t / 15 min.
- T04 Spørsmålsfrist før tilbudsfrist: 20. oktober 2026 er spørsmålsfrist, ikke tilbudsfrist; vedståelsesfrist 28. februar 2027 er heller ikke tilbudsfrist.
- T05 Basisverdi vs. samlet verdi: NOK 11 200 000 er basis 3 år; NOK 18 400 000 er samlet inkl. opsjoner, ekskl. mva. Ikke bytt om, ikke legg til mva.
- T06 Vekter summerer til 100: Underkriteriene 20 % + 15 % ligger inne i Kvalitet 35 %. Ikke summer til 135 % eller list underkriterier som egne hovedkriterier.
- T07 Bør er ikke minstekrav: De 9 bør-kravene gir ikke avvisning. Kravsvar/analyse må ikke fremstille f.eks. IPv6 (K-3.2.3) eller kundestyrte nøkler (K-5.3) som avvisningsgrunner.
- T08 Tabell over sideskift: Tabell 3-1 har K-3.1.1–K-3.2.2 på s. 1 og K-3.2.3–K-3.3.3 på s. 2 med gjentatt tabellhode. Alle 10 rader skal med; tabellhodet skal ikke bli krav.
- T09 Hierarkiske ID-er: K-3.2.1 osv. må beholdes med tre nivåer (ikke K-3.2 eller K-3.2.1.). Seksjonsnumre (3.1, 4.2) og «Tabell 3-1» er ikke krav-ID-er.
- T10 Krysshenvisninger i Bilag 2: Bilag 2 nevner bør-krav-ID-er; disse skal ikke bli nye/dupliserte krav.
- T11 Instruksjonssetning: «Leverandøren skal besvare hvert krav i tilbudets kravsvar …» (Bilag 1 s. 1) er instruks uten ID, ikke krav.
- T12 Leverandørforbehold K-4.2.2: Løsningsnotatet har uttrykkelig forbehold (oppmøte 4 t bare hverdager 07–17, ellers 8 t). Kravsvaret må bevare forbeholdet og ikke påstå oppfyllelse.
- T13 Opsjon med tilleggspris K-5.3: Kundestyrte nøkler prises som tilleggsopsjon; må ikke fremstilles som inkludert.
- T14 Ikke-levert bør-krav K-3.2.3: IPv6 ikke planlagt; kravsvar må ikke love IPv6.
- T15 Delvis oppfylt K-2.2: To referanser, ikke tre; kravsvar må ikke påstå tre.

## Scope

Kravsvar-scope er de 24 K-kravene i Bilag 1. Kvalifikasjonskravene i konkurransegrunnlaget kap. 6 (3 punkt uten ID, besvares via ESPD) er fakta for kundeanalysen; hvis de trekkes ut som krav telles de som 'forsvarlig ekstra', ikke som harde falske positive. Alt annet uten K-ID er falske positive.
