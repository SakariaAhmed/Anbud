# Produksjonsnær akseptanserapport – 14. august 2026

## Konklusjon

Løsningen har fungerende RBAC, kodebasert gjesteinnlogging og administrasjonsside. Tilgangskontrollene bestod de målrettede produksjonstestene, og den komplette arbeidsflyten kunne ferdigstilles på et fiktivt prosjekt med Bilag 1, Bilag 2, teamroller, gruppe, gjester og fire genererte artefakttyper.

Produksjonen er likevel bare **betinget godkjent** frem til to lokale rettelser er deployet:

1. Produksjonens gamle PDF-parser kan feile når flere PDF-er behandles i samme prosess.
2. En ren kravpunktliste blir i produksjon bare delvis tolket, mens en strukturert kravtabell fungerer.

Begge feilene er rettet lokalt og verifisert med full testsuite, men er ikke deployet uten eksplisitt godkjenning.

## Testgrunnlag

- Miljø: aktiv Azure Container Apps-produksjon.
- Revisjon under test: `anbud--sha-4afb504ed1fe18b1386c752e211ef95a21fcf4f7`.
- Fiktivt prosjekt: `TEST - Aurora RBAC 2026-08-14`.
- Fiktiv kunde: `Nordlys Energi AS`.
- Dokumenter: Bilag 1, Bilag 2 og et klassifisert kravdokument.
- Valgte tjenester: 3 av 19 tilgjengelige.
- Ingen reelle e-postadresser eller persondata ble brukt.
- Midlertidige økter ble tilbakekalt, midlertidig administratorrolle ble fjernet, og eksponerte testkoder ble rotert eller tilbakekalt.

## Migrasjon

Migreringen er bekreftet både gjennom fullført migreringsjobb og gjennom direkte bruk av de nye produksjonsobjektene. Følgende tabeller svarte med HTTP 200 i live Data API:

- `app_principals`
- `app_sessions`
- `project_memberships`
- `app_groups`
- `app_group_members`
- `project_group_grants`
- `guest_credentials`
- `activity_events`

Konklusjon: migreringen er vellykket i aktivt produksjonsmiljø; dette bygger på live objekter og funksjonell bruk, ikke bare jobbstatus.

## RBAC og team

| Rolle/testidentitet | Tildeling | Resultat |
|---|---|---|
| Prosjekteier | Owner | Full prosjekttilgang bestod |
| Teamleder | Editor | Lese- og skriveoperasjoner bestod |
| Bid manager | Editor | Lese- og skriveoperasjoner bestod |
| Løsningsarkitekt | Viewer | Lesing/nedlasting bestod; skriving avvist |
| Sikkerhetsarkitekt | Viewer via gruppe | Gruppetilgang bestod |
| QA | Restricted viewer | Lesing bestod; nedlasting og skriving avvist |
| Utenforstående | Ingen rolle | Prosjekt skjult med 404 |
| Administrator | Global admin | Global lesing/deling bestod; innholdsskriving var korrekt avvist |

Direkte roller og gruppebasert rolle ble kombinert korrekt etter sterkeste gyldige prosjekttilgang. Eier var eneste rolle som kunne endre deling.

## Gjester med bare kode

- Gyldig kode uten brukernavn/e-post: bestod.
- Ugyldig kode: 401.
- Viewer-gjest: kunne lese og laste ned, men ikke skrive.
- Restricted-gjest: kunne lese, men ikke laste ned eller skrive.
- Gjesten fikk ikke administrasjonsside eller prosjektoppretting.
- Tilbakekalling ugyldiggjorde aktiv økt umiddelbart.
- Koderotasjon ugyldiggjorde både gammel kode og eksisterende økt.
- Ingen e-post ble sendt under testen.

## Administrasjonsside

- Administrator fikk siden og innholdet `Tilgang og innsikt`.
- Ikke-administrator fikk ikke administrasjonsinnhold.
- Next.js returnerer teknisk HTTP 200 for den streamede `notFound`-responsen, men innholdet er 404 og administrasjonsdata lekker ikke. Dette er en mindre observabilitets-/statuskodeulempe, ikke en tilgangslekkasje.
- Bruker-, gruppe-, medlems- og prosjektgrant-operasjoner bestod for administrator.

## Arbeidsflyt og innholdskvalitet

| Funksjon | Resultat | Kvalitet / måling |
|---|---|---|
| 1. Dokumenter | Betinget | Begge Bilag ble ferdig behandlet; produksjonsparserfeil ble avdekket |
| 2. Tjenester | Bestått | 19 tilgjengelige, 3 valgt, GET/PATCH bestod |
| 3. Kundeanalyse | Bestått | 22 096 tegn; kunde, K-krav, risiko og tjenester dekket |
| 4. Krav og svar – punktliste | Feiler i produksjon | Bare K-01 av K-01–K-08 kom i ledgeren; lokal rettelse gir 8/8 |
| 4. Krav og svar – entydige tabellrader | Bestått | 24 360 tegn; K-01–K-08, svar og kildegrunnlag dekket |
| 5. Løsningsforslag | Bestått | 8 754 tegn; kunde, sikkerhet, roller og tilgang dekket |
| 6. Vurdering | Bestått | 42 989 tegn i sluttkjøring; kravdekning og anbefaling dekket |
| 7. Fremdriftsplan | Bestått | 11 512 tegn; milepæler, risiko, test og akseptanse dekket |
| 8. Lederoppsummering | Bestått | 1 739 tegn; beslutning/anbefaling og risiko dekket |
| AI Chat | Bestått | Ca. 4,0 s; presist, kildebasert svar med L-08 og administratortilgang |
| Bilag 1-utkast | Bestått | 16 522 tegn; K-01–K-08 og tydelig testmerking |

