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
  isLikelyRequirementSourceDocument,
} = await jiti.import(
  path.join(
    frontendRoot,
    "lib/server/use-cases/solution-evaluation-readiness.ts",
  ),
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

  assert.equal(isLikelyRequirementSourceDocument(rfp), true);
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
  assert.equal(isLikelyRequirementSourceDocument(response), false);
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
    assert.equal(isLikelyRequirementSourceDocument(response), false);
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

  assert.equal(isLikelyRequirementSourceDocument(historicalSolution), false);
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
