# Fasit - Sørvik Helsepartner HF - klinisk samhandlingsplattform

Dette er kvalitetsfasiten for det fiktive testsettet. En god løsning kan bruke andre
produktnavn og teknologivalg, men må dekke intensjon, kontroller og avklaringer nedenfor.

## Anbefalt løsningsretning

En norsk, hendelsesdrevet klinisk integrasjonsplattform med FHIR R4, varig meldingsformidling, behandlingsrelasjonsbasert tilgang og et eksplisitt revisjonsspor fra hjemmemåling til journalført handling.

## Målarkitektur

- FHIR-gateway og adapterlag mot EPJ, kurve, laboratorium, kjernejournal og kommune.
- Varig meldingskø med idempotens, kvittering og klinisk avvikskø.
- Versjonert regelmotor for klinisk varsling og eskalering.
- Policybasert tilgang med behandlingsrelasjon og kontrollert nødtilgang.
- Separate observabilitetsflater for teknisk drift og klinisk forvaltning.

## Gjennomføring og akseptanse

- Prioritert integrasjonskartlegging og kontrakttester.
- Parallellkjøring og avstemming før hver gammel kobling stenges.
- Stille pilot, begrenset klinisk pilot og gradvis skalering per forløp.
- Feilscenarioer og full gjenoppretting som obligatorisk akseptanse.

## Vinnende tilbudstemaer

- Pasientsikkerhet gjennom rekonstruerbar beslutningskjede.
- Ingen tap av bekreftede kliniske meldinger.
- Kontrollert reduksjon av punkt-til-punkt-kompleksitet.
- Klinisk innføring som måler alarmbelastning, ikke bare teknisk tilgjengelighet.

## Viktigste risikoer

- Ukjent EPJ-grensesnitt kan påvirke plan og estimat.
- Uavklart plassering av kliniske regler kan skape dobbelt forvaltningsansvar.
- Spennet i pasientvolum kan påvirke kapasitet og bemanning.

## Fakta kundeanalysen må fange

- `scale`: 7 800; 410 000; 36 000; 74
- `timeline`: 15. februar 2027; 1. september 2027
- `clinical_targets`: 12 prosent; 95; 30 minutter; 30 av 74
- `continuity`: 99,95; RPO null / RPO på null; 60 minutter
- `technology`: HL7 FHIR R4 / FHIR R4; idempotent / idempotens; behandlingsrelasjon
- `evaluation`: 50 prosent; 30 prosent; 20 prosent

## Påstander analysen ikke må gjøre

- At valgt EPJ-grensesnitt er kjent og ferdig dokumentert.
- At alle kliniske regler skal ligge i den nye plattformen.
- At 14 000 samtidige pasienter er et bindende dimensjoneringskrav.

## Krav-for-krav forventet god besvarelse

- `SOR-PAS-01` (A): CareFlow Nexus bruker varig meldingskø, idempotensnøkkel og ende-til-ende-kvittering. Hver melding får korrelasjons-ID og tilstandslogg. Meldinger som ikke kan leveres går til en klinisk avvikskø med eier, prioritet og kontrollert ny behandling.
- `SOR-FHIR-02` (A): FHIR R4 støttes gjennom profilerte ressurser og validering mot avtalte implementasjonsguider. Originalmelding, transformert nyttelast, mappingversjon og valideringsresultat lagres som ett revisjonsspor.
- `SOR-IAM-03` (A): Policykontrollen kombinerer rolle, organisasjonsenhet, aktiv behandlingsrelasjon og formål. Nødtilgang krever oppgitt begrunnelse, gir sanntidsvarsel og sendes til etterkontroll. Alle oppslag inngår i en uforanderlig revisjonslogg.
- `SOR-VAR-04` (A): Målinger valideres før en versjonert regelmotor klassifiserer dem. Varselet rutes etter pasient, forløp og vaktplan, med kvitteringsfrist og trinnvis eskalering. Regelversjon, måling, mottaker og handling kan rekonstrueres.
- `SOR-PAS-05` (B): Pasientflaten viser måling, mottakstid, status og godkjent kontakttekst. Kliniske regler og interne risikoscorer vises ikke som diagnose. Tekster forvaltes av helseforetaket og versjoneres.
- `SOR-LOG-06` (A): En sammenhengende sporingsmodell kobler originalmåling, transformasjon, regelkjøring, varsel, kvittering, klinisk vurdering og journaloppdatering med samme korrelasjons-ID. Revisjonsvisningen kan eksporteres til tilsyn og hendelsesanalyse.
- `SOR-DRI-07` (A): Tjenesten tilbys aktivt fordelt mellom to norske tilgjengelighetssoner. Bekreftede meldinger replikeres synkront før kvittering, som gir RPO null. Automatisert gjenoppretting og kvartalsvis øvelse dokumenterer RTO under 60 minutter.
- `SOR-DAT-08` (A): Alle tre datakategoriene lagres og behandles i norske regioner. Leverandørtilgang er tidsbegrenset, godkjent og logget. Underleverandørregisteret viser tjeneste, dataart og behandlingssted.
- `SOR-MIG-09` (A): Integrasjonene grupperes etter risiko og volum. Hver migrering har kontrakttest, parallellkjøring, meldingsavstemming og godkjent tilbakefallsplan. Kilde og mål sammenlignes på antall, innhold, rekkefølge og kvitteringsstatus før gammel kobling stenges.
- `SOR-OBS-10` (B): Teknisk drift ser kødybde, feilrate og latenstid uten pasientinnhold. Klinisk forvaltning ser berørte forløp, prioritet og oppfølgingsstatus med nødvendig pasientkontekst. Varslingsgrenser og ansvar følger en avtalt driftsmatrise.
- `SOR-TEST-11` (A): Alle seks scenarioene kjøres i et produksjonslikt miljø med syntetiske pasienter. Forventet resultat, faktisk resultat, loggbevis og klinisk godkjenner registreres. Kritiske avvik blokkerer pilot.
- `SOR-INN-12` (B): Hvert forløp starter med regelverksted, simulering og stille pilot der varsler sammenlignes uten å styre behandling. Deretter åpnes et begrenset pasientutvalg med daglig sikkerhetsmøte før skalering. Alarmmengde, responstid og falske positive følges.
