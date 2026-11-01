import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const jiti = createJiti(
  path.join(frontendRoot, "solution-evaluation-readiness-tests.cjs"),
  {
    alias: { "@": frontendRoot, "server-only": "/dev/null" },
    interopDefault: true,
  },
);
const {
  assertCustomerAnalysisRequirementSourcesReady,
  assertExplicitRequirementLedgersComplete,
  assertEvaluationRequirementSourcesReady,
  assertSelectedSolutionDocumentReady,
  canonicalRequirementSourceDocuments,
  canonicalizeRequirementSourceLedger,
} = await jiti.import(
  path.join(
    frontendRoot,
    "lib/server/requirements/source-readiness.ts",
  ),
);
const { isRequirementDocument } = await jiti.import(
  path.join(frontendRoot, "lib/document-processing.ts"),
);
const { buildSolutionEvaluationProvenance } = await jiti.import(
  path.join(frontendRoot, "lib/server/workflow-boundaries.ts"),
);
const { selectProjectDocuments } = await jiti.import(
  path.join(frontendRoot, "lib/server/domain/project-documents.ts"),
);
const { sortRequirementLedgerInDocumentOrder } = await jiti.import(
  path.join(frontendRoot, "lib/server/requirements/presentation.ts"),
);

function document(overrides = {}) {
  return {
    id: "document-1",
    project_id: "project-1",
    role: "supporting_document",
    supporting_subtype: "kravdokument",
    title: "Kravspesifikasjon",
    file_name: "krav.pdf",
    file_format: "pdf",
    content_type: "application/pdf",
    file_size_bytes: 100,
    file_base64: "",
    raw_text: "K-1 Leverandøren skal dokumentere kapasitet.",
    structure_map: [],
    processing_status: "enhanced_ready",
    created_at: "2026-07-11T10:00:00.000Z",
    updated_at: "2026-07-11T10:00:00.000Z",
    ...overrides,
  };
}

function ledgerEntry(overrides = {}) {
  return {
    id: "K-1",
    text: "Leverandøren skal dokumentere kapasitet.",
    pages: [1],
    heading: "Krav",
    ...overrides,
  };
}

test("canonical requirement sources always put the customer before selected formal documents", () => {
  const customer = document({
    id: "customer",
    role: "primary_customer_document",
    supporting_subtype: null,
    title: "054_Bilag_1_NaboOmsorg_Koordinering_SA",
    file_name: "054_Bilag_1_NaboOmsorg_Koordinering_SA.pdf",
  });
  const formal = document({ id: "formal", title: "Bilag 2" });
  const otherFormal = document({ id: "other-formal", title: "Kravdel B" });
  const note = document({
    id: "note",
    supporting_subtype: "notat",
    title: "Møtereferat",
    file_name: "mote.md",
  });

  assert.deepEqual(
    canonicalRequirementSourceDocuments({
      customerDocument: customer,
      documents: [note, otherFormal, customer, formal],
      selectedFormalDocumentIds: [formal.id],
    }).map((item) => item.id),
    [customer.id, formal.id],
  );
});

test("054 keeps a genuine customer requirement before all 44 formal rows", () => {
  const customer = document({
    id: "customer",
    role: "primary_customer_document",
    supporting_subtype: null,
    title: "054_Bilag_1_NaboOmsorg_Koordinering_SA",
  });
  const formal = document({ id: "formal", title: "Bilag 2" });
  const customerRequirement = ledgerEntry({
    id: "Side 1 krav 1",
    text:
      "Løsningen skal tilbys som en moderne skybasert tjeneste med sikker autentisering, rollebasert tilgang, konfigurerbare arbeidsflyter og gode muligheter for integrasjon. Plattformen skal kunne tas i bruk stegvis og må kunne tilpasses lokale rutiner uten omfattende spesialutvikling.",
  });
  const formalRows = Array.from({ length: 44 }, (_, index) =>
    ledgerEntry({
      id: `R-${String(index + 1).padStart(3, "0")}`,
      text:
        index === 0
          ? "Løsningen skal ha sikker autentisering."
          : `Formelt krav ${index + 1} skal dokumenteres separat.`,
    }),
  );

  const canonical = canonicalizeRequirementSourceLedger({
    sourceDocuments: [customer, formal],
    requirementLedgerResults: [
      { document: customer, ledger: [customerRequirement] },
      { document: formal, ledger: formalRows },
    ],
  });

  assert.equal(canonical.length, 45);
  assert.equal(canonical[0].id, customerRequirement.id);
  assert.equal(canonical[0].documentId, customer.id);
  assert.equal(canonical[1].id, "R-001");
  assert.equal(canonical[44].id, "R-044");
});

test("empty customer ledger leaves the formal source ledger unchanged", () => {
  const customer = document({
    id: "customer",
    role: "primary_customer_document",
    supporting_subtype: null,
  });
  const formal = document({ id: "formal" });
  const formalRow = ledgerEntry({ documentId: formal.id });

  assert.deepEqual(
    canonicalizeRequirementSourceLedger({
      sourceDocuments: [customer, formal],
      requirementLedgerResults: [
        { document: customer, ledger: [] },
        { document: formal, ledger: [formalRow] },
      ],
    }),
    [
      {
        ...formalRow,
        documentTitle: formal.title,
        documentOrder: 1,
        documentEntryOrder: 0,
      },
    ],
  );
});

test("blank customer or formal requirement rows fail closed before canonicalization", () => {
  const customer = document({
    id: "customer",
    role: "primary_customer_document",
    supporting_subtype: null,
  });
  const formal = document({ id: "formal" });

  for (const blankDocument of [customer, formal]) {
    assert.throws(
      () =>
        canonicalizeRequirementSourceLedger({
          sourceDocuments: [customer, formal],
          requirementLedgerResults: [
            {
              document: customer,
              ledger:
                blankDocument.id === customer.id
                  ? [ledgerEntry({ id: "K-customer", text: "   " })]
                  : [],
            },
            {
              document: formal,
              ledger:
                blankDocument.id === formal.id
                  ? [ledgerEntry({ id: "K-formal", text: "\n\t" })]
                  : [ledgerEntry({ id: "K-valid" })],
            },
          ],
        }),
      new RegExp(
        `uten kravtekst:.*${blankDocument.id}:K-(?:customer|formal)`,
        "iu",
      ),
    );
  }
});

test("Petoro-style customer OCR duplicates collapse to the 74 formal rows", () => {
  const customer = document({
    id: "customer",
    role: "primary_customer_document",
    supporting_subtype: null,
  });
  const formal = document({ id: "formal" });
  const formalRows = Array.from({ length: 74 }, (_, index) =>
    ledgerEntry({
      id: `ID 2-${String(index + 1).padStart(2, "0")}`,
      text: `Leverandøren skal dokumentere formelt Petoro-krav nummer ${index + 1}.`,
    }),
  );
  formalRows[0] = ledgerEntry({
    id: "Tabell ID 2-11 - Tilgang og tilgjengelighet",
    text:
      "Løsningene skal kunne nås på en sikker tilgjengelighet måte fra kunden s kontor, fra hjemmekontor og ved ekstern oppkobling",
  });
  formalRows[1] = ledgerEntry({
    id: "Tabell ID 2-11 - Bruker-administrasjon",
    text:
      "Leverandøren skal etter godkjenning fra kunde utføre brukeradministrasjon og vedlikehold av brukerkonti på tvers av infrastruktur og anvendt programvare. Dette gjelder opprettelse av nye brukere, endringer for eksisterende brukere og slette/deaktivere brukere som ikke lenger skal ha tilgang. Det benyttes en arbeidsflyt i SharePoint som godkjenningsprosess for dette arbeidet.",
  });
  formalRows[2] = ledgerEntry({
    id: "Tabell ID 2-11 - Bistand ved revisjoner",
    text:
      "I samråd med kunden skal leverandøren yte nødvendig bistand i forbindelse med revisjon, internrevisjon og kvalitetskontroller av IT-drift og applikasjoner.",
  });
  const customerRows = [
    ledgerEntry({
      id: "Driftsaktiviteter - Tilgang og tilgjengelighet",
      text:
        "Løsningene skal kunne nås på en sikker måte fra kundens kontor, fra hjemmekontor og ved ekstern oppkobling",
    }),
    ledgerEntry({
      id: "Driftsaktiviteter - Brukeradministrasjon",
      text:
        "Leverandøren skal etter godkjenning fra kunde utføre brukeradministrasjon og vedlikehold av brukerkonti på tvers av infrastruktur og anvendt programvare. Dette gjelder opprettelse av nye brukere, endringer for eksisterende brukere og slette/deaktivere brukere som ikke lenger skal ha tilgang. Detbenyttes en arbeidsflyt i SharePointsom godkjenningsprosess for dette arbeidet.",
    }),
    ledgerEntry({
      id: "Driftsaktiviteter - Bistand ved revisjoner",
      text:
        "I samråd med kunden skal leverandøren yte nødvendig bistand i forbindelse med revisjon, internrevisjon og kvalitetskontroller avIT-drift og applikasjoner.",
    }),
    ...formalRows.slice(3, 18).map((entry) =>
      ledgerEntry({ id: `Driftsaktiviteter - ${entry.id}`, text: entry.text }),
    ),
  ];

  const canonical = canonicalizeRequirementSourceLedger({
    sourceDocuments: [customer, formal],
    requirementLedgerResults: [
      { document: customer, ledger: customerRows },
      { document: formal, ledger: formalRows },
    ],
  });

  assert.equal(canonical.length, 74);
  assert.ok(canonical.every((entry) => entry.documentId === formal.id));
});

