import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { extractRequirementIdentifiers, extractExactRetrievalTerms } = createJiti(import.meta.url, { alias: { "@": new URL("../../..", import.meta.url).pathname, "server-only": "/dev/null" } })("./retrieval-query.ts");
test("standards stay in lexical retrieval without triggering missing requirement checks", () => {
  const question = "Støttes SAML2, OIDC1, CIS2, OWASP10, HTTPS2, ISO27001 og K-4.2?";
  assert.deepEqual(extractRequirementIdentifiers(question), ["K-4.2"]);
  const exact = extractExactRetrievalTerms(question);
  for (const term of ["SAML2", "OIDC1", "CIS2", "OWASP10", "HTTPS2", "ISO27001", "K-4.2"]) assert.ok(exact.includes(term), term);
});
