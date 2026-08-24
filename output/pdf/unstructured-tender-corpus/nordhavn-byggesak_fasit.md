# Fasit - Nordhavn kommune - digital byggesaksbehandling

Dette er kvalitetsfasiten for det fiktive testsettet. En god løsning kan bruke andre
produktnavn og teknologivalg, men må dekke intensjon, kontroller og avklaringer nedenfor.

## Anbefalt løsningsretning

En standardisert og konfigurerbar byggesaks-SaaS med sikker innbyggerdialog, Noark-integrasjon og en kontrollert migrering der datakvalitet og sporbarhet er akseptansekriterier.

## Målarkitektur

- Responsiv saksbehandlerflate og separat innbyggerportal.
- Entra ID for ansatte og ID-porten for eksterne brukere.
- API- og hendelseslag mot Noark 5, Matrikkelen, Folkeregisteret og valgt meldingskanal.
- Kryptert dataplattform i EØS med revisjonslogg, sikkerhetseksport og rapportering.
- Eksportmekanisme for saker, dokumenter, metadata, roller og logger.

## Gjennomføring og akseptanse

- Dataprofilering, prøvemigrering, to testmigreringer og kontrollert produksjonsflytting.
- Pilot med Plan og byggesak før øvrige enheter.
- Akseptansetester for brukerreiser, integrasjoner, tilgang, ytelse, universell utforming og gjenoppretting.
- Rollebasert opplæring, superbrukernettverk og seks ukers stabilisering.

## Vinnende tilbudstemaer

- Trygg overgang før eksisterende avtale utløper.
- Målbar reduksjon i komplettering og dobbeltregistrering.
- Åpne grensesnitt og verifiserbart dataeierskap.
- Konfigurasjon fremfor kostbar spesialutvikling.

## Viktigste risikoer

- Uavklart meldingskanal kan forsinke ende-til-ende-test.
- Motstridende historiske metadata kan øke migreringsomfang og kostnad.
- Ukjent sesongtopp for eksterne brukere kan gi feil kapasitetsbaseline.

## Fakta kundeanalysen må fange

- `scale`: 38 400; 127; 3 200
- `deadline`: 1. april 2027; 30. juni 2027
- `migration`: 220 000; 1,15 millioner; 2008
- `service_levels`: 99,9; RPO / gjenopprettingspunkt; 4 timer; RTO / gjenopprettingstid; 8 timer
- `integrations`: Noark 5; Matrikkelen; Folkeregisteret; ID-porten
- `outcomes`: 28; 18; 40 prosent; 85 prosent
- `evaluation`: 45 prosent; 30 prosent; 25 prosent

## Påstander analysen ikke må gjøre

- At Altinn er valgt fremfor KS Fiks/SvarUt.
- At det finnes et kundekrav om 200 samtidige brukere.
- At historiske metadata kan kastes dersom dokumentfilen finnes.

## Krav-for-krav forventet god besvarelse

- `NORD-FUN-01` (A): Saksløft leverer en konfigurerbar arbeidsflyt fra mottak til avslutning. Hver overgang lagrer tidspunkt, bruker, tidligere status, ny status og begrunnelse. Produksjonsendringer krever totrinnsgodkjenning, og hele historikken kan eksporteres.
- `NORD-IAM-02` (A): Løsningen bruker OpenID Connect mot Entra ID og støtter gruppeprovisjonering med SCIM. Autorisasjon kontrolleres ved hvert kall mot en policy som kombinerer enhet, rolle, sakstype og skjermingskode. Kvartalsvis tilgangsrapport og periodisk resertifisering inngår.
- `NORD-DIA-03` (A): Innbyggerportalen bruker ID-porten via OpenID Connect. Partsrollen valideres mot saken før data returneres, og signerte dokumentlenker er kortlivede og bundet til aktiv sesjon. Hendelser med avvist tilgang logges for sikkerhetsoppfølging.
- `NORD-ARK-04` (A): Dokument og metadata overføres gjennom et versjonert integrasjonslag. Arkivkvittering lagres på saken. Feil går til en arbeidskø med korrelasjons-ID, årsak og sikker gjentakelse som hindrer dobbel journalføring.
- `NORD-INT-05` (A): ID-porten, Matrikkelen og Folkeregisteret leveres som standardkoblinger. Begge meldingskanalene støttes, mens konfigurasjon, sertifikater og ende-til-ende-test for én valgt kanal inngår i grunnleveransen.
- `NORD-MIG-06` (A): Migreringen gjennomføres som profilering, prøvemigrering, to komplette testmigreringer og produksjonsflytting. Fullstendighet dokumenteres med objekttelling, kontrollsummer, feltavstemming og separat kontroll av partsroller og skjerming. Kritiske avvik blokkerer produksjonssetting.
- `NORD-SIK-07` (A): TLS 1.2 eller nyere brukes under overføring, og data krypteres ved lagring. Administrative handlinger, rolleendringer og oppslag i skjermede saker gir strukturerte revisjonshendelser. Hendelser eksporteres som CEF eller JSON med korrelasjons-ID.
- `NORD-DRI-08` (A): KystSky tilbyr 99,95 prosent månedlig tilgjengelighet målt med innloggede syntetiske brukerreiser. Tilbudt RPO er 1 time og RTO er 4 timer. Gjenoppretting testes halvårlig, og resultat, avvik og retest rapporteres.
- `NORD-UU-09` (A): Portalen testes automatisk og manuelt med tastaturnavigasjon, skjermleser og de avtalte brukerreisene. Kritiske feil blokkerer godkjenning. Testrapport, avvikslogg og dokumentert retest leveres til Kunden.
- `NORD-RAP-10` (B): Standardpakken inneholder rollebeskyttede dashbord for alle fem måleområdene. Data filtreres på enhet, sakstype og periode, og kan eksporteres som CSV eller hentes gjennom et dokumentert rapport-API.
- `NORD-API-11` (B): Saksløft tilbyr REST-API dokumentert med OpenAPI 3.1 og webhooks for sak, status, dokument og vedtak. API-versjoner støttes parallelt i minst 18 måneder, og komplette datauttrekk leveres som JSON, CSV og originalfiler.
- `NORD-OPL-12` (B): Femten superbrukere får to hele dager med scenarioøvelser. Øvrige roller får målrettede økter på to til fire timer, digitale forkurs og tilgang til norsk materiell. Ukentlige spørretimer gjennomføres de første seks ukene.