test("shared row identity never collapses material internal and external requirements", () => {
  const customer = document({
    id: "customer",
    role: "primary_customer_document",
    supporting_subtype: null,
  });
  const formal = document({ id: "formal" });
  const customerRow = ledgerEntry({
    id: "Kravområde - Tilgangsstyring",
    service: "Tilgangsstyring",
    text: "Løsningen skal støtte innlogging med BankID for eksterne brukere.",
  });
  const formalRow = ledgerEntry({
    id: "Tabell 1 - Tilgangsstyring",
    service: "Tilgangsstyring",
    text: "Løsningen skal støtte innlogging med BankID for interne brukere.",
  });

  const canonical = canonicalizeRequirementSourceLedger({
    sourceDocuments: [customer, formal],
    requirementLedgerResults: [
      { document: customer, ledger: [customerRow] },
      { document: formal, ledger: [formalRow] },
    ],
  });

  assert.equal(canonical.length, 2);
  assert.deepEqual(
    canonical.map((entry) => entry.documentId),
    [customer.id, formal.id],
  );
});

test("exact short boilerplate remains distinct when service scope conflicts", () => {
  const customer = document({
    id: "customer",
    role: "primary_customer_document",
    supporting_subtype: null,
  });
  const formal = document({ id: "formal" });
  const text = "Alle endringer skal logges.";
  const canonical = canonicalizeRequirementSourceLedger({
    sourceDocuments: [customer, formal],
    requirementLedgerResults: [
      {
        document: customer,
        ledger: [
          ledgerEntry({
            id: "Brukeradministrasjon - Logging",
            service: "Brukeradministrasjon",
            heading: "Brukeradministrasjon",
            text,
          }),
        ],
      },
      {
        document: formal,
        ledger: [
          ledgerEntry({
            id: "Konfigurasjonsstyring - Logging",
            service: "Konfigurasjonsstyring",
            heading: "Konfigurasjonsstyring",
            text,
          }),
        ],
      },
    ],
  });

  assert.equal(canonical.length, 2);
});

test("Petoro ID 2-14 long exact duplicate collapses through its grounded asymmetric service scope", () => {
  const customer = document({
    id: "customer",
    role: "primary_customer_document",
    supporting_subtype: null,
  });
  const formal = document({ id: "formal" });
  const text =
    "Det skal tilbys stedlige ressurser for å ivareta sentrale deler av leveransen. On-site Helpdesk skal fungere som Single Point of Contact (SPOC) for alle brukerstøttehenvendelser. Videre skal stedlige ressurser ha ansvar for oppfølging og koordinering av underleverandører og øvrige involverte leverandører ved feilsituasjoner. Leverandøren skal beskrive systemer og arbeidsprosesser for hvordan slik koordinering og oppfølging gjennomføres i praksis. Avtalens basisperiode er virkedager mellom";
  assert.equal(text.length, 493);

  const canonical = canonicalizeRequirementSourceLedger({
    sourceDocuments: [customer, formal],
    requirementLedgerResults: [
      {
        document: customer,
        ledger: [
          ledgerEntry({
            id: "Driftsaktiviteter - Leveransekrav til stedlig og fjernbasert Helpdesk og TAM",
            service:
              "Leveransekrav til stedlig og fjernbasert Helpdesk og TAM",
            heading: "Driftsaktiviteter > Applikasjonsforvaltning",
            text,
          }),
        ],
      },
      {
        document: formal,
        ledger: [
          ledgerEntry({
            id: "ID 2-14",
            service: undefined,
            tableId: undefined,
            heading:
              "Petoros krav > Leveransekrav til stedlig og fjernbasert Helpdesk og TAM",
            text,
          }),
        ],
      },
    ],
  });

  assert.equal(canonical.length, 1);
  assert.equal(canonical[0].documentId, formal.id);
});

test("a long OCR-truncated customer prefix collapses into its fuller formal requirement", () => {
  const customer = document({
    id: "customer",
    role: "primary_customer_document",
    supporting_subtype: null,
  });
  const formal = document({ id: "formal" });
  const sharedPrefix = Array.from(
    { length: 9 },
    () =>
      "Stedlig Helpdesk og fjernbasert TAM skal koordinere leveransen, dokumentere kontrollene og følge opp avtalte aktiviteter. ",
  ).join("");
  const formalText = `${sharedPrefix}Ressursene skal i tillegg dokumentere Planner, OneNote, Power Automate, Copilot og oppgaver på tenant-nivå.`;
  assert.ok(sharedPrefix.replace(/\s+/g, "").length >= 800);
  assert.ok(
    sharedPrefix.replace(/\s+/g, "").length /
      formalText.replace(/\s+/g, "").length >=
      0.8,
  );

  const canonical = canonicalizeRequirementSourceLedger({
    sourceDocuments: [customer, formal],
    requirementLedgerResults: [
      {
        document: customer,
        ledger: [
          ledgerEntry({
            id: "Driftsaktiviteter - Leveransekrav til stedlig og fjernbasert Helpdesk og TAM",
            service:
              "Leveransekrav til stedlig og fjernbasert Helpdesk og TAM",
            text: sharedPrefix,
          }),
        ],
      },
      {
        document: formal,
        ledger: [
          ledgerEntry({
            id: "ID 2-14",
            service: undefined,
            tableId: undefined,
            text: formalText,
          }),
        ],
      },
    ],
  });

  assert.equal(canonical.length, 1);
  assert.equal(canonical[0].documentId, formal.id);
  assert.equal(canonical[0].text, formalText);
});

test("long exact text remains distinct when neither source has service scope and headings conflict", () => {
  const customer = document({
    id: "customer",
    role: "primary_customer_document",
    supporting_subtype: null,
  });
  const formal = document({ id: "formal" });
  const text =
    "Alle hendelser skal registreres med tidspunkt, aktør, korrelasjonsidentifikator, førverdi og etterverdi, og dokumentasjonen skal være tilgjengelig for revisjon. ".repeat(
      2,
    );
  assert.ok(text.length >= 160);

  const canonical = canonicalizeRequirementSourceLedger({
    sourceDocuments: [customer, formal],
    requirementLedgerResults: [
      {
        document: customer,
        ledger: [
          ledgerEntry({
            id: "Dokumenttekst krav 1",
            service: undefined,
            heading: "Brukeradministrasjon",
            text,
          }),
        ],
      },
      {
        document: formal,
        ledger: [
          ledgerEntry({
            id: "Dokumenttekst krav 2",
            service: undefined,
            heading: "Konfigurasjonsstyring",
            text,
          }),
        ],
      },
    ],
  });

  assert.equal(canonical.length, 2);
  assert.deepEqual(
    canonical.map((entry) => entry.documentId),
    [customer.id, formal.id],
  );
});

test("long exact text remains distinct when both sources declare conflicting service scope", () => {
  const customer = document({
    id: "customer",
    role: "primary_customer_document",
    supporting_subtype: null,
  });
  const formal = document({ id: "formal" });
  const text = "Alle endringer skal logges med tidspunkt, aktør, førverdi og etterverdi. ".repeat(
    4,
  );
  assert.ok(text.length >= 160);

  const canonical = canonicalizeRequirementSourceLedger({
    sourceDocuments: [customer, formal],
    requirementLedgerResults: [
      {
        document: customer,
        ledger: [
          ledgerEntry({
            id: "Brukeradministrasjon - Logging",
            service: "Brukeradministrasjon",
            text,
          }),
        ],
      },
      {
        document: formal,
        ledger: [
          ledgerEntry({
            id: "Konfigurasjonsstyring - Logging",
            service: "Konfigurasjonsstyring",
            text,
          }),
        ],
      },
    ],
  });

  assert.equal(canonical.length, 2);
});

test("OCR duplicate suppression rejects negation and numeric-unit changes", () => {
  const customer = document({
    id: "customer",
    role: "primary_customer_document",
    supporting_subtype: null,
  });
  const formal = document({ id: "formal" });
  const rows = [
    [
      "Løsningen skal ikke være utilgjengelig i mer enn 5 minutter.",
      "Løsningen skal være utilgjengelig i mer enn 5 minutter.",
    ],
    [
      "Tjenesten skal svare innen 5 sekunder.",
      "Tjenesten skal svare innen 3 sekunder.",
    ],
  ];

  for (const [customerText, formalText] of rows) {
    const canonical = canonicalizeRequirementSourceLedger({
      sourceDocuments: [customer, formal],
      requirementLedgerResults: [
        {
          document: customer,
          ledger: [
            ledgerEntry({
              id: "Kravområde - Tilgjengelighet",
              service: "Tilgjengelighet",
              text: customerText,
            }),
          ],
        },
        {
          document: formal,
          ledger: [
            ledgerEntry({
              id: "Tabell 1 - Tilgjengelighet",
              service: "Tilgjengelighet",
              text: formalText,
            }),
          ],
        },
      ],
    });

    assert.equal(canonical.length, 2, `${customerText} <> ${formalText}`);
  }
});

test("identical rows in separate formal documents are never merged", () => {
  const customer = document({
    id: "customer",
    role: "primary_customer_document",
    supporting_subtype: null,
  });
  const firstFormal = document({ id: "formal-a" });
  const secondFormal = document({ id: "formal-b" });
  const repeatedText = "Leverandøren skal dokumentere samme kontroll.";

  const canonical = canonicalizeRequirementSourceLedger({
    sourceDocuments: [customer, firstFormal, secondFormal],
    requirementLedgerResults: [
      { document: customer, ledger: [] },
      {
        document: firstFormal,
        ledger: [ledgerEntry({ id: "K-1", text: repeatedText })],
      },
      {
        document: secondFormal,
        ledger: [ledgerEntry({ id: "K-1", text: repeatedText })],
      },
    ],
  });

  assert.equal(canonical.length, 2);
  assert.deepEqual(
    canonical.map((entry) => entry.documentId),
    [firstFormal.id, secondFormal.id],
  );
});

