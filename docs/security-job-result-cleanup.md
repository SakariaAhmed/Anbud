# Rensing av historiske jobbresultater

Jobbresultater er tilgjengelige med lesetilgang til prosjektet. Dokumentresultater
skal derfor bare inneholde dokumentoversikten, aldri originalfilen eller hydrert
dokumentinnhold. Nye resultater projiseres før lagring. Lesing av eldre resultater
projiseres også før jobboversikt, jobbdetaljer og hendelsesstrøm sendes til klienten.
Dette beskytter også resultater som gjenopprettes fra eldre sikkerhetskopier.

Eldre krypterte resultater kan fortsatt inneholde originalfilen i databasen.
Følgende vedlikeholdsskript fjerner dokumentdetaljene uten å endre jobbstatus,
resultatmetadata eller dokumentet i dokumentlageret. Skriptet er ikke kjørt mot
produksjon som del av denne rettingen.

Installer migrasjonen `20260906100000_clean_project_job_results.sql` først.
Sammenligningen sendes i en RPC POST-kropp, slik at krypterte originalfiler aldri
inngår i URL-er eller URL-logger. RPC-en er bare tilgjengelig for `service_role`.

Kjør fra `apps/frontend` med `DATA_API_URL`, `DATA_API_SERVICE_ROLE_KEY` og
`APP_ENCRYPTION_KEY` eksplisitt satt for det tilsiktede miljøet. Skriptet laster
ikke miljøfiler automatisk. Bruk eksisterende krypteringsnøkkel.

```sh
node scripts/clean_historical_job_results.mjs
node scripts/clean_historical_job_results.mjs --apply
```

Første kommando teller berørte rader uten å skrive. Andre kommando renser dem i
avgrensede lesepartier. Kun aggregert antall skrives til terminalen. Skriptet
sammenligner opprinnelig kryptert resultat, status og oppdateringstid før hver
endring. Samtidige endringer telles som konflikter og overskrives ikke. Kjør på
nytt for konflikter; allerede rensede resultater blir ikke skrevet om. Et resultat
som ikke kan dekrypteres stopper kjøringen uten å endre den aktuelle raden.
Ved feil kan tidligere rader allerede være renset; ny kjøring er trygg.

Lesebeskyttelsen må beholdes også etter rensing. Skriptet endrer ikke eldre
sikkerhetskopier, som må håndteres gjennom miljøets eksisterende oppbevaringsrutiner.
