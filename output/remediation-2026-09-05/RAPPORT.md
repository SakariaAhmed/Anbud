# Rettelser og etterkontroll – 5. september 2026

F1–F10 i den opprinnelige rapporten er rettet. Alle tester er kjørt med syntetiske data i en disponibel PostgreSQL 17/pgvector-database. Nettleserkontrollen brukte Next/React og ekte PostgREST lokalt.

| Funn | Rettelse og verifikasjon |
|---|---|
| F1: resultater og manuell historikk forsvant | Tidligere krypterte analyser, vurderinger og lederoppsummeringer arkiveres før erstatning eller kildeinvalidering. Autorisert historikkvisning gjør dem lesbare. Reelle kildeendringer gjør fortsatt resultatene utdaterte; tjenestekatalogen inngår i analyseanbefalingene. No-op dokument-/analyselagring bevarer aktive resultater. Tester kontrollerer kryptering, tilgang og sletting sammen med prosjektet. |
| F2: retry overskrev manuelle endringer | Full analyse gjør ett genereringsforsøk, sjekker grunnlaget atomisk og bevarer forrige seksjonshistorikk. Konflikter avvises i både vanlig og lease-beskyttet SQL-lagring. |
| F3: gammel redigeringsfane overskrev nyere tekst | Kunden sender analysens opprinnelige UUID-revisjon. API og SQL avviser gammel versjon med 409. |
| F4: utkast forsvant ved lagringsfeil | Lagringsresultatet returneres eksplisitt til redigeringskomponenten. Utkastet og redigeringsgrunnlaget beholdes ved feil; brukeren kan eksplisitt velge siste analyse som grunnlag. Hele flyten ble bekreftet i nettleser. |
| F5: dokument ble klart før indeks | Dokumentet forblir processing med tom indexed_at under indeksering. Egen RPC publiserer readiness etter indeks med kontroll av dokumentrevisjon og jobblease. Feil, sletting og lease-overtakelse testes. |
| F6: ufullstendig forbedringsjobb | Lagret løsningsutkast rapporteres med evaluation_pending når revurdering gjenstår. Nytt forsøk gjenbruker nøyaktig samme artefakt. Jobbstatus og «Fortsett revurdering» er tilgjengelig etter gjenåpning. |
| F7: lagret resultat ble feilrapportert | Prosjektsnapshot etter commit er best effort. Jobbens resultatpeker lagres i samme transaksjon som resultatet og brukes ved gjenopptakelse/avbrudd. Nyere redigering gjenbrukes aldri som resultatet til den gamle jobben. |
| F8: samtidige handlinger og arbeidere | Lokal handlingslås, felles busy-status og databasebasert kø-/claim-kontroll per prosjekt. Like forespørsler samles. To samtidige databasesesjoner bekrefter maksimalt én kjørende jobb per prosjekt. |
| F9: forutsetninger ble kontrollert for sent | Manglende analyse/vurdering og pågående dokumentbehandling avvises før genereringsjobben legges i kø. Kjente domenefeil vises med faste, forståelige norske meldinger; ukjente feil skjules fortsatt. |
| F10: nettverksfeil og gamle snapshots | Polling tåler midlertidige transportfeil, SSE faller tilbake til polling, og UI fabrikerer ikke dokumentfeil ved brutt forbindelse. Nye serveroppslag og monoton snapshot_revision beskytter mot eldre svar, også når dokumentrevisjonen er uendret. |

## Verifikasjon

- 846 eksisterende tester bestått, ingen skips.
- 41 regresjons-/etterkontrolltester bestått, ingen skips.
- 37 utrullings-/databasekontrakter bestått.
- Totalt 924 tester bestått.
- TypeScript, ESLint og produksjonsbygg bestått.
- Migreringen ble kjørt to ganger mot forrige skjema med eksisterende testanalyse; innholdet ble bevart.
- Ny gjennomgang rettet statusrekkefølge ved uendret kildegrunnlag, manglende artefakt i gjenopprettet revurderingsresultat, arkivets standardprivilegier og like React-nøkler.
- Nettleser: gammel fane fikk 409, utkastet ble beholdt, eksplisitt ny revisjon lot det lagres, og historikken viste tidligere tekst. Ingen nye konsollfeil etter rettingen.

Testharnessen injiserer AI/parser/transportfeil og enkelte IO-avhengigheter. Den bruker faktiske funksjonskropper, SQL, kryptering og domeneregler. Dette er ikke en evaluering av modellens språklige kvalitet eller alle eksterne leverandørfeil.

Historikken bevarer resultater fra migreringstidspunktet og fremover. Tidligere slettede resultater rekonstrueres ikke automatisk. Aktive resultater brukes fortsatt bare når grunnlaget er gjeldende.

## Utrulling

Utrulling og uavhengig helsekontroll dokumenteres etter at produksjonsworkflowen har fullført. Migreringen er additiv og skal kjøres før applikasjonskoden. Kandidatens databasepreflight krever de nye kolonnene og historikktabellen.