test("distinct repeated rows inside one formal document are never merged", () => {
  const customer = document({
    id: "customer",
    role: "primary_customer_document",
    supporting_subtype: null,
  });
  const formal = document({ id: "formal" });
  const repeated = ledgerEntry({
    id: "K-1",
    text: "Leverandøren skal dokumentere samme kontroll.",
  });

  const canonical = canonicalizeRequirementSourceLedger({
    sourceDocuments: [customer, formal],
    requirementLedgerResults: [
      { document: customer, ledger: [] },
      {
        document: formal,
        ledger: [
          { ...repeated, documentEntryOrder: 3 },
          { ...repeated, documentEntryOrder: 7 },
        ],
      },
    ],
  });

  assert.equal(canonical.length, 2);
  assert.deepEqual(
    canonical.map((entry) => entry.documentEntryOrder),
    [0, 1],
  );
  assert.deepEqual(
    canonical.map((entry) => entry.sourceDocumentEntryOrder),
    [3, 7],
  );
});

test("canonical source order normalizes incompatible parser coordinates before every downstream sort", () => {
  const formal = document({ id: "petoro-formal" });
  const rows = [
    ledgerEntry({
      id: "ID 2-01",
      pages: [6],
      documentEntryOrder: 60_010,
    }),
    ledgerEntry({
      id: "ID 2-14",
      pages: [9, 10, 11, 12, 13, 14, 15],
      documentEntryOrder: 150_023,
    }),
    ledgerEntry({
      id: "Tabell ID 2-11 - Tilgang og tilgjengelighet",
      pages: [10],
      tableId: "Tabell ID 2-11",
      service: "Tilgang og tilgjengelighet",
    }),
    ledgerEntry({
      id: "ID 2-30",
      pages: [24],
      documentEntryOrder: 240_002,
    }),
    ledgerEntry({
      id: "Tabell ID 2-31 - Ivareta",
      pages: [24],
      tableId: "Tabell ID 2-31",
      service: "Ivareta",
    }),
  ];
  const canonical = canonicalizeRequirementSourceLedger({
    sourceDocuments: [formal],
    requirementLedgerResults: [{ document: formal, ledger: rows }],
  });

  assert.deepEqual(
    canonical.map((entry) => entry.documentEntryOrder),
    [0, 1, 2, 3, 4],
  );
  assert.deepEqual(
    canonical.map((entry) => entry.sourceDocumentEntryOrder),
    [60_010, 150_023, undefined, 240_002, undefined],
  );
  assert.deepEqual(
    sortRequirementLedgerInDocumentOrder(canonical).map((entry) => entry.id),
    rows.map((entry) => entry.id),
  );
});

test("solution evaluation provenance records canonical sources, ledger hash, and source revision", () => {
  const customer = document({
    id: "customer",
    role: "primary_customer_document",
    supporting_subtype: null,
  });
  const solution = document({
    id: "solution",
    role: "primary_solution_document",
    supporting_subtype: null,
  });
  const provenance = buildSolutionEvaluationProvenance({
    customerDocument: customer,
    solutionDocument: solution,
    requirementSourceDocumentIds: [customer.id, "formal"],
    requirementSourceManifestSha256: "a".repeat(64),
    sourceRevision: 42,
  });

  assert.deepEqual(provenance.requirement_source_document_ids, [
    customer.id,
    "formal",
  ]);
  assert.equal(provenance.requirement_source_manifest_sha256, "a".repeat(64));
  assert.equal(provenance.source_revision, 42);
});

for (const processingStatus of ["queued", "failed"]) {
  test(`mixed ready + ${processingStatus} requirement sources fail closed`, () => {
    const sources = [
      document({
        id: "customer",
        role: "primary_customer_document",
        supporting_subtype: null,
        title: "Konkurransegrunnlag",
      }),
      document({
        id: "blocked-requirements",
        processing_status: processingStatus,
        raw_text: "",
      }),
    ];

    assert.throws(
      () => assertEvaluationRequirementSourcesReady(sources),
      new RegExp(processingStatus, "u"),
    );
  });
}

test("a ready requirement source without readable hydrated text fails closed", () => {
  assert.throws(
    () =>
      assertEvaluationRequirementSourcesReady(
        [document({ raw_text: "" })],
        { requireReadableText: true },
      ),
    /mangler lesbar tekst etter hydrering/u,
  );
});

test("evaluation accepts the same structure-only requirement source as generation", () => {
  const structured = document({
    raw_text: "",
    structure_map: [
      {
        reference: "Rad 1",
        text: "",
        cells: { Krav: "Leverandøren skal dokumentere kontrollen." },
      },
    ],
  });

  assert.doesNotThrow(() =>
    assertEvaluationRequirementSourcesReady([structured], {
      requireReadableText: true,
    }),
  );
});

test("an explicit rfp subtype is a requirement source even with neutral metadata", () => {
  const rfp = document({
    supporting_subtype: "rfp",
    title: "Dokument A",
    file_name: "document-a.pdf",
    processing_status: "queued",
    raw_text: "",
  });

  assert.equal(isRequirementDocument(rfp), true);
  assert.throws(
    () => assertEvaluationRequirementSourcesReady([rfp]),
    /Dokument A \(queued\)/u,
  );
  assert.throws(
    () =>
      assertExplicitRequirementLedgersComplete([rfp], [
        { document: rfp, ledger: [] },
      ]),
    /Dokument A/u,
  );
});

for (const processingStatus of ["queued", "processing", "failed"]) {
  test(`customer analysis blocks a ${processingStatus} supporting rfp`, () => {
    const customer = document({
      id: "customer",
      role: "primary_customer_document",
      supporting_subtype: null,
      title: "Kundens hoveddokument",
    });
    const blockedRfp = document({
      id: "blocked-rfp",
      supporting_subtype: "rfp",
      title: "Dokument A",
      file_name: "document-a.pdf",
      processing_status: processingStatus,
      raw_text: "",
    });

    assert.throws(
      () =>
        assertCustomerAnalysisRequirementSourcesReady([customer, blockedRfp]),
      new RegExp(`Dokument A \\(${processingStatus}\\)`, "u"),
    );
  });
}

test("customer analysis blocks an empty likely supporting requirement document", () => {
  const customer = document({
    id: "customer",
    role: "primary_customer_document",
    supporting_subtype: null,
    title: "Kundens hoveddokument",
  });
  const emptyRequirements = document({
    id: "empty-requirements",
    supporting_subtype: "vedlegg",
    title: "Tekniske krav",
    file_name: "vedlegg-a.pdf",
    raw_text: "",
  });

  assert.throws(
    () =>
      assertCustomerAnalysisRequirementSourcesReady([
        customer,
        emptyRequirements,
      ]),
    /Tekniske krav \(mangler lesbar tekst etter hydrering\)/u,
  );
});

test("customer analysis blocks a pending solution-named formal requirement source", () => {
  const customer = document({
    id: "customer",
    role: "primary_customer_document",
    supporting_subtype: null,
    title: "Kundens hoveddokument",
  });
  const pendingRequirements = document({
    id: "solution-requirements",
    supporting_subtype: "kravdokument",
    title: "Løsningskrav og arkitektur",
    file_name: "solution-architecture-requirements.pdf",
    processing_status: "processing",
    raw_text: "",
  });
  const selected = selectProjectDocuments([customer, pendingRequirements]);

  assert.equal(selected.solutionDocument, null);
  assert.deepEqual(
    selected.supportingDocuments.map((item) => item.id),
    [pendingRequirements.id],
  );
  assert.throws(
    () =>
      assertCustomerAnalysisRequirementSourcesReady([
        selected.customerDocument,
        ...selected.supportingDocuments,
      ]),
    /Løsningskrav og arkitektur \(processing\)/u,
  );
});

test("pending non-requirement notes do not block evaluation", () => {
  assert.doesNotThrow(() =>
    assertEvaluationRequirementSourcesReady([
      document({
        supporting_subtype: "notat",
        title: "Internt møtenotat",
        file_name: "motenotat.txt",
        processing_status: "queued",
        raw_text: "",
      }),
    ]),
  );
});

for (const processingStatus of ["queued", "failed"]) {
  test(`a selected ${processingStatus} solution document fails closed`, () => {
    assert.throws(
      () =>
        assertSelectedSolutionDocumentReady(
          document({
            role: "primary_solution_document",
            supporting_subtype: null,
            title: "Bilag 2",
            file_name: "arkitektlosning.pdf",
            processing_status: processingStatus,
            raw_text: "",
          }),
        ),
      new RegExp(processingStatus, "u"),
    );
  });
}

test("a hydrated solution document without readable text fails closed", () => {
  assert.throws(
    () =>
      assertSelectedSolutionDocumentReady(
        document({
          role: "primary_solution_document",
          supporting_subtype: null,
          title: "Bilag 2",
          file_name: "arkitektlosning.pdf",
          raw_text: "",
        }),
        { requireReadableText: true },
      ),
    /mangler lesbar tekst etter hydrering/u,
  );
});

test("supporting requirement documents and mislabeled primary solutions are rejected as solution input", () => {
  const invalidDocuments = [
    document({
      role: "supporting_document",
      supporting_subtype: "kravdokument",
      title: "Kravspesifikasjon",
    }),
    document({
      role: "primary_solution_document",
      supporting_subtype: null,
      title: "Konkurransegrunnlag og tekniske krav",
      file_name: "rfp-requirements.pdf",
    }),
    document({
      role: "primary_solution_document",
      supporting_subtype: "kravdokument",
      title: "API-generert Krav og svar",
      file_name: "kravsvar.md",
    }),
  ];

  for (const invalidDocument of invalidDocuments) {
    assert.throws(
      () => assertSelectedSolutionDocumentReady(invalidDocument),
      /ikke en godkjent arkitektløsning/u,
    );
  }
});

test("an explicitly selected generated requirement response is approved as solution input", () => {
  const response = document({
    role: "primary_solution_document",
    supporting_subtype: null,
    title: "API-generert Krav og svar - NaboOmsorg Koordinering SA",
    file_name: "100-folder-054-naboomsorg-kravsvar.md",
    raw_text: "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |",
  });

  assert.doesNotThrow(() =>
    assertSelectedSolutionDocumentReady(response, { requireReadableText: true }),
  );
  assert.equal(isRequirementDocument(response), false);
});

