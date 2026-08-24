# Lokal parser v2: benchmark

Kjørt 14. juli 2026 på de samme 50 norske PDF-ene og 3505 fasitkravene som
produksjonsbaselinen i repoet. Begge varianter brukte den samme deterministiske
kravledgeren. Testen gjorde ingen betalte API- eller modellkall.

## Resultat

| Mål | Prod lokal | Lokal v2 | Forskjell |
|---|---:|---:|---:|
| Dokumenter | 50 | 50 | – |
| Ekstraherte krav / fasit | 3465 / 3505 | 3505 / 3505 | +40 krav |
| Dokumenter med nøyaktig kravantall | 18 / 50 | 50 / 50 | +32 dokumenter |
| Streng teksttreff | 81,9 % | 99,9 % | +18,0 pp |
| Justert teksttreff | 98,2 % | 100,0 % | +1,8 pp |
| ID-kvalitet | 87,9 % | 92,5 % | +4,6 pp |
| Overskriftskvalitet | 94,5 % | 99,5 % | +5,0 pp |
| Kildelokator | 98,2 % | 100,0 % | +1,8 pp |
| Parser, gjennomsnitt | 298 ms | 344 ms | +46 ms |
| Parser, P90 | 455 ms | 575 ms | +120 ms |
| Totalt, gjennomsnitt | 404 ms | 467 ms | +63 ms |
| Totalt, P90 | 563 ms | 700 ms | +137 ms |

Fire av 3505 krav har fortsatt ikke helt identisk tekst mot fasiten. Justert
teksttreff og kildeplassering er komplette, men dette skal ikke tolkes som at
alle PDF-varianter i produksjon er løst.

## Tre tidligere vanskelige dokumenter

| Dokument | Prod streng tekst | Lokal v2 | Krav funnet |
|---|---:|---:|---:|
| `063_Bilag_2_Krav_DokumentVern_Forvaltning_IKS.pdf` | 22,7 % | 97,0 % | 66 / 66 |
| `083_Bilag_2_Krav_LastVindu_Terminal_SA.pdf` | 51,2 % | 100,0 % | 84 / 84 |
| `093_Bilag_2_Krav_StreamArkiv_Produksjon_AS.pdf` | 28,3 % | 100,0 % | 60 / 60 |

## Hva som ble endret

- Gjenbruk av PDF.js-posisjoner i den eksisterende lokale parseprosessen.
- Deteksjon av repeterte topp- og bunntekster.
- Norske krav-ID-er og flate kravtabeller rekonstrueres til typede celler.
- Visuelt brutte rader settes sammen til én kravtekst.
- Generert kravtekst erstattes bare når den lokale teksten er et tapsfritt
  delutdrag av kilden; overskrifter og rekkefølge beholdes fra ledgeren.
- Lokalt Docling-spor velges før Azure, og bare etter målt kvalitetsbehov.

## Metode og begrensninger

Fasitsettet eksisterte før implementasjonen. Benchmarken måler hele den lokale
parse- og ledgerkjeden, ikke bare PDF-tekstuttak. Den er deterministisk og egnet
som regresjonstest, men corpus på 50 dokumenter dekker ikke alle skannede,
håndskrevne eller grafikkbaserte PDF-er. Slike dokumenter skal fanges av
kvalitetsruteren og eskaleres kontrollert.

En separat kundeanalyse-A/B på tre av de vanskelige dokumentene sammenlignet
det gamle sidekartet med identisk råtekst og lokal v2-struktur. Faktadekning og
spesifisitet var uendret, mens kildetrofasthet økte 0,17 og kildesporbarhet 0,16
på en 10-punktsskala. Testen avdekket også at tidlig evidenskomprimering kunne
fjerne nyttig detalj. Produksjonsregelen beholder derfor lokal råtekst for
primærdokumenter opptil 18 000 tegn og støttedokumenter opptil 8 000 tegn.
