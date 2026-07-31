# Fasit - Malmhavn Industri AS - prediktivt vedlikehold og feltarbeid

Dette er kvalitetsfasiten for det fiktive testsettet. En god løsning kan bruke andre
produktnavn og teknologivalg, men må dekke intensjon, kontroller og avklaringer nedenfor.

## Anbefalt løsningsretning

En sikker industriell dataplattform med lesende OT-innsamling, SAP som master, robust offline feltapp og forklarbar risikoprioritering der modeller aldri overstyrer sikkerhetsfunksjoner.

## Målarkitektur

- Lokal innsamlingsnode i industriell DMZ med lesende OPC UA.
- Buffer og kontrollert utgående overføring til skalerbart tidsserielager.
- SAP S/4HANA-integrasjon med idempotens og masterdataeierskap.
- Kryptert offline feltapp med versjonert synkronisering.
- Modellregister, forklaringsdata og rollebeskyttet vedlikeholdsflate.

## Gjennomføring og akseptanse

- Datakvalitetsprofilering før modellutvikling.
- Pilot på kritisk utstyr med skyggekjøring og tydelig baseline.
- Feilscenarioer på OT, nett, feltapp, SAP og modell som akseptansegate.
- Utrulling til øvrige anlegg først etter dokumentert sikkerhet og effekt.

## Vinnende tilbudstemaer

- Sikker OT-separasjon uten skjult skriverettighet.
- Feltarbeid som faktisk fungerer åtte timer uten dekning.
- Forklarbare anbefalinger og reverserbar modellforvaltning.
- Målbar effekt koblet til utførte tiltak.

## Viktigste risikoer

- Ukjent historikerdatakvalitet kan redusere modellverdi.
- Parallelt valg av MDM kan påvirke feltutrulling.
- Uavklarte regler for automatisk prioritering kan forsinke gevinstrealisering.

## Fakta kundeanalysen må fange

- `scale`: fire prosessanlegg / 4 prosessanlegg; 1 460; 18 000; 12 millioner
- `business_case`: 84 millioner; 20 prosent; 62; 78; 35 prosent
- `timeline`: 1. mars 2027; 31. desember 2027
- `architecture`: OPC UA; industriell DMZ; SAP S/4HANA; offline; åtte timer / 8 timer
- `safety`: ikke skrive / lesende; sikkerhetsalarmer; menneskelig / operatør
- `evaluation`: 40 prosent; 35 prosent; 25 prosent

## Påstander analysen ikke må gjøre

- At skyplattformen kan styre eller skrive direkte til OT.
- At modellen kan erstatte sikkerhetsalarmer.
- At datakvaliteten i alle tre historikere er dokumentert som god.

## Krav-for-krav forventet god besvarelse

- `MAL-OT-01` (A): AssetPulse bruker en lokalt plassert innsamlingsnode som leser fra godkjente OPC UA-endepunkter. Data sendes ut gjennom en enveiskontrollert forbindelse. Det finnes ingen rute eller legitimasjon for skriving tilbake til styringssystemene.
- `MAL-DAT-02` (A): Inntaket validerer tidsstempel, enhet, kvalitet og kilde før lagring. Avviste eller forsinkede målinger telles separat. Kapasitetstesten bruker 1,5 ganger oppgitt døgnvolum og dokumenterer kø, latenstid og tap.
- `MAL-OFF-03` (A): Kryptert lokal lagring holder tildelte arbeidsordrer, sjekklister og vedlegg tilgjengelig offline. Endringer journalføres lokalt. Ved gjenkobling brukes versjonsnummer og feltregler til å slå sammen sikre endringer, mens reelle konflikter sendes til ansvarlig arbeidsleder.
- `MAL-SAP-04` (A): Integrasjonen bruker SAPs dokumenterte API-er. AssetPulse oppretter ikke parallelle masterdata. Endringer i status og utførelse sendes med idempotensnøkkel, og SAP-kvittering bestemmer om arbeidsordren er fullført i feltflaten.
- `MAL-RIS-05` (B): Prioriteringen viser utstyrskritikalitet, siste tilstandsendring, åpen arbeidsordre og hvilke signaler som påvirket anbefalingen. Modellversjon og terskel lagres. Leder kan overstyre med begrunnelse uten å endre rådata.
- `MAL-SIK-06` (A): Entra ID og kundens betingede tilgang brukes. Roller begrenses per anlegg og funksjon. Leverandørtilgang aktiveres som just-in-time-tilgang med navngitt godkjenner, utløpstid og opptaks- og hendelseslogg.
- `MAL-SAF-07` (A): Modellresultater presenteres bare som vedlikeholdsanbefalinger. Sikkerhetsalarmer og sperrer kommer fra eksisterende systemer og kan ikke undertrykkes. Brukerflaten merker tydelig forskjellen og krever menneskelig beslutning før arbeidsordre prioriteres om.
- `MAL-MOD-08` (B): Et modellregister lagrer datasettversjon, egenskaper, godkjenning, terskler og mål per utstyrstype. Nye modeller kjøres i skygge før aktivering. Godkjent tidligere versjon kan gjeninnføres uten å miste hendelseshistorikk.
- `MAL-DRI-09` (A): Innsamlingsnoden overvåkes lokalt og bufferlagrer minst 48 timers pilotvolum. Etter gjenkobling sendes data i tidsrekkefølge med duplikatkontroll. Tilgjengelighet måles ved mottak av en avtalt testverdi gjennom hele kjeden.
- `MAL-TEST-10` (A): Testpakken dekker alle syv scenarioene med forventet resultat, teknisk bevis og navngitt godkjenner. Kritiske avvik retestes. Produksjonssetting krever både OT-sikkerhetsgodkjenning og prosesseiers signatur.
- `MAL-EFF-11` (B): Før pilot fastsettes baseline per utstyrsklasse for stanstid, arbeidsordretype og etterregistrering. Rapporten skiller anbefaling, faktisk tiltak og resultat. Endringer i produksjonsvolum og planlagt revisjonsstans merkes som forklaringsfaktorer.
- `MAL-UTR-12` (A): Råmålinger og metadata eksporteres som Parquet eller CSV, mens konfigurasjon og revisjonsdata kan leveres som JSON. Uttrekket har manifest, skjema, kontrollsummer og relasjon mellom anbefaling, modellversjon og beslutning.