for (const metadata of [
  { title: "Bilag 2", file_name: "krav-svar.md" },
  { title: "Bilag 2", file_name: "krav – svar.md" },
  { title: "Bilag 2", file_name: "requirements-response.md" },
  {
    title: "Solution-response-to-requirements",
    file_name: "proposal.md",
  },
]) {
  test(`explicit response separators remain valid solution input: ${metadata.file_name}`, () => {
    const response = document({
      role: "primary_solution_document",
      supporting_subtype: null,
      raw_text: "Krav K-1 besvares med en dokumentert løsning.",
      ...metadata,
    });

    assert.doesNotThrow(() =>
      assertSelectedSolutionDocumentReady(response, {
        requireReadableText: true,
      }),
    );
    assert.equal(isRequirementDocument(response), false);
  });
}

for (const metadata of [
  {
    title: "Krav og svar til konkurransegrunnlag",
    file_name: "rfp-response.md",
  },
  {
    title: "Kravbesvarelse - kravspesifikasjon",
    file_name: "response.md",
  },
  {
    title: "Krav og svar",
    file_name: "Bilag 1.md",
  },
  {
    title: "Requirements response",
    file_name: "requirements-document.md",
  },
  {
    title: "Solution-response-to-requirements",
    file_name: "rfp.md",
  },
  { title: "Krav-svar", file_name: "krav-dokument.md" },
  { title: "Krav-svar", file_name: "krav dokument.md" },
  { title: "Krav-svar", file_name: "krav_spesifikasjon.md" },
  { title: "Krav-svar", file_name: "krav-grunnlag.md" },
]) {
  test(`an answer-like title cannot override an unambiguous requirement source: ${metadata.title}`, () => {
    assert.throws(
      () =>
        assertSelectedSolutionDocumentReady(
          document({
            role: "primary_solution_document",
            supporting_subtype: null,
            ...metadata,
          }),
        ),
      /ikke en godkjent arkitektløsning/u,
    );
  });
}

test("a historical solution is never rediscovered as a requirement source from its title", () => {
  const historicalSolution = document({
    role: "supporting_document",
    supporting_subtype: "tidligere_losning",
    title: "Bilag 2 - Krav og svar",
    file_name: "kravsvar.md",
  });

  assert.equal(isRequirementDocument(historicalSolution), false);
  assert.doesNotThrow(() =>
    assertExplicitRequirementLedgersComplete([historicalSolution], [
      { document: historicalSolution, ledger: [] },
    ]),
  );
});

test("one populated and one empty explicit kravdokument fails closed", () => {
  const populated = document({ id: "krav-1", title: "Kravdel A" });
  const empty = document({ id: "krav-2", title: "Kravdel B" });

  assert.throws(
    () =>
      assertExplicitRequirementLedgersComplete([populated, empty], [
        { document: populated, ledger: [{ id: "A-1" }] },
        { document: empty, ledger: [] },
      ]),
    /Kravdel B/u,
  );
});

test("every populated explicit kravdokument passes ledger completeness", () => {
  const first = document({
    id: "krav-1",
    title: "Kravdel A",
    raw_text: "A-1 Leverandøren skal dokumentere kontroll A.",
  });
  const second = document({
    id: "krav-2",
    title: "Kravdel B",
    raw_text: "B-1 Leverandøren skal dokumentere kontroll B.",
  });

  assert.doesNotThrow(() =>
    assertExplicitRequirementLedgersComplete([first, second], [
      {
        document: first,
        ledger: [ledgerEntry({ id: "A-1", documentId: first.id })],
      },
      {
        document: second,
        ledger: [ledgerEntry({ id: "B-1", documentId: second.id })],
      },
    ]),
  );
});

test("large explicit requirement inventories fail closed when extraction is partial", () => {
  const rawRows = Array.from(
    { length: 100 },
    (_, index) =>
      `K-${String(index + 1).padStart(3, "0")} Leverandøren skal dokumentere kontroll ${index + 1}.`,
  );
  const formal = document({ raw_text: rawRows.join("\n") });
  const completeLedger = rawRows.map((_, index) =>
    ledgerEntry({
      id: `K-${String(index + 1).padStart(3, "0")}`,
      text: `Leverandøren skal dokumentere kontroll ${index + 1}.`,
      documentId: formal.id,
      documentEntryOrder: index,
    }),
  );

  assert.throws(
    () =>
      assertExplicitRequirementLedgersComplete([formal], [
        { document: formal, ledger: completeLedger.slice(0, 5) },
      ]),
    /mangler eksplisitte kilderader.*K006/iu,
  );
  assert.doesNotThrow(() =>
    assertExplicitRequirementLedgersComplete([formal], [
      { document: formal, ledger: completeLedger },
    ]),
  );
});

test("authoritative explicit tables fail closed on extra or reordered ledger rows", () => {
  const ids = [
    "FUN-A01",
    "FUN-A02",
    "FUN-B01",
    "MIG-B04",
  ];
  const formal = document({
    title: "Bilag 1 Nordhavn",
    raw_text: [
      "6. Kravtabell",
      ...ids.flatMap((id) => [
        `${id} | ${id.includes("-A") ? "A" : "B"} | Fagområde`,
        "Leverandøren skal dokumentere kontroll og sporbarhet.",
        "Svarinstruks: Bekreft og beskriv.",
      ]),
      "8. Tildelingskriterier",
      "Vurderingen bygger særlig på FUN-B01 og MIG-B04.",
    ].join("\n"),
  });
  const completeLedger = ids.map((id, index) =>
    ledgerEntry({
      id,
      text: "Leverandøren skal dokumentere kontroll og sporbarhet.",
      documentId: formal.id,
      documentEntryOrder: index,
    }),
  );

  assert.doesNotThrow(() =>
    assertExplicitRequirementLedgersComplete([formal], [
      { document: formal, ledger: completeLedger },
    ]),
  );
  assert.throws(
    () =>
      assertExplicitRequirementLedgersComplete([formal], [
        {
          document: formal,
          ledger: [
            ...completeLedger,
            ledgerEntry({
              id: "SSA-L 2026",
              text: "Tildelingskriterium skal vurderes.",
              documentId: formal.id,
            }),
          ],
        },
      ]),
    /avviker fra den eksplisitte kravtabellen.*fikk 5.*1 rader uten entydig krav-ID/iu,
  );
  assert.throws(
    () =>
      assertExplicitRequirementLedgersComplete([formal], [
        {
          document: formal,
          ledger: [
            completeLedger[1],
            completeLedger[0],
            ...completeLedger.slice(2),
          ],
        },
      ]),
    /avviker fra den eksplisitte kravtabellen/iu,
  );
});

test("a TOC occurrence plus the real unstructured requirement counts as one expected row", () => {
  const formal = document({
    raw_text: [
      "Innholdsfortegnelse",
      "K-1 Krav til tilgangsstyring ............................... 12",
      "K-1 Leverandøren skal dokumentere tilgangsstyring.",
    ].join("\n"),
  });

  assert.doesNotThrow(() =>
    assertExplicitRequirementLedgersComplete([formal], [
      {
        document: formal,
        ledger: [
          ledgerEntry({
            id: "K-1",
            text: "Leverandøren skal dokumentere tilgangsstyring.",
            documentId: formal.id,
          }),
        ],
      },
    ]),
  );
});

test("duplicate explicit IDs in distinct structured rows count separately", () => {
  const formal = document({
    raw_text: [
      "Innholdsfortegnelse",
      "K-1 Krav til sikkerhet ..................................... 8",
      "| Krav-ID | Krav |",
      "|---|---|",
      "| K-1 | Leverandøren skal dokumentere tilgangsstyring. |",
      "| K-1 | Leverandøren skal dokumentere sikkerhetskopiering. |",
    ].join("\n"),
  });
  const rows = [
    ledgerEntry({
      id: "K-1",
      text: "Leverandøren skal dokumentere tilgangsstyring.",
      documentId: formal.id,
      documentEntryOrder: 0,
      sourceExcerpt: "Rad 1",
    }),
    ledgerEntry({
      id: "K-1",
      text: "Leverandøren skal dokumentere sikkerhetskopiering.",
      documentId: formal.id,
      documentEntryOrder: 1,
      sourceExcerpt: "Rad 2",
    }),
  ];

  assert.throws(
    () =>
      assertExplicitRequirementLedgersComplete([formal], [
        { document: formal, ledger: rows.slice(0, 1) },
      ]),
    /k1 × 1/iu,
  );
  assert.doesNotThrow(() =>
    assertExplicitRequirementLedgersComplete([formal], [
      { document: formal, ledger: rows },
    ]),
  );
});

test("explicit cross-references are not invented as requirement rows", () => {
  const formal = document({
    raw_text: [
      "K-001 Leverandøren skal dokumentere tilgangsstyring.",
      "Se K-099 for definisjoner og bakgrunnsinformasjon.",
    ].join("\n"),
  });

  assert.doesNotThrow(() =>
    assertExplicitRequirementLedgersComplete([formal], [
      {
        document: formal,
        ledger: [
          ledgerEntry({
            id: "K-001",
            documentId: formal.id,
            sourceExcerpt: "K-001",
          }),
        ],
      },
    ]),
  );
});

for (const override of [
  { title: "Tekniske krav", file_name: "vedlegg.pdf" },
  { title: "Kravbeskrivelse", file_name: "vedlegg-b.pdf" },
  { title: "Vedlegg C", file_name: "customer-requirements.docx" },
  { title: "RFP", file_name: "anskaffelse.pdf" },
  { title: "Bilag 1", file_name: "kundens-behov.pdf" },
  { title: "Vedlegg D", file_name: "Bilag 2.docx" },
]) {
  test(`empty likely supporting requirement document fails closed: ${override.title}`, () => {
    const likelyRequirement = document({
      id: `likely-${override.title}`,
      supporting_subtype: "notat",
      ...override,
    });
    assert.throws(
      () =>
        assertExplicitRequirementLedgersComplete([likelyRequirement], [
          { document: likelyRequirement, ledger: [] },
        ]),
      new RegExp(override.title, "u"),
    );
  });
}

