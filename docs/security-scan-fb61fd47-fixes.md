# Retting av sikkerhetsskanning fb61fd47

Dato: 2026-09-06. Lokal branch: `Feature/security-scan-fb61fd47-fixes`.
Utgangspunkt: `f7abd3b583aca73a387fe760e28f4791b1838dcc`, identisk med revidert kode.
Arbeidskopien var ren før arbeidet. Åtte separate agenter implementerte ett funn hver;
en separat lesende agent undersøkte grensene og en ny lesende agent gjennomgikk
rettingene. Hovedagenten kontrollerte integrasjon, alternative kallere og verifikasjon.
Den fullførte skanningen og dens forseglede kanoniske funn er bevart.

Alle åtte opprinnelige angrepsveier er lukket i denne arbeidskopien. Ingen kode,
migrasjon eller vedlikeholdsoperasjon er kjørt mot produksjon.

## Endringer og bevis per funn

| Funn | Retting og viktigste filer | Regresjonsbevis og bevart funksjon |
| --- | --- | --- |
| 1. `authorization.project-owner-global-guest-credential` | Prosjektets access-rute, `access-control-repository.ts`, gjestemelding/delingsdialog og migrasjon `20260906093000_guest_credential_authority.sql`. Global koderotasjon krever aktiv administrator i rute, delt implementasjon og SQL. Eiere får ikke kontoens kode ved invitasjon; eksisterende kontoer uten kode kan ikke få en kode utstedt gjennom eierens invitasjon. | Eier med gjestens medlemskap i A kan ikke rotere koden som gir tilgang til B. SQL kontrollerer at avvisning bevarer kode og økter. Administratorrotasjon, øktinvalidering, e-post og administrativ manuell levering fungerer. Begge invitasjons-RPC-er og deaktiverte aktører/gjester er testet. |
| 2. `authorization.project-path-uuid-canonicalization` | Delt UUID-validering i middleware og serverautorisasjon; direkte tillatelseskontroller i tidligere middleware-avhengige prosjektendepunkter og AI-forberedelse. | 105 kjørte avvisningstilfeller fordelt på 21 ruteeksporter og fem UUID-former stopper før dataaksess. Kompakte/klammeformer avvises; vanlig UUID med store bokstaver fungerer. Tilbakekalte økter, begrenset leser og administrators manglende globale skriverett er dekket; tillatt lesing og redaktørens artefaktsletting fungerer. |
| 3. `parser.docx-expansion-fallback` | `documents.ts` validerer hele arkivet før Word XML-parserens reservevalg. Mammoth får et rekonstruert, kontrollert arkiv. | Full dokumentuttrekking avviser for høy ekspansjon uten å kalle Mammoth. Både vanlig XML-uttrekking og legitim alternativ Word-del via Mammoth fungerer. Originale kildebytes bevares. |
| 4. `parser.zip-declared-size-limit` | `documents.ts` bruker begrenset native zlib-utpakking, kontrollerer faktiske bytes og særbehandler falske nullstørrelser før JSZip forkaster metadata. XLSX og valgfri Docling får også kontrollerte, rekonstruerte arkiver. | Små adversarielle arkiver med underrapportert positiv/null størrelse avvises med native `ERR_BUFFER_TOO_LARGE`, før ubegrenset akkumulering. Vanlig DOCX, XLSX, STORE/DEFLATE, tomme filer og arkivkommentarer er kontrollert. Docling startes ikke for avvist arkiv. |
| 5. `parser.pdf-isolation-fallback` | `pdf-parser.ts` kjører begge motorer i separate arbeidstråder med samme tids-/heapgrenser. Ressurs-, tids- og trådfeil avslutter behandlingen. | Ekte eldre/moderne kompatibilitets-PDF-er og layoutkallere fungerer. Tester dekker faktisk kort tidsfrist, hengende tråd, simulert minnefeil/exit og side-/element-/tekstgrenser i begge motorer. Tråden avsluttes før resultat eller reserveforsøk. |
| 6. `authorization.source-document-job-result` | Alle Docling-utfall, jobbskriving, eldre krypterte lesinger og lokale cacher projiserer dokumentoversikten. `project-job-result-projection.ts` bruker eksplisitte tillatte dokumentfelt. Eget oppryddingsskript og migrasjon `20260906100000_clean_project_job_results.sql`. | Begrenset leser kan lese jobboversikt, detalj og SSE uten `file_base64`, råtekst eller lagringsfelt fra eldre krypterte resultater. Alle fem Docling-utfall er dekket. Opprydding er testet med tørrkjøring, idempotens, samtidighetskonflikter, SQL-rettigheter og ekte serialisering av 2 MiB testdata; krypterte kildedata går kun i POST-kropp. |
| 7. `availability.persisted-profit-share-loop` | `value-opportunities.ts`, lagringsrute og analysekomponent bruker endelig største-rest-fordeling og validerer maksimalt 100 manuelt lagrede oppføringer med endelig prosent 0–100. | 101 gamle oppføringer og 10 000 syntetiske oppføringer terminerer; null, ikke-endelige tall og summer som ellers ville overflyte er dekket. Nye ugyldige lagringer avvises før persistens. Gamle lister vises uten stille avkorting. Faktisk komponent er kontrollert syntetisk i nettleser ved 1440×900 og 390×844; sletting til 99 oppføringer aktiverer Legg til igjen. |
| 8. `filesystem.corpus-project-id-traversal` | `run_vurdering_api_full_251.mjs` validerer arbeidsbok-/prosjekt-ID og bruker en felles grense for checkpoint, evaluering, Markdown og hashlesing. Eksisterende symlenkede underkataloger/målfiler avvises. | Arbeidsbok med ikke-numerisk dokumentnavn og traversal-ID avvises før artefaktaksess. Suksess-, feil- og gjenopptakingsveier bevarer ekstern kontrollfil. Eksisterende gyldige identiteter, resume/merge og Petoro-preflight fungerer. Ingen live modell-/API-korpusjobb ble kjørt. |

