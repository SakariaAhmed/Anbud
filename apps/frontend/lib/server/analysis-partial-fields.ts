import "server-only";

import type { CustomerAnalysisPartial, ProjectDocumentDetail, ProjectServiceDescription } from "@/lib/types";
import { isRecord } from "@/lib/unknown-values";
import { CUSTOMER_ANALYSIS_FIELD_DEFINITIONS, type CustomerAnalysisModelField } from "@/lib/server/document-intelligence/customer-analysis-fields";
import { normalizeCustomerAnalysisResult } from "@/lib/server/document-intelligence/customer-analysis-postprocess";
import { bindOutputSourceEvidence, outputEvidenceFields } from "@/lib/server/output-source-evidence";

/** The subset of JSON Schema used by the canonical analysis field contract. */
function matchesSchema(value: unknown, schema: Record<string, unknown>): boolean {
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes("null") && value === null) return true;
  if (types.includes("string")) {
    return typeof value === "string" && value.trim().length >= Number(schema.minLength ?? 0);
  }
  if (types.includes("integer")) {
    return typeof value === "number" && Number.isSafeInteger(value) &&
      value >= Number(schema.minimum ?? -Infinity) && value <= Number(schema.maximum ?? Infinity);
  }
  if (schema.type === "array") {
    const items = schema.items;
    return Array.isArray(value) && value.length >= Number(schema.minItems ?? 0) &&
      value.length <= Number(schema.maxItems ?? Infinity) && isRecord(items) &&
      value.every((item) => matchesSchema(item, items));
  }
  if (schema.type === "object") {
    if (!isRecord(value) || !isRecord(schema.properties) || !Array.isArray(schema.required)) return false;
    const properties = schema.properties;
    return schema.required.every((key) => typeof key === "string" && Object.hasOwn(value, key)) &&
      Object.entries(value).every(([key, item]) => isRecord(properties[key]) && matchesSchema(item, properties[key]));
  }
  return Array.isArray(schema.enum);
}

function normalizeSource(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

export function isAnalysisPartialFieldShape(key: string, value: unknown): boolean {
  return Object.hasOwn(CUSTOMER_ANALYSIS_FIELD_DEFINITIONS, key) &&
    matchesSchema(value, CUSTOMER_ANALYSIS_FIELD_DEFINITIONS[key as CustomerAnalysisModelField].schema);
}

export function validateAnalysisPartialField(input: {
  key: string;
  value: unknown;
  documents: ProjectDocumentDetail[];
  serviceCandidates?: ProjectServiceDescription[];
}): CustomerAnalysisPartial["fields"] {
  if (!Object.hasOwn(CUSTOMER_ANALYSIS_FIELD_DEFINITIONS, input.key)) throw new Error("Unknown analysis preview field.");
  const key = input.key as CustomerAnalysisModelField;
  if (!matchesSchema(input.value, CUSTOMER_ANALYSIS_FIELD_DEFINITIONS[key].schema)) throw new Error("Invalid analysis preview field shape.");
  if (key === "high_level_architecture_mermaid") {
    throw new Error("Diagram previews are withheld until their labels can be validated.");
  }
  if (key === "implicit_requirements") {
    for (const requirement of input.value as Array<{ source_reference: string; source_excerpt: string }>) {
      const reference = normalizeSource(requirement.source_reference).toLocaleLowerCase("nb");
      const members = input.documents.filter((document) => {
        const title = normalizeSource(document.title).toLocaleLowerCase("nb");
        const named = (title.length > 0 && reference.includes(title)) ||
          (document.id !== undefined && reference.split(/[\s,;:()[\]–—]+/u).includes(document.id.toLowerCase())) ||
          (document.role === "primary_customer_document" && /^kundedokument(?:\b|$)/u.test(reference));
        return named && normalizeSource(document.raw_text).includes(normalizeSource(requirement.source_excerpt));
      });
      if (members.length !== 1) {
        throw new Error("Analysis preview reference is outside the source snapshot.");
      }
    }
  }
  if (key === "recommended_services") {
    for (const service of input.value as Array<{ service_id: string | null; service_name: string }>) {
      const members = input.serviceCandidates?.filter((candidate) =>
        (service.service_id === null || service.service_id === candidate.id) &&
        normalizeSource(service.service_name) === normalizeSource(candidate.name));
      if (members?.length !== 1) {
        throw new Error("Analysis preview service is outside the candidate snapshot.");
      }
    }
  }
  const normalized = normalizeCustomerAnalysisResult({ [key]: input.value }, {
    generatedFields: [key],
    sourceDocuments: input.documents.map((document) => ({ title: document.title, rawText: document.raw_text, structureMap: document.structure_map })),
    serviceCandidates: input.serviceCandidates ?? [],
    signalSourceText: input.documents.map((document) => document.raw_text).join("\n\n"),
  });
  // Select only the received field; normalization defaults never become progress.
  if (!isAnalysisPartialFieldShape(key, normalized[key])) throw new Error("Invalid normalized analysis preview field.");
  const fields = outputEvidenceFields({ [key]: normalized[key] });
  // Source metadata is normally excluded from prose traversal. Here the model
  // supplied it, so validate its locator against the same row's actual excerpt.
  if (key === "implicit_requirements") {
    for (const [index, requirement] of normalized.implicit_requirements.entries()) {
      fields.push(
        { path: `result.implicit_requirements.${index}.reference`, text: requirement.source_reference },
        { path: `result.implicit_requirements.${index}.evidence`, text: requirement.source_excerpt },
      );
    }
  }
  bindOutputSourceEvidence({ fields, documents: input.documents.map(document => ({ document, sourceType: "project_document" })) });
  return { [key]: normalized[key] };
}