test("empty primary customer narrative remains exempt from ledger completeness", () => {
  const narrative = document({
    role: "primary_customer_document",
    supporting_subtype: null,
    title: "Konkurransegrunnlag med krav og behov",
    file_name: "RFP-requirements.pdf",
  });

  assert.doesNotThrow(() =>
    assertExplicitRequirementLedgersComplete([narrative], [
      { document: narrative, ledger: [] },
    ]),
  );
});

test("empty primary customer Bilag 1 narrative remains exempt", () => {
  const narrative = document({
    role: "primary_customer_document",
    supporting_subtype: null,
    title: "Bilag 1",
    file_name: "bilag-1-kundens-beskrivelse.pdf",
  });

  assert.doesNotThrow(() =>
    assertExplicitRequirementLedgersComplete([narrative], [
      { document: narrative, ledger: [] },
    ]),
  );
});

test("empty unrelated supporting note remains exempt from ledger completeness", () => {
  const note = document({
    supporting_subtype: "notat",
    title: "Referat fra oppstartsmøte",
    file_name: "referat.txt",
  });

  assert.doesNotThrow(() =>
    assertExplicitRequirementLedgersComplete([note], [
      { document: note, ledger: [] },
    ]),
  );
});

test("IDs another formal document defines are references where only named in sentences", () => {
  const customer = document({
    id: "customer",
    role: "primary_customer_document",
    supporting_subtype: null,
    title: "Konkurransegrunnlag",
    raw_text: [
      "5.1 Frister",
      "Tilbud som kommer inn etter fristen, vil bli avvist.",
      "9 Rettelser og presiseringer",
      "1. Krav K-4.1.2 i Bilag 1 endres og skal nå lyde: «Leverandøren skal gjenopprette innen 4 timer.»",
      "2. Spørsmål fra leverandør: Kan driftssenteret i K-3.3.1 ligge utenfor Norden? Svar: Ja. Kravet står uendret.",
    ].join("\n"),
  });
  const register = document({
    id: "register",
    title: "Bilag 1 Kravspesifikasjon",
    raw_text: [
      "K-3.3.1 Minstekrav Leverandørens driftssenter skal ligge innenfor EØS.",
      "K-4.1.2 Minstekrav Leverandøren skal gjenopprette innen 8 timer.",
    ].join("\n"),
  });
  const criteria = document({
    id: "criteria",
    supporting_subtype: "vedlegg",
    title: "Bilag 2 Evaluering",
    raw_text: "Rad 3: Kvalitet | 35 % | Besvarelsen av bør-kravene K-3.3.1 og K-4.1.2 inngår.",
  });
  const canonical = canonicalizeRequirementSourceLedger({
    sourceDocuments: [customer, register, criteria],
    requirementLedgerResults: [
      {
        document: customer,
        ledger: [
          ledgerEntry({ id: "K-4.1.2", text: "i Bilag 1 endres og skal nå lyde: «Leverandøren skal gjenopprette innen 4 timer.»" }),
          ledgerEntry({ id: "K-3.3.1", text: "ligge utenfor Norden? Svar: Ja. Kravet står uendret." }),
          // A parser that stops at the first level reads "K-4" from "K-4.1.2".
          ledgerEntry({ id: "K-4", text: "Leverandøren skal gjenopprette innen 4 timer." }),
        ],
      },
      {
        document: register,
        ledger: [
          ledgerEntry({ id: "K-3.3.1", text: "Leverandørens driftssenter skal ligge innenfor EØS." }),
          ledgerEntry({ id: "K-4.1.2", text: "Leverandøren skal gjenopprette innen 8 timer." }),
        ],
      },
      {
        document: criteria,
        ledger: [ledgerEntry({ id: "K-3.3", text: ".1 og K-4.1.2 inngår." })],
      },
    ],
  });

  assert.deepEqual(
    canonical.map((entry) => [entry.documentId, entry.id, entry.text]),
    [
      ["register", "K-3.3.1", "Leverandørens driftssenter skal ligge innenfor EØS."],
      // The corrections chapter of the main document changes the register.
      ["register", "K-4.1.2", "Leverandøren skal gjenopprette innen 4 timer."],
    ],
  );

  // Before corrections, the original wording is still the register's.
  const originals = canonicalizeRequirementSourceLedger(
    {
      sourceDocuments: [customer, register],
      requirementLedgerResults: [
        { document: customer, ledger: [] },
        { document: register, ledger: [ledgerEntry({ id: "K-4.1.2", text: "Leverandøren skal gjenopprette innen 8 timer." })] },
      ],
    },
    { applyCrossDocumentCorrections: false },
  );
  assert.equal(originals[0].text, "Leverandøren skal gjenopprette innen 8 timer.");
});

test("an ID that heads a line in a second document stays that document's requirement", () => {
  const register = document({ id: "register", raw_text: "K-1.1 Leverandøren skal levere drift." });
  const second = document({
    id: "second",
    title: "Bilag 3 Tilleggskrav",
    raw_text: "K-1.1 Leverandøren skal levere opplæring.\nK-1.2 Leverandøren skal levere dokumentasjon.",
  });
  const canonical = canonicalizeRequirementSourceLedger({
    sourceDocuments: [register, second],
    requirementLedgerResults: [
      { document: register, ledger: [ledgerEntry({ id: "K-1.1", text: "Leverandøren skal levere drift." })] },
      {
        document: second,
        ledger: [
          ledgerEntry({ id: "K-1.1", text: "Leverandøren skal levere opplæring." }),
          ledgerEntry({ id: "K-1.2", text: "Leverandøren skal levere dokumentasjon." }),
        ],
      },
    ],
  });
  assert.deepEqual(
    canonical.map((entry) => [entry.documentId, entry.id]),
    [["register", "K-1.1"], ["second", "K-1.1"], ["second", "K-1.2"]],
  );
});

test("a definition in a table cell keeps an overlapping ID in a second register", () => {
  const register = document({ id: "register", raw_text: "K-1.1 Leverandøren skal levere drift.\nK-1.2 Leverandøren skal levere støtte." });
  const second = document({ id: "second", title: "Bilag 3 Tilleggskrav", raw_text: "Rad 1: Sikkerhet | K-1.1 | Leverandøren skal levere opplæring." });
  const canonical = canonicalizeRequirementSourceLedger({
    sourceDocuments: [register, second],
    requirementLedgerResults: [
      {
        document: register,
        ledger: [
          ledgerEntry({ id: "K-1.1", text: "Leverandøren skal levere drift." }),
          ledgerEntry({ id: "K-1.2", text: "Leverandøren skal levere støtte." }),
        ],
      },
      { document: second, ledger: [ledgerEntry({ id: "K-1.1", text: "Leverandøren skal levere opplæring.", tableId: "Tabell 1" })] },
    ],
  });
  assert.deepEqual(canonical.map((entry) => [entry.documentId, entry.id]), [["register", "K-1.1"], ["register", "K-1.2"], ["second", "K-1.1"]]);
});

test("one corrections chapter changes, withdraws and adds requirements in each register it names", () => {
  const customer = document({
    id: "customer",
    role: "primary_customer_document",
    supporting_subtype: null,
    title: "Konkurransegrunnlag",
    raw_text: [
      "9 Rettelser",
      "1. Krav K-1.1 i Bilag 1 endres og skal nå lyde: «Leverandøren skal levere drift hele døgnet.»",
      "2. Krav R-1.1 i Bilag 3 endres og skal nå lyde: «Leverandøren skal rapportere ukentlig.»",
      "3. Krav K-1.2 i Bilag 1 utgår.",
      "4. Nytt krav K-1.3 legges til i Bilag 1: «Leverandøren skal levere en exitplan.»",
    ].join("\n"),
  });
  const kRegister = document({ id: "k-register", title: "Bilag 1", raw_text: "K-1.1 Leverandøren skal levere drift.\nK-1.2 Leverandøren skal levere støtte." });
  const rRegister = document({ id: "r-register", title: "Bilag 3", raw_text: "R-1.1 Leverandøren skal rapportere månedlig." });
  const canonical = canonicalizeRequirementSourceLedger({
    sourceDocuments: [customer, kRegister, rRegister],
    requirementLedgerResults: [
      {
        document: customer,
        // Rows other parsers read from the corrections chapter itself.
        ledger: [
          ledgerEntry({ id: "K-1.2", text: "i Bilag 1 utgår." }),
          ledgerEntry({ id: "K-1.3", text: "legges til i Bilag 1: «Leverandøren skal levere en exitplan.»" }),
        ],
      },
      {
        document: kRegister,
        ledger: [
          ledgerEntry({ id: "K-1.1", text: "Leverandøren skal levere drift." }),
          ledgerEntry({ id: "K-1.2", text: "Leverandøren skal levere støtte." }),
        ],
      },
      { document: rRegister, ledger: [ledgerEntry({ id: "R-1.1", text: "Leverandøren skal rapportere månedlig." })] },
    ],
  });
  assert.deepEqual(
    canonical.map((entry) => [entry.documentId, entry.id, entry.text]),
    [
      ["k-register", "K-1.1", "Leverandøren skal levere drift hele døgnet."],
      ["k-register", "K-1.3", "Leverandøren skal levere en exitplan."],
      ["r-register", "R-1.1", "Leverandøren skal rapportere ukentlig."],
    ],
  );
});