## Samlet verifikasjon

Kjørt med Node **22.14.0**, samme versjon som CI, og eksisterende npm-låsfil.
Alle fire SQL-testvariabler pekte mot en egen lokal Docker-instans med
PostgreSQL 17/pgvector; tester opprettet og fjernet egne databaser.

- `npm test`: **869 frontendtester + 109 rottester bestod; 0 feil, 0 hoppet over**.
  Parserens golden-kjøring bestod også: 8 normaliseringer, 5 tabellreparasjoner,
  2 forventede kvalitetsaksepter, 5 forventede kvalitetsavvisninger og 2 ledger-uttrekk.
- `npm run lint`: bestod med null advarsler.
- `npm run build`: bestod etter retting av PDF-moduloppløsning i Next-pakken.
- Pakket standalone-PDF-parser: ekte eldre PDF og moderne kompatibilitets-PDF bestod.
  Alle parser-/canvasstier ble kontrollert inne i standalone-pakken, uten fallback
  til kildearbeidskopiens avhengigheter. 24 fokuserte PDF-regresjoner bestod.
- `npm run secrets:scan`: bestod. Nye filer kontrolleres også med et midlertidig
  Git-indeksbilde, uten å endre arbeidskopiens egentlige indeks.
- `node lib/server/audit-20260905/run.mjs`: **43/43** bestod med ekte disponibel
  PostgreSQL, inkludert det eksisterende additive oppgraderingstilfellet.
- Begge nye migrasjoner ble kjørt to ganger på både komplett ny baseline og
  utfylt database fra skanningens revisjon. Funksjonsdefinisjonene ble sammenlignet
  og var identiske; opprydding som `service_role` bevarte jobbstatus og metadata.
- `validate_project_jobs_schema.mjs`, `verify_workflow_boundaries.mjs` og
  `validate_release_workflows.mjs`: bestod. `git diff --check`: bestod.
- Den uavhengige kandidatgjennomgangen fant ingen konkret gjenstående omgåelse
  eller regresjon og kjørte 131 fokuserte tester. SQL-gapen i den lesende
  gjennomgangen er dekket av hovedagentens og implementeringsagentens SQL-kjøringer.

Eldre tester som lastet enkeltfunksjoner uten imports ble oppdatert med de nye
faktiske autorisasjons-/projeksjonsavhengighetene. Ingen produksjonskontroll ble
svekket for å få tester til å bestå. En SQL-testfixture og en utdatert PDF-navnetest
ble rettet; byggefeil i moduloppløsning ble reparert og relevante tester kjørt på nytt.

## Utrulling og avgrensninger

Begge migrasjoner må følge applikasjonsutgaven. Historiske krypterte jobbresultater
er beskyttet ved lesing, men produksjonens lagrede kopier er ikke renset her.
Kjør den dokumenterte tørrkjøringen og deretter eventuell opprydding i det autoriserte
miljøet etter migrasjonen: [oppryddingsveiledning](security-job-result-cleanup.md).
Sikkerhetskopier håndteres av eksisterende oppbevaringsrutiner; lesebeskyttelsen beholdes.

PDF-grensene er 25 MiB input, 2 000 sider, 250 000 elementer, 10 millioner
UTF-16-tegn og 120 sekunder per motor, med 192/32 MiB V8-heap og 4 MiB stack.
Dette er ikke en hard grense for samlet native RSS. Office-utpakking er begrenset
til 64 MiB per oppføring og 128 MiB samlet, med eksisterende kompresjonsgrense;
generell prosessisolasjon for Office-parserne ble ikke innført. ZIP64, flervolumsarkiv,
utrygge navn og tvetydige arkivavslutninger avvises uttrykkelig.

Nettleserkontrollen var syntetisk og lokal, ikke autentisert ende-til-ende mot
produksjon. Ekte Entra-/gjestepålogging, e-postlevering, Azure-workerutrulling og
live AI-/Docling-kvalitet ble ikke prøvd. Analyseoverskriftens eksisterende trange
mobiloppsett er ikke utvidet til en separat layoutretting. Ingen av rettingene er
publisert eller merget av denne oppgaven.
