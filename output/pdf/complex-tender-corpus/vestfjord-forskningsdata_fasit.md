# Fasit - Vestfjord universitet - sikker forskningsdata- og AI-plattform

Dette er kvalitetsfasiten for det fiktive testsettet. En god løsning kan bruke andre
produktnavn og teknologivalg, men må dekke intensjon, kontroller og avklaringer nedenfor.

## Anbefalt løsningsretning

En klassifiseringsstyrt, selvbetjent forskningsplattform med Feide, tidsavgrenset prosjekttilgang, kontrollerte GPU-jobber, reproduserbare miljøer og automatisert arkivering eller sletting.

## Målarkitektur

- Selvbetjeningsportal og katalog av godkjente prosjektmaler.
- Feide, flerfaktor og prosjektbasert tilgang med dataeier.
- Policy-as-code som styrer region, nettverk, logging og eksport per dataklasse.
- Lagrings- og analyseplan med GPU-kvoter, koststed og automatisk stopp.
- Livssyklusmotor for sluttdato, arkivpakke, kontrollsummer og sletting.

## Gjennomføring og akseptanse

- Pilot med helsevitenskap og marin teknologi.
- Klassifiseringsmodell oversettes til testbare tekniske policyer.
- Migrering prioriteres etter bruk og bevaringsbehov, ikke som blind masseflytting.
- Forskerstøtte, sikkerhetsvakt og måling av etableringstid og kostnad.

## Vinnende tilbudstemaer

- To timer fra godkjent bestilling til standardmiljø.
- Sikkerhetsnivå som følger dataklasse fremfor én dyr standard.
- Reproduserbar forskning og portabelt dataeierskap.
- Kostnadskontroll uten å blokkere forskerens selvbetjening.

## Viktigste risikoer

- Uferdig klassifiseringsmodell kan endre tekniske kontrollkrav.
- Uavklart føderert tilgang kan forsinke internasjonalt samarbeid.
- Varierende arkivkrav kan gjøre migrerings- og avslutningsplanen usikker.

## Fakta kundeanalysen må fange

- `scale`: 18 600; 2 900; 1 250; 4 petabyte; 18 prosent
- `timeline`: 1. januar 2027; 15. august 2027; tre år / 3 år
- `outcomes`: 21 dager; 2 timer; 100 prosent; 25 prosent
- `controls`: Feide; GPU; koststed; Norge; eksport
- `ai_policy`: ikke trenes / ikke trening; eksplisitt / godkjenning
- `evaluation`: 45 prosent; 35 prosent; 20 prosent

## Påstander analysen ikke må gjøre

- At endelig klassifiseringsmodell allerede er vedtatt.
- At alle utenlandske samarbeidspartnere kan få føderert tilgang.
- At hele datamengden skal masseflyttes i én operasjon.

## Krav-for-krav forventet god besvarelse

- `VES-SEL-01` (A): Research Harbor bruker en godkjent katalog av miljømaler. Etter Feide-innlogging og komplett metadata registrerer policyflyten dataeier, klassifisering, koststed og sluttdato før automatisert etablering. Leveransetiden måles fra godkjenning til aktivt miljø.
- `VES-IAM-02` (A): Feide brukes til føderert innlogging. For beskyttede datasett kreves flerfaktorautentisering og aktivt medlemskap godkjent av dataeier. Tilgang har utløpsdato og resertifiseres hvert halvår.
- `VES-KLA-03` (A): Policy-as-code oversetter godkjent dataklasse til region, kryptering, nettverksgrenser, loggnivå og eksportflyt. Endring av klasse krever konsekvenskontroll og dataeiers godkjenning. Historikken viser gammel og ny policy.
- `VES-DAT-04` (A): Høyeste klasse bindes til norske behandlingsregioner for primærdata, sikkerhetskopi og identifiserbar logg. Automatisert policy hindrer opprettelse av ressurser utenfor godkjent lokasjon og rapporterer avvik.
- `VES-GPU-05` (A): Jobbplanleggeren krever gyldig prosjekt, koststed og bruker. Prosjektet får kvote og maksimal kjøretid. Forventet kostnad vises før start, og tomme eller inaktive ressurser stanses etter policy.
- `VES-AI-06` (A): Kun godkjente modellendepunkter kan brukes. Standardpolicy deaktiverer trening og leverandørbevaring. Eventuelle unntak krever dataeier, personvern og informasjonssikkerhet, og lagres med modell, formål, datasett og utløpsdato.
- `VES-REP-07` (B): Prosjektet kan lagre Git-revisjon, containerbilde med digest, avhengighetslås og uforanderlig datasettversjon. En manifestfil kobler disse til jobb, resultat og ansvarlig bruker.
- `VES-EKS-08` (A): Brukeren legger eksport i en karantenesone med formål og mottaker. Automatisk skanning kontrollerer filtype, skadevare og sensitive mønstre. Dataeier eller delegert kontrollør godkjenner, og kontrollbevis følger eksporten.
- `VES-LIV-09` (A): Varsling starter 90 dager før sluttdato. Dataeier velger begrunnet forlengelse, arkivpakke eller sletting. Arkivering gir manifest og kontrollsummer. Sletting dokumenteres for aktive data og sikkerhetskopier etter avtalt retensjon.
- `VES-MIG-10` (B): Hvert lagringsområde profileres før flytting. Aktive pilotprosjekter tas først, mens inaktive data vurderes for arkiv eller sletting. Objektantall, størrelse og kontrollsummer avstemmes, og gamle områder stenges først etter dataeiers godkjenning.
- `VES-UTR-11` (A): Data leveres i opprinnelig eller åpent avtalt format, metadata og policy som JSON, tabeller som CSV eller Parquet og miljøer som OCI-kompatible bilder og deklarativ konfigurasjon. Manifest og kontrollsummer følger uttrekket.
- `VES-OBS-12` (B): Rollebeskyttede oversikter viser alle seks måleområdene med sporbarhet til prosjekt og koststed. Personopplysninger minimeres i økonomirapporter. Data kan eksporteres og kobles til universitetets økonomi- og styringsplattform.