test("a new requirement joins the register numbering its series even when the chapter names another", () => {
  const customer = document({
    id: "customer",
    role: "primary_customer_document",
    supporting_subtype: null,
    title: "Konkurransegrunnlag",
    raw_text: [
      "9 Rettelser",
      "1. Krav R-1.1 i Bilag 3 endres og skal nå lyde: «Leverandøren skal rapportere ukentlig.»",
      "2. Nytt krav K-1.2 legges til: «Leverandøren skal levere en exitplan.»",
    ].join("\n"),
  });
  const kRegister = document({ id: "k-register", title: "Bilag 1", raw_text: "K-1.1 Leverandøren skal levere drift." });
  const rRegister = document({ id: "r-register", title: "Bilag 3", raw_text: "R-1.1 Leverandøren skal rapportere månedlig." });
  const canonical = canonicalizeRequirementSourceLedger({
    sourceDocuments: [customer, kRegister, rRegister],
    requirementLedgerResults: [
      { document: customer, ledger: [] },
      { document: kRegister, ledger: [ledgerEntry({ id: "K-1.1", text: "Leverandøren skal levere drift." })] },
      { document: rRegister, ledger: [ledgerEntry({ id: "R-1.1", text: "Leverandøren skal rapportere månedlig." })] },
    ],
  });
  assert.deepEqual(
    canonical.map((entry) => [entry.documentId, entry.id, entry.text]),
    [
      ["k-register", "K-1.1", "Leverandøren skal levere drift."],
      ["k-register", "K-1.2", "Leverandøren skal levere en exitplan."],
      ["r-register", "R-1.1", "Leverandøren skal rapportere ukentlig."],
    ],
  );
});

test("a correction addition follows its hierarchical register despite a larger other register, with separate provenance", () => {
  const customer = document({
    id: "customer",
    role: "primary_customer_document",
    supporting_subtype: null,
    title: "Konkurransegrunnlag",
    raw_text: [
      "9 Rettelser",
      "1. Krav K-1.1 i Bilag 1 endres og skal nå lyde: «Leverandøren skal levere drift hele døgnet.»",
      "2. Nytt krav K-2.3 legges til: «Leverandøren skal levere en exitplan.»",
    ].join("\n"),
  });
  const firstRows = [1, 2, 3, 4].map(number => ledgerEntry({ id: `K-1.${number}`, text: "Leverandøren skal levere drift.", pages: [1], heading: "1 Drift", documentId: "first", documentTitle: "Bilag 1" }));
  const first = document({ id: "first", title: "Bilag 1", raw_text: firstRows.map(row => `${row.id} ${row.text}`).join("\n") });
  const second = document({ id: "second", title: "Bilag 3", raw_text: "K-2.1 Leverandøren skal levere støtte.\nK-2.2 Leverandøren skal levere opplæring." });
  const canonical = canonicalizeRequirementSourceLedger({
    sourceDocuments: [customer, first, second],
    requirementLedgerResults: [
      { document: customer, ledger: [] },
      { document: first, ledger: firstRows },
      {
        document: second,
        ledger: [
          ledgerEntry({ id: "K-2.1", text: "Leverandøren skal levere støtte.", pages: [4], heading: "2 Støtte", documentId: "second", documentTitle: "Bilag 3" }),
          ledgerEntry({ id: "K-2.2", text: "Leverandøren skal levere opplæring.", pages: [5], heading: "2 Støtte", documentId: "second", documentTitle: "Bilag 3" }),
        ],
      },
    ],
  });
  const added = canonical.find((entry) => entry.id === "K-2.3");
  assert.deepEqual(
    [added.documentId, added.documentTitle, added.pages, added.heading, added.text],
    ["second", "Bilag 3", [], "2 Støtte", "Leverandøren skal levere en exitplan."],
  );
  assert.equal(added.correctionSource.documentId, "customer");
  assert.equal(added.correctionSource.documentTitle, "Konkurransegrunnlag");
  assert.deepEqual(added.correctionSource.pages, []);
  assert.match(added.sourceExcerpt, /Nytt krav i rettelse/u);
  assert.equal(canonical.find((entry) => entry.id === "K-1.1").text, "Leverandøren skal levere drift hele døgnet.");
});

test("a correction added inside a register follows numeric ID order without borrowing a source page", async () => {
  const customer = document({ id: "customer", role: "primary_customer_document", supporting_subtype: null, title: "Konkurransegrunnlag", raw_text: [
    "[[SIDE:9]]", "9 Rettelser",
    "1. Krav K-1.2 i Bilag 1 endres og skal nå lyde: «Leverandøren skal levere drift hele døgnet.»",
    "2. Nytt krav K-1.3 legges til i Bilag 1: «Leverandøren skal levere en exitplan.»",
  ].join("\n") });
  const formal = document({ id: "formal", title: "Bilag 1", raw_text: "K-1.2 Leverandøren skal levere drift.\nK-1.10 Leverandøren skal levere dokumentasjon.\nK-2.1 Leverandøren skal levere støtte." });
  const rows = canonicalizeRequirementSourceLedger({ sourceDocuments: [customer, formal], requirementLedgerResults: [
    { document: customer, ledger: [] },
    { document: formal, ledger: [
      ledgerEntry({ id: "K-1.2", pages: [1], heading: "1 Drift" }),
      ledgerEntry({ id: "K-1.10", pages: [2], heading: "1 Drift" }),
      ledgerEntry({ id: "K-2.1", pages: [4], heading: "2 Støtte" }),
    ] },
  ] });
  assert.deepEqual(rows.map(row => row.id), ["K-1.2", "K-1.3", "K-1.10", "K-2.1"]);
  const added = rows[1];
  assert.equal(added.heading, "1 Drift");
  assert.deepEqual(added.pages, []);
  assert.equal(added.documentId, formal.id);
  assert.equal(added.correctionSource.documentId, customer.id);
  assert.deepEqual(added.correctionSource.pages, [9]);
  const { requirementLedgerSource } = await jiti.import(path.join(frontendRoot, "lib/server/requirements/presentation.ts"));
  assert.match(requirementLedgerSource(added), /Konkurransegrunnlag, Side 9, Rettelse til Bilag 1/u);
  assert.doesNotMatch(requirementLedgerSource(added), /Side [124](?:,|$)/u);
});

function correctedRegisterRows(correction, registers) {
  const customer = document({ id: "correction-customer", role: "primary_customer_document", supporting_subtype: null, title: "Rettelser", raw_text: `9 Rettelser\n${correction}` });
  const formal = registers.map(({ id, title, file_name, ids }) => ({
    document: document({ id, title, ...(file_name ? { file_name } : {}), raw_text: ids.map(id => `${id} Leverandøren skal levere dokumentasjon.`).join("\n") }),
    ledger: ids.map(requirementId => ledgerEntry({ id: requirementId, documentId: id, text: "Leverandøren skal levere dokumentasjon." })),
  }));
  return canonicalizeRequirementSourceLedger({
    sourceDocuments: [customer, ...formal.map(result => result.document)],
    requirementLedgerResults: [{ document: customer, ledger: [] }, ...formal],
  });
}

test("an addition's explicit destination wins over its numeric parent and another correction clause", () => {
  const rows = correctedRegisterRows([
    "1. Krav K-2.1 i Bilag 1 endres og skal nå lyde: «Leverandøren skal levere rapporter ukentlig.»",
    "2. Nytt krav K-2.3 legges til i Bilag 3: «Leverandøren skal kontrollere henvisningen til Bilag 1.»",
  ].join("\n"), [
    { id: "first", title: "Bilag 1", ids: ["K-2.1", "K-2.2"] },
    { id: "third", title: "Bilag 3", ids: ["R-1.1"] },
  ]);
  assert.equal(rows.find(row => row.id === "K-2.3").documentId, "third");
  assert.equal(rows.find(row => row.id === "K-2.3").documentTitle, "Bilag 3");
  assert.equal(rows.find(row => row.id === "K-2.3").correctionSource.documentId, "correction-customer");
});

test("an explicit filename destination works without another requirement mention", () => {
  for (const target of ["Bilag 3", "Sikkerhetskrav.pdf"]) {
    const rows = correctedRegisterRows(`Nytt krav K-2.3 legges til i ${target}: «Leverandøren skal levere en exitplan.»`, [
      { id: "first", title: "Bilag 1", ids: ["K-2.1"] },
      { id: "target", title: "Sikkerhetskrav", file_name: target === "Bilag 3" ? "03_Bilag_3_Kravspesifikasjon.pdf" : "Sikkerhetskrav.pdf", ids: ["R-1.1"] },
    ]);
    assert.equal(rows.find(row => row.id === "K-2.3")?.documentId, "target", target);
  }
});

test("quoted destination titles and filenames retain precedence and unknown names fail", () => {
  const registers = [
    { id: "first", title: "Bilag 1", ids: ["K-2.1", "K-2.2"] },
    { id: "third", title: "Bilag 3 Sikkerhetskrav", file_name: "Sikkerhetskrav.pdf", ids: ["R-1.1"] },
  ];
  for (const [open, close] of [["«", "»"], ["“", "”"], ['"', '"']]) {
    for (const name of ["Bilag 3", "Bilag 3 Sikkerhetskrav", "Sikkerhetskrav.pdf"]) {
      for (const phrase of [`legges til i ${open}${name}${close}`, `i ${open}${name}${close} legges til`]) {
        const rows = correctedRegisterRows(`Nytt krav K-2.3 ${phrase}: «Leverandøren skal levere en exitplan.»`, registers);
        assert.equal(rows.find(row => row.id === "K-2.3")?.documentId, "third", phrase);
      }
    }
    for (const name of ["Bilag 9", "Ukjent dokument", "Ukjent.pdf"]) {
      assert.throws(() => correctedRegisterRows(`Nytt krav K-2.3 legges til i ${open}${name}${close}: «Leverandøren skal levere en exitplan.»`, registers), /K-2\.3.*entydig/u);
    }
  }
});