Sluttstatusen var stabil med kundeanalyse, løsningsvurdering og lederoppsummering lagret samtidig. Artefaktlisten inneholdt:

- `forbedret_kravsvar`
- `bilag1_rekonstruksjon`
- `gjennomforing_og_risiko`
- `losningsutkast`

Kilde-revisjonsgjerdene stoppet korrekt lagring når dokumentgrunnlaget endret seg under AI-kjøring. Dette ga nødvendige retries, men hindret stale eller blandede resultater.

## Hastighet

| Operasjon | Måling |
|---|---:|
| Kjerne-API p50 | 47 ms |
| Kjerne-API p95 | 86 ms |
| Første kaldopplasting | 3 104 ms |
| Senere opplasting | 171–226 ms |
| Basisdokumentinntak | 0,4–1,1 s |
| Docling-forbedring | 13,7 s |
| Kundeanalyse, endelig | 79,2 s |
| Krav og svar, strukturert | 52,8 s |
| Løsningsforslag | 13,4 s |
| Løsningsvurdering, endelig | 158,1 s |
| Fremdriftsplan | 11,9 s |
| Lederoppsummering, endelig | 4,1 s |
| Bilag 1-utkast | 70,8 s |
| AI Chat | 4,0 s |

Kjerne-API-et er raskt. AI-jobbene dominerer responstiden. Løsningsvurdering er tydelig flaskehals; tidligere kjøring tok 208,8 s etter én 60-sekunders leverandør-timeout og innebygd retry. Timeout/retry fungerte, men bør overvåkes med p95/p99 og leverandørfeilrate.

## Sikkerhet

Bestått:

- minst privilegium for owner/editor/viewer/restricted/admin;
- IDOR-beskyttelse og skjuling av prosjekter for utenforstående;
- umiddelbar øktinvalidering ved gjesterevokering og koderotasjon;
- HMAC-beskyttede gjestekoder og rate limiting;
- origin-kontroll på skrivende kall;
- CSP, HSTS, `frame-ancestors`/frame-nekt og `nosniff`;
- sikre nedlastingshoder og canonical MIME;
- filsignatur-, størrelses- og dokumentbudsjettkontroller;
- kryptert lagring og redigerte produksjonsfeil;
- secrets-scan uten funn;
- `npm audit --omit=dev`: 0 kjente sårbarheter.

Åpne sikkerhets-/driftsnotater:

- Den produksjonsaktive PDF-parserfeilen er en tilgjengelighetsrisiko. Lokal rettelse isolerer kompatibilitetsparseren i en egen, tids- og minnerestriktiv worker per dokument og faller tilbake til moderne PDF.js med dynamisk kodeevaluering deaktivert.
- Uautorisert adminside bruker streamet 404-innhold med HTTP 200. Ingen lekkasje ble funnet, men statuskoden kan gjøre overvåking mindre presis.

## Lokale rettelser

1. PDF-parsing er flyttet til en isolert worker per dokument, med 120 s timeout, minnerammer og moderne sikker fallback.
2. Sekvensiell Bilag1 → Bilag2 → Bilag1 parsing består med K-08/L-08/K-08 på 431/19/19 ms.
3. Petoro-orakelet består eksakt med 74/74 kildeordnede krav.
4. Rene punktlister med eksplisitte K-ID-er bevarer nå alle kravrader.
5. Markdown-tabeller godtar også intuitive norske kolonnenavn som `Kravtekst` og `Leverandørens svar`.
6. Sidepanelet bruker korrekt `Lederoppsummering` og tillater ordbrudd/hyphenation på smal bredde.

## Verifikasjon av rettelsene

- Full testsuite: 769 tester, 761 bestått, 8 eksplisitt hoppet over, 0 feil.
- Tilgangs-/sikkerhetstester: 33/33.
- PDF-regresjonstester: 2/2.
- TypeScript: bestått.
- ESLint med null tillatte advarsler: bestått.
- Produksjonsbygg: bestått.
- Secrets-scan: bestått.
- Avhengighetsrevisjon: 0 kjente sårbarheter.

## Anbefaling

Godkjenn en kontrollert preview-/produksjonsdeploy av de lokale rettelsene, og kjør deretter en kort etterkontroll med:

1. Bilag1 → Bilag2 → Bilag1 i samme webprosess.
2. Punktliste K-01–K-08 og strukturert tabell K-01–K-08.
3. Ett viewer- og ett restricted-gjesteinnloggingsløp.
4. Adminside som administrator og ikke-administrator.
5. Kundeanalyse, kravsvar og løsningsvurdering mot samme stabile kilderevisjon.

Før denne deployen bør produksjonen fortsatt klassifiseres som betinget godkjent.
