# Fasit - PolarFrakt Logistikk SA - digital kjølekjede og terminalstyring

Dette er kvalitetsfasiten for det fiktive testsettet. En god løsning kan bruke andre
produktnavn og teknologivalg, men må dekke intensjon, kontroller og avklaringer nedenfor.

## Anbefalt løsningsretning

En offline robust kjølekjedeplattform som lar transportsystemet være ordre-master, normaliserer fire sensorleverandører og gir et rekonstruerbart bevis fra måling og skanning til avvik og godkjenning.

## Målarkitektur

- Integrasjonslag mot eksisterende transportstyringssystem.
- Adaptere for MQTT, HTTPS og fil med kanonisk målemodell og originalbevaring.
- Offline håndterminalapp med kryptert lokal kø og idempotent synkronisering.
- Versjonert varslingsmotor med vaktplan, kvittering og eskalering.
- Femårig hendelseslager og eksport av kjølekjedebevis.

## Gjennomføring og akseptanse

- Pilot på Tromvik terminal med reelle sensorer og ruter.
- Klimakammertest ved minus 30 grader og tolv timers offline-test.
- Datakvalitetsprofilering per sensorleverandør.
- Terminalvis utrulling med måling av skannedekning og avviksbehandling.

## Vinnende tilbudstemaer

- Komplett og eksportbart kjølekjedebevis.
- Operativ drift som tåler kulde og manglende dekning.
- Rask varsling uten å skjule datakvalitetsproblemer.
- Basisleveranse uavhengig av opsjon for ruteoptimalisering.

## Viktigste risikoer

- Ukjent datakvalitet fra eldste sensorleverandør kan gi falske avvik.
- Uvalgt sekundær varslingskanal kan forsinke beredskapstest.
- Ustabil transportintegrasjon kan kreve større lokal arbeidskopi.

## Fakta kundeanalysen må fange

- `scale`: åtte terminaler / 8 terminaler; 520; 240; 1 800
- `quality_targets`: 2,7; 0,5; 50 prosent; 2 minutter; 99 prosent
- `timeline`: 1. desember 2026; 1. juni 2027
- `offline`: tolv timer / 12 timer; minus 30 / -30; offline
- `integrations`: MQTT; HTTPS; filbasert; transportstyringssystem
- `retention`: fem år / 5 år; 24x7 / 24 timer
- `evaluation`: 45 prosent; 30 prosent; 25 prosent

## Påstander analysen ikke må gjøre

- At SMS er valgt som sekundærkanal.
- At ruteoptimalisering er nødvendig for basisløsningen.
- At data fra alle sensorleverandører har dokumentert høy kvalitet.

## Krav-for-krav forventet god besvarelse

- `POL-TMS-01` (A): ColdChain Control leser ordre og rute gjennom et versjonert integrasjonslag og lagrer bare nødvendig operativ kopi. Statushendelser sendes tilbake med idempotensnøkkel og kvittering. Masterdata kan ikke endres i den nye plattformen.
- `POL-IOT-02` (A): Adapterlaget normaliserer alle tre mønstrene til én kanonisk måling uten å forkaste originalen. Kilde, sensor-ID, enhet, kvalitetsflagg, måletid og mottakstid bevares. Ugyldige målinger går til egen datakvalitetskø.
- `POL-OFF-03` (A): Tildelt arbeidsliste og nødvendige sendinger lagres kryptert på enheten. Skanning, status, avvik og bilder køes lokalt med sekvensnummer. Ved gjenkobling synkroniseres hendelser idempotent, og konflikter vises til terminalleder.
- `POL-KUL-04` (A): Appen leveres for kundens valgte rugged-enheter og testes i klimakammer ved minus 30 grader. Lokal database, batteriprofil, skanner og hanskemodus inngår i akseptansetesten. Registreringer avstemmes etter testen.
- `POL-VAR-05` (A): En versjonert regelmotor klassifiserer målingen ved inntak. Primærkanal og vaktplan bestemmer mottaker. Systemet måler mottak til utsendt varsel og eskalerer ved manglende kvittering. Sekundær kanal konfigureres når Kunden har valgt SMS eller tale.
- `POL-SPOR-06` (A): Et uforanderlig hendelsesforløp kobler alle bevis til sending og kolli. Rapporten viser kilde og tidspunkt, hull i dataserien, avviksterskel, ansvarlig tiltak og godkjenning. Beviset kan eksporteres som PDF og maskinlesbar JSON.
- `POL-RET-07` (A): Råmålinger, normaliserte målinger og avvikshendelser lagres etter en femårig policy med integritetskontroll. Juridisk hold kan stanse sletting for valgt sending. Uttrekk har manifest og kontrollsummer.
- `POL-DRI-08` (A): Tjenesten overvåkes hele døgnet med syntetisk inntak, skanning og varsling. Prioritet 1 mottas av bemannet vakt, med første respons innen 15 minutter. Tilgjengelighet måles på hele kritisk kjede.
- `POL-IAM-09` (A): Entra ID styrer brukeridentitet, mens rolle, terminal og skift inngår i autorisasjonen. Enheter registreres i kundens MDM. Sperring blokkerer ny innlogging, tilbakekaller tokens og starter fjernsletting av den krypterte arbeidskopien.
- `POL-TEST-10` (A): Alle syv scenarioene kjøres med kjent testdatasett. Resultatet dokumenterer fullstendighet, rekkefølge, latenstid og korrekt brukerrespons. Kritiske avvik blokkerer utrulling til neste terminal.
- `POL-RAP-11` (B): Standarddashbord viser alle fem måleområdene og gjør det mulig å bore ned til sending og kilde. Tilgang til kundedata følger rolle. Målinger kan eksporteres til kvalitetsmøte og revisjon.
- `POL-OPS-12` (C): Ruteoptimalisering tilbys som en separat priset opsjon med eget datagrunnlag og akseptanse. Ingen basisfunksjon, integrasjon eller kjølekjedebevis avhenger av at opsjonen kjøpes.