test("chapter, table and generic location references fall through to numeric ownership", () => {
  for (const phrase of ["legges til i tabell 2 etter K-2.2", "legges til i kapittel 2", "legges til i kravspesifikasjonen", "i punkt 2.2", "legges til i avsnitt 2"]) {
    const rows = correctedRegisterRows(`Nytt krav K-2.3 ${phrase}: «Leverandøren skal levere en exitplan.»`, [
      { id: "first", title: "Bilag 1", ids: ["K-2.1", "K-2.2"] },
      { id: "third", title: "Bilag 3", ids: ["R-1.1"] },
    ]);
    assert.equal(rows.find(row => row.id === "K-2.3")?.documentId, "first", phrase);
  }
});

test("quoted names remain opaque inside chapter locations and retain punctuation", () => {
  const registers = [
    { id: "first", title: "Bilag 1", ids: ["K-2.1", "K-2.2"] },
    { id: "third", title: "Bilag 3", file_name: "Sikkerhetskrav.pdf", ids: ["R-1.1"] },
    { id: "named", title: "Sikkerhet. Norge: Endelig", file_name: "Nye krav. Endelig.pdf", ids: ["S-1.1"] },
  ];
  for (const [phrase, expected] of [
    ["legges til i kapittel 4 i «Bilag 3»", "third"],
    ["legges til i dokumentet «Bilag 3»", "third"],
    ["legges til i tabell 2 i «Sikkerhetskrav.pdf»", "third"],
    ["legges til i «Sikkerhet. Norge: Endelig»", "named"],
    ['legges til i dokumentet "Nye krav. Endelig.pdf"', "named"],
  ]) {
    const rows = correctedRegisterRows(`Nytt krav K-2.3 ${phrase}: «Leverandøren skal levere en exitplan.»`, registers);
    assert.equal(rows.find(row => row.id === "K-2.3")?.documentId, expected, phrase);
  }
  for (const phrase of ["legges til i vedlegget «Ukjent»", "legges til i «Ukjent: x»", "legges til i Sikkerhetsdokumentet", "legges til i «Bilag 3» og Bilag 1"]) {
    assert.throws(() => correctedRegisterRows(`Nytt krav K-2.3 ${phrase}: «Leverandøren skal levere en exitplan.»`, registers), /K-2\.3.*entydig/u);
  }
});

test("destination resolution excludes wording without a colon and rejects every conflicting reference", () => {
  const registers = [
    { id: "first", title: "Bilag 1", file_name: "Driftskrav.pdf", ids: ["K-2.1", "K-2.2"] },
    { id: "third", title: "Bilag 3", file_name: "Sikkerhetskrav.pdf", ids: ["R-1.1"] },
  ];
  for (const phrase of [
    "legges til i Bilag 3 med ordlyden", "i Bilag 3 lyder", "legges til i Bilag 3",
    "legges til i Bilag 3, med følgende tekst", "legges til i Bilag 3 og skal lyde",
    "tilføyes i «Bilag 3» med teksten", "legges til i «Sikkerhetskrav.pdf» med følgende ordlyd",
  ]) {
    const rows = correctedRegisterRows(`Nytt krav K-2.3 ${phrase} «Leverandøren skal levere en exitplan.»`, registers);
    assert.equal(rows.find(row => row.id === "K-2.3")?.documentId, "third", phrase);
  }
  const wordingFirst = correctedRegisterRows("Nytt krav K-2.3 «Leverandøren skal levere en exitplan med kontroll av Bilag 1.» legges til i Bilag 3.", registers);
  assert.equal(wordingFirst.find(row => row.id === "K-2.3")?.documentId, "third");
  for (const phrase of [
    "legges til i «Bilag 3» og Driftskrav.pdf", "legges til i «Bilag 3» og Ukjent.pdf",
    "legges til i Bilag 3 og Driftskrav.pdf", "legges til i Bilag 3 og Ukjent.pdf",
    "legges til i «Bilag 3» og Sikkerhetsdokumentet", "legges til i kapittel 4 i Sikkerhetsdokumentet",
    "legges til i tabell 2 etter K-2.2 i Ukjent", "legges til i «Bilag 3» i Sikkerhetsdokumentet",
  ]) {
    assert.throws(() => correctedRegisterRows(`Nytt krav K-2.3 ${phrase}: «Leverandøren skal levere en exitplan.»`, registers), /K-2\.3.*entydig/u, phrase);
  }
});

test("document aliases, location qualifiers and wording forms compose without changing ownership", () => {
  const registers = [
    { id: "first", title: "Bilag 1", file_name: "Driftskrav.pdf", ids: ["K-2.1", "K-2.2"] },
    { id: "third", title: "Bilag 3", file_name: "Sikkerhetskrav Endelig.pdf", ids: ["R-1.1"] },
  ];
  for (const name of ["Bilag 3", "«Bilag 3»", "“Bilag 3”", '"Bilag 3"', "Sikkerhetskrav Endelig.pdf", "«Sikkerhetskrav Endelig.pdf»"]) {
    for (const prefix of ["", "kapittel 2 i ", "dokumentet "]) {
      for (const alias of ["", " og «Sikkerhetskrav Endelig.pdf»", " og Sikkerhetskrav Endelig.pdf"]) {
        for (const location of ["", " i kapittel 4", ", i kapittel 4", ", tabell 2", " tabell 3", ", etter K-2.2"]) {
          for (const wording of [": «Leverandøren skal levere en exitplan.»", " med ordlyden «Leverandøren skal levere en exitplan.»", " «Leverandøren skal levere en exitplan.»"]) {
            const correction = `Nytt krav K-2.3 legges til i ${prefix}${name}${alias}${location}${wording}`;
            let rows;
            assert.doesNotThrow(() => { rows = correctedRegisterRows(correction, registers); }, correction);
            const added = rows.filter(row => row.id === "K-2.3");
            assert.equal(added.length, 1, correction);
            assert.equal(added[0].documentId, "third", correction);
            assert.equal(added[0].text, "Leverandøren skal levere en exitplan.", correction);
          }
        }
      }
    }
  }
  for (const phrase of ["tabell 2 i kravspesifikasjonen", "kapittel 4 i kravspesifikasjonen", "tabell 2, etter K-2.2"]) {
    const rows = correctedRegisterRows(`Nytt krav K-2.3 legges til i ${phrase}: «Leverandøren skal levere en exitplan.»`, registers);
    assert.equal(rows.find(row => row.id === "K-2.3")?.documentId, "first", phrase);
  }
  for (const other of ["Sikkerhetsdokumentet", "Driftskrav", "Driftskrav.pdf", "Ukjent.pdf"]) {
    for (const names of [`${other} og «Bilag 3»`, `«Bilag 3» og ${other}`]) {
      assert.throws(() => correctedRegisterRows(`Nytt krav K-2.3 legges til i ${names}: «Leverandøren skal levere en exitplan.»`, registers), /K-2\.3.*entydig/u, names);
    }
  }
});

test("filename destinations retain their leading and trailing location qualifiers", () => {
  const registers = [
    { id: "first", title: "Bilag 1", file_name: "Driftskrav.pdf", ids: ["K-2.1", "K-2.2"] },
    { id: "third", title: "Sikkerhet", file_name: "Sikkerhetskrav.pdf", ids: ["R-1.1"] },
  ];
  for (const [name, owner] of [
    ["kapittel 2 i Driftskrav.pdf", "first"], ["tabell 2 i Sikkerhetskrav.pdf", "third"],
    ["dokumentet Driftskrav.pdf", "first"], ["vedlegget Sikkerhetskrav.pdf", "third"],
    ["Driftskrav.pdf, tabell 2", "first"], ["Sikkerhetskrav.pdf, kapittel 3", "third"],
    ["Driftskrav.pdf, etter K-2.2", "first"], ["Sikkerhetskrav.pdf tabell 3", "third"],
    ["«Driftskrav.pdf», tabell 2", "first"], ["tabell 2 i Driftskrav.pdf og «Bilag 1»", "first"],
  ]) {
    const rows = correctedRegisterRows(`Nytt krav K-2.3 legges til i ${name}: «Leverandøren skal levere en exitplan.»`, registers);
    assert.equal(rows.find(row => row.id === "K-2.3")?.documentId, owner, name);
  }
});

test("location cleanup preserves complete selected titles and never invents an unknown part title", () => {
  const registers = [
    { id: "descriptor", title: "Dokument Sikkerhet", ids: ["K-2.1"] },
    { id: "short", title: "Sikkerhet", ids: ["R-1.1"] },
    { id: "part", title: "Kravspesifikasjon del 2", ids: ["S-1.1"] },
    { id: "base", title: "Kravspesifikasjon", ids: ["T-1.1"] },
    { id: "number", title: "Dokument 5", ids: ["V-1.1"] },
  ];
  for (const [title, expected] of [["Dokument Sikkerhet", "descriptor"], ["Kravspesifikasjon del 2", "part"], ["Dokument 5", "number"]]) {
    for (const prefix of ["", "kapittel 4 i ", "dokumentet "]) {
      for (const suffix of ["", " i kapittel 4", ", tabell 2"]) {
        const correction = `Nytt krav K-2.3 legges til i ${prefix}${title}${suffix}: «Leverandøren skal levere en exitplan.»`;
        assert.equal(correctedRegisterRows(correction, registers).find(row => row.id === "K-2.3")?.documentId, expected, correction);
      }
    }
  }
  for (const name of ["Kravspesifikasjon del 3", "dokumentet Kravspesifikasjon del 3", "Kravspesifikasjon del 3 i kapittel 4"]) {
    assert.throws(() => correctedRegisterRows(`Nytt krav K-2.3 legges til i ${name}: «Leverandøren skal levere en exitplan.»`, registers), /K-2\.3.*entydig/u, name);
  }
});

