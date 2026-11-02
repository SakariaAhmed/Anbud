# RAG, svarkvalitet og arbeidsflyt

Oppdatert 2. november 2026. Dette erstatter augustplanens utdaterte arkitekturforslag. Status gjelder lokal kode og eksplisitte lokale tester, ikke produksjon. Detaljer om commits, council-funn, migrasjoner og gjenstående arbeid står i [implementasjonsloggen](rag-quality-implementation-2026-11-01.md).

## Retning

Behold Next.js, eksisterende use-cases/prosjektjobber, PostgreSQL/pgvector, privat dokumentlagring og modellkonfigurasjonen i `model-config.ts`. Hybrid FTS/vektorsøk, RRF, spørsmålsomskriving, kvalitetsvurdering, embedding-cache, Docling-ruting og inngjerdede jobber finnes allerede. Arbeidet skal måle og forbedre disse eierne. Ingen ny søketjeneste, Python-sidevogn eller orkestreringsramme innføres.

Komplett evidenskontekst i v3 beholdes der den måler best. Retrieval skal ikke tvinges inn i alle flyter. Originaltekst bevares for sitater og revisjonsspor; kanonisk tekst er en separat representasjon. Den eksisterende ukrypterte FTS-representasjonen fjernes ikke uten en uttrykkelig krypteringsbeslutning.

## Implementert i denne arbeidsgrenen

- Uavhengige delspørringer søkes parallelt og sammenstilles med RRF. Norsk FTS avledes fra eksisterende leksemer med opprinnelige posisjoner/vekter; migrasjonen har separat backfill og samtidig GIN-bygging.
- Krav-ID-er leses fra lagret, kryptert kravregister. Gamle dokumenter har en avgrenset fallback. Faktiske kildeutdrag og kravrader skilles fra rekonstruert tekst, tekniske standardnumre og løse kryssreferanser.
- Registrerte embeddings kjøres mot ekte SQL i en disponibel database. Manglende vektorer kan ikke skjules med leksikalsk fallback. CI har separate, fryste grunnlinjer for det opprinnelige korpuset og et blandet tilleggskorpus med sider/overskrifter, PDF-tabeller, oppfølgingsspørsmål, rettelser og manglende ID-er.
- Chat bruker Responses-strømming, stabil prompt-prefix og prosjektavgrenset cache-nøkkel. Oppslag overlapper omskriving; uendret søkeplan gjenbruker kandidatene. Et avsnitt valideres før publisering. Faktisk brukte kildenummer, originalutdrag og revisjon beholdes ved lagring/innlesing.
- Kravregisteret blir lesbart før generert analyse. Gjennomgang av krav viser krav, svar og grunnlag samlet, med søk, oppfølgingsfiltre, tastatur og neste uavklarte. Redigering og regenerering av utvalgte svar lager nye versjoner og bevarer øvrige rader. Publisering kontrollerer både foreldreversjon og kilde-/tjeneste-/kunnskaps-/evalueringsavhengigheter i databasen.
- «Hva mangler?» avledes fra gjeldende kravbesvarelse, dekning og åpne avklaringer. Et kildepanel viser originalutdrag og verifisert plassering; begrensede lesere kan kontrollere utdrag uten å få nedlastingsrett.
- Feil i forbedring bevarer den lagrede grunnversjonen. Fremdrift viser faktiske faser og behandlede krav, uten tidsbasert prosent. Arbeideren planlegges hvert minutt med egen global kapasitetsgrense for planlagte kjøringer.
- Innholdsfrie målinger korrelerer opplasting, kø, parsing, indeksering, metadata, kontekst, første token, validering, lagring og klientrendering. Rapporten skiller vellykkede og mislykkede målinger.

## Evaluering og kvalitetsgrenser

Fra repo-roten, med Node-versjonen fra CI og en disponibel PostgreSQL/pgvector på loopback:

```sh
node scripts/rag_retrieval_eval.mjs --embeddings=recorded --gate --database-url "$DOCUMENT_CHUNKS_SQL_TEST_DATABASE_URL" --output /tmp/rag-original.json
node scripts/rag_retrieval_eval.mjs --extended-suite --embeddings=recorded --gate --database-url "$DOCUMENT_CHUNKS_SQL_TEST_DATABASE_URL" --output /tmp/rag-extended.json
```

