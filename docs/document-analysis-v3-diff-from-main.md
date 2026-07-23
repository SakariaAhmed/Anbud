# Kort diff fra produksjons-main

Branch: `Feature/document-analysis-v3`

Base: `origin/main` ved `9107dff2`

- Ny lokal PDF-layout v3 og versjonert `document-analysis.v3`-artefakt med
  separat, uendret kildetekst og kanonisk norsk analysetekst.
- Rettet strukturhandoff gir 3 505/3 505 eksakte kravtekster i den norske
  50-PDF-fasiten.
- Én kvalitetsruter eier PDF-fallback; det andre Docling-/lagrings-/indekseringsløpet
  er deaktivert i v3.
- Kundeanalyse bruker én fersk kanonisk kontekst per dokument og hopper over
  duplisert semantic retrieval. Eldre dokumenter beholder legacy-fallback.
- Ny dedikert GPT-5.6 Terra-rute bruker Responses API, lav reasoning, strengt
  JSON Schema og `store: false`; øvrige AI-flyter endrer ikke standardmodell.
- Ny portabel A/B-runner har absolutt USD 15-vern og målte 3/3 førsteplasser,
  50,2 % færre input-tokens og 49,9 % lavere genereringstid mot GPT-5.4.
- Ny utrullingskonfigurasjon: `DOCUMENT_ANALYSIS_VERSION` og
  `OPENAI_DOCUMENT_ANALYSIS_MODEL`. Standard er fortsatt av, med enkel rollback.
- Branchen inkluderer den videreførte v2-migrasjonen som oppretter krypterte
  artefakt- og hendelsestabeller med service-role/RLS-grense. V3 gjenbruker
  disse tabellene og trenger ingen ekstra migrasjon.
- Den arvede hardeningen stabiliserer også eier-ID-en for delt passordinnlogging
  på tvers av rotasjon av session-secret, slik at eksisterende prosjekttilgang
  ikke endres.