test("competing descriptor and location interpretations preserve an exact title or reject ambiguity", () => {
  const registers = [
    { id: "qualified", title: "Sikkerhetskrav i kapittel 4", ids: ["K-2.1"] },
    { id: "short", title: "Sikkerhetskrav", ids: ["R-1.1"] },
  ];
  const rows = correctedRegisterRows("Nytt krav K-2.3 legges til i dokumentet Sikkerhetskrav i kapittel 4: «Leverandøren skal levere en exitplan.»", registers);
  assert.equal(rows.find(row => row.id === "K-2.3")?.documentId, "qualified");
  assert.throws(() => correctedRegisterRows("Nytt krav K-2.3 legges til i Dokument Sikkerhet i kapittel 4: «Leverandøren skal levere en exitplan.»", [
    { id: "descriptor", title: "Dokument Sikkerhet", ids: ["K-2.1"] },
    { id: "location", title: "Sikkerhet i kapittel 4", ids: ["R-1.1"] },
  ]), /K-2\.3.*entydig/u);
});

test("complete conjunction titles are resolved before their words become separate references", () => {
  for (const title of ["Drift og vedlikehold", "Drift samt Sikkerhet", "Drift pluss Sikkerhet"]) {
    const registers = [
      { id: "named", title, ids: ["K-2.1"] },
      { id: "other", title: "Bilag 3", ids: ["R-1.1"] },
    ];
    for (const destination of [title, `${title} i kapittel 4`, `kapittel 4 i ${title}`, `dokumentet ${title}`]) {
      const rows = correctedRegisterRows(`Nytt krav K-2.3 legges til i ${destination}: «Leverandøren skal levere en exitplan.»`, registers);
      assert.equal(rows.find(row => row.id === "K-2.3")?.documentId, "named", destination);
    }
    assert.throws(() => correctedRegisterRows(`Nytt krav K-2.3 legges til i ${title}: «Leverandøren skal levere en exitplan.»`, [
      ...registers, { id: "duplicate", title, ids: ["S-1.1"] },
    ]), /K-2\.3.*entydig/u);
  }
});

test("explicit requirement anchors can follow a plain title without weakening unknown-part checks", () => {
  const registers = [{ id: "named", title: "Sikkerhet", ids: ["K-2.1", "K-2.2"] }];
  for (const destination of ["Sikkerhet etter K-2.2", "Sikkerhet etter krav K-2.2", "dokumentet Sikkerhet etter K-2.2"]) {
    const rows = correctedRegisterRows(`Nytt krav K-2.3 legges til i ${destination}: «Leverandøren skal levere en exitplan.»`, registers);
    assert.equal(rows.find(row => row.id === "K-2.3")?.documentId, "named", destination);
  }
  assert.throws(() => correctedRegisterRows("Nytt krav K-2.3 legges til i Sikkerhet del 3: «Leverandøren skal levere en exitplan.»", registers), /K-2\.3.*entydig/u);
});

test("each addition in one correction paragraph keeps its own named register", () => {
  const rows = correctedRegisterRows("Krav K-2.1 i Bilag 1 endres og skal nå lyde: «Leverandøren skal levere rapporter.» Nytt krav K-2.3 legges til i Bilag 3: «Leverandøren skal levere en exitplan.» Nytt krav K-2.4 legges til i Bilag 1: «Leverandøren skal teste tilbakeføring.»", [
    { id: "first", title: "Bilag 1", ids: ["K-2.1", "K-2.2"] },
    { id: "third", title: "Bilag 3", ids: ["R-1.1"] },
  ]);
  assert.equal(rows.find(row => row.id === "K-2.3").documentId, "third");
  assert.equal(rows.find(row => row.id === "K-2.4").documentId, "first");
});

test("an unresolved addition cannot inherit the destination of an earlier addition", () => {
  const explicit = "Nytt krav K-2.3 legges til i Bilag 3: «Leverandøren skal levere en exitplan.»";
  const unresolved = "Nytt krav Q-9.1 legges til: «Leverandøren skal dokumentere tilbakeføring.»";
  const registers = [
    { id: "first", title: "Bilag 1", ids: ["K-2.1"] },
    { id: "third", title: "Bilag 3", ids: ["R-1.1"] },
  ];
  for (const correction of [unresolved, `${explicit}\n${unresolved}`, `${unresolved}\n${explicit}`]) {
    assert.throws(() => correctedRegisterRows(correction, registers), /Q-9\.1.*entydig/u);
  }
});

test("a shared numeric parent does not choose a register by row frequency", () => {
  assert.throws(() => correctedRegisterRows("Krav K-2.1 i Bilag 1 endres og skal nå lyde: «Leverandøren skal levere rapporter.» Nytt krav K-2.3 legges til: «Leverandøren skal levere en exitplan.»", [
    { id: "first", title: "Bilag 1", ids: ["K-2.1", "K-2.2"] },
    { id: "third", title: "Bilag 3", ids: ["K-2.5"] },
  ]), /K-2\.3.*entydig/u);
});

test("unknown or ambiguous explicit destinations fail instead of falling back to an ID parent", () => {
  for (const registers of [
    [{ id: "first", title: "Bilag 1", ids: ["K-2.1"] }],
    [{ id: "first", title: "Bilag 3", ids: ["K-2.1"] }, { id: "third", title: "Bilag 3", ids: ["R-1.1"] }],
  ]) {
    assert.throws(() => correctedRegisterRows("Krav K-2.1 endres og skal nå lyde: «Leverandøren skal levere rapporter.» Nytt krav K-2.3 legges til i Bilag 3: «Leverandøren skal levere en exitplan.»", registers), /K-2\.3.*entydig/u);
  }
  assert.throws(() => correctedRegisterRows("Nytt krav K-2.3 legges til i Bilag 1 og Bilag 3: «Leverandøren skal levere en exitplan.»", [
    { id: "first", title: "Bilag 1", ids: ["K-2.1"] },
    { id: "third", title: "Bilag 3", ids: ["R-1.1"] },
  ]), /K-2\.3.*entydig/u);
});

test("explicit destinations can precede the addition verb and use a complete document title", () => {
  for (const phrase of ["i Bilag 3 Sikkerhetskrav legges til", "legges til i Bilag 3 Sikkerhetskrav, jf Bilag 1"]) {
    const rows = correctedRegisterRows(`Nytt krav K-2.3 ${phrase}: «Leverandøren skal levere en exitplan.»`, [
      { id: "first", title: "Bilag 1", ids: ["K-2.1"] },
      { id: "wrong", title: "Bilag 3 Drift", ids: ["R-1.1"] },
      { id: "target", title: "Bilag 3 Sikkerhetskrav", ids: ["S-1.1"] },
    ]);
    assert.equal(rows.find(row => row.id === "K-2.3").documentId, "target", phrase);
  }
});

test("a document named only inside added wording is evidence, not an addition destination", () => {
  const rows = correctedRegisterRows("Krav R-1.1 i Bilag 3 endres og skal nå lyde: «Leverandøren skal levere rapporter.» Nytt krav K-2.3 legges til: «Leverandøren skal kontrollere Bilag 3 før oppstart.»", [
    { id: "first", title: "Bilag 1", ids: ["K-2.1"] },
    { id: "third", title: "Bilag 3", ids: ["R-1.1"] },
  ]);
  assert.equal(rows.find(row => row.id === "K-2.3").documentId, "first");
});

test("separating addition clauses preserves bidder-request scope and quoted wording", () => {
  const registers = [{ id: "first", title: "Bilag 1", ids: ["K-2.1"] }, { id: "third", title: "Bilag 3", ids: ["R-1.1"] }];
  const requested = correctedRegisterRows("Vi foreslår at K-2.1 endres. Nytt krav K-2.3 legges til i Bilag 3: «Leverandøren skal levere en exitplan.»", registers);
  assert.ok(requested.every(row => row.id !== "K-2.3"));
  const wording = "Leverandøren skal dokumentere at nytt krav R-9 legges til i Bilag 3 ved fremtidige endringer.";
  const added = correctedRegisterRows(`Nytt krav K-2.3 legges til i Bilag 1: «${wording}»`, registers);
  assert.equal(added.find(row => row.id === "K-2.3").text, wording);
  assert.equal(added.find(row => row.id === "K-2.3").documentId, "first");
  assert.ok(added.every(row => row.id !== "R-9"));
});

test("a correction to an ID two registers define changes neither, and Markdown definitions stay requirements", () => {
  const customer = document({
    id: "customer",
    role: "primary_customer_document",
    supporting_subtype: null,
    title: "Konkurransegrunnlag",
    raw_text: [
      "9 Rettelser",
      "1. Krav K-1.1 i Bilag 3 endres og skal nå lyde: «Leverandøren skal levere opplæring hver måned.»",
      "2. Krav K-1.2 i Bilag 1 endres og skal nå lyde: «Leverandøren skal levere støtte hele døgnet.»",
    ].join("\n"),
  });
  const first = document({ id: "first", title: "Bilag 1", raw_text: "K-1.1 Leverandøren skal levere drift.\nK-1.2 Leverandøren skal levere støtte." });
  const second = document({ id: "second", title: "Bilag 3", file_format: "md", raw_text: "## K-1.1 Leverandøren skal levere opplæring." });
  const canonical = canonicalizeRequirementSourceLedger({
    sourceDocuments: [customer, first, second],
    requirementLedgerResults: [
      { document: customer, ledger: [] },
      {
        document: first,
        ledger: [
          ledgerEntry({ id: "K-1.1", text: "Leverandøren skal levere drift." }),
          ledgerEntry({ id: "K-1.2", text: "Leverandøren skal levere støtte." }),
        ],
      },
      { document: second, ledger: [ledgerEntry({ id: "K-1.1", text: "Leverandøren skal levere opplæring." })] },
    ],
  });
  assert.deepEqual(
    canonical.map((entry) => [entry.documentId, entry.id, entry.text]),
    [
      ["first", "K-1.1", "Leverandøren skal levere drift."],
      ["first", "K-1.2", "Leverandøren skal levere støtte hele døgnet."],
      ["second", "K-1.1", "Leverandøren skal levere opplæring."],
    ],
  );
});
