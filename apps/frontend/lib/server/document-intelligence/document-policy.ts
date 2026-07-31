import type { ProjectDocument } from "@/lib/types";

export function isHighImpactDocument(
  document: Pick<ProjectDocument, "role" | "supporting_subtype">,
) {
  return (
    document.role === "primary_customer_document" ||
    document.supporting_subtype === "kravdokument" ||
    document.supporting_subtype === "rfp"
  );
}