Dette gjør ingen betalte kall. Embeddings er ekte, tidligere registrerte modellresponser, bundet til modell og nøyaktig input. Det blandede tilleggskorpuset leser kildehash-verifiserte lokale parser-snapshots av det fiktive Hålandsvik-anbudet og de innsjekkede stressnotatene. Det er en retrieval-test, ikke et bevis på OCR-kvalitet. Det opprinnelige holdout-settet endres ikke.

Det opprinnelige settet har 116 spørsmål: 60 ID-oppslag, 36 utviklingsparafraser og 20 holdout-spørsmål. Tillegget har 50 svarbare spørsmål og fem manglende ID-er. Side, overskrift og dokument må stemme når disse er merket; riktig tekst med oppdiktet plassering er ikke et treff. Manglende ID-er skal utløse svakt kildegrunnlag.

Lokalt registrert grunnlinje: alle 83 eksplisitte ID-tilfellene har kravraden først. Tilleggets recall@10 er 96 %, men stressdelen er 90 %. Det opprinnelige konseptuelle settet er fortsatt på 30/36 (83,3 %), under utgivelsesgrensen 95 %. En grønn regresjonsgate er derfor ikke en godkjenning av alle kvalitetsmål. MRR, siteringsriktighet, groundedness og korrekt avståelse må vurderes separat. Et registeroppslag først er heller ikke et mål på ren SQL/FTS-rangering.

Modellbasert rerangering og svarvurdering kjøres som en separat, uttrykkelig budsjettstyrt tier. Ikke endre modellstandarder eller optimaliser på holdout-settet. Før en utgivelse kreves versjonert dokumentasjon av kvalitet og kilder; målgrensene er recall@10 minst 95 %, siteringsriktighet minst 98 % og korrekt avståelse minst 95 %.

## Gjenstående leveranser

1. Utvid modellbasert groundedness-/siteringsvurdering og mål rerankerens verdi etter FTS-reparasjonen. Utgivelsesgrensen for konseptuelle spørsmål er ikke nådd.
2. Velg relevante artefaktseksjoner over hele den gjeldende samlingen, med sikker støtte for eksplisitte artefaktreferanser. Generert tolkning må ikke bli primærkilde.
3. Utvid det deterministiske evidenskontraktet til kravsvar, vurdering, lederoppsummering og Bilag 1, og fullfør kildepanelet for alle disse flatene.
4. Fullfør automatisk analysestart først når lagret parsing, indeksering, metadata og berikelse faktisk er klare. Bevar kildeversjoner, manuelle endringer og inngjerdet publisering ved eventuelle delresultater.
5. Mål hele den synlige løypen etter dokumentklasse og utfør avgrensede A/B-forsøk med modellkonfigurasjonen som eneste eier. Ikke hev produksjonseffekt fra utviklingsserveren.
6. Utvid ekstraksjons-fixtures fra observerte feil i hierarkiske/gjentatte ID-er, sammenslåtte celler, skannede sider og rettelser. Original kontra utledet ID og faktisk kontra ukjent side skal forbli eksplisitt.

## Verifikasjon og utrulling

Den komplette lokale HTTP-testen har kjørt autentisering, tre dokumentroller, privat lagring, indeksering, analyse, kravsvar, vurdering og faktisk modellchat med siteringer lest tilbake fra databasen. En egen HTTP-test har regenerert én valgt rad og bevart to andre rader byte for byte. Live Entra-pålogging og PDF/OCR-opplasting er ikke etablert av disse TXT-scenariene. Visuell skjermdumpkontroll er fortsatt begrenset av tilkoblingsfeil i nettleserverktøyene.

SQL-migrasjoner er ikke kjørt i produksjon. Se implementasjonsloggen for rekkefølge, autocommit-kravet ved FTS-backfill og tilbakeføring av arbeiderplanen før en eldre arbeiderimage tas i bruk. Bygg, migrasjoner, konfigurasjon og utrulling skal rapporteres hver for seg.
