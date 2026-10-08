import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = path.resolve(import.meta.dirname, "../../output/speed-quality-2026-09-08");
const source = readFileSync(path.join(dir, "generation-inputs.json"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const original = JSON.parse(source);
const timestamp = "2026-09-08T00:00:00.000Z";
const services = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Norsk sikkerhetskopiering og gjenoppretting", description: "Sikkerhetskopier lagres i Norge og beskyttes mot endring. Kvartalsvise gjenopprettingstester dokumenteres. Omfatter ikke døgnbemannet hendelseshåndtering. RTO og RPO må avtales for den enkelte applikasjonen.", keywords: ["backup", "gjenoppretting"], selected: false },
  { id: "22222222-2222-4222-8222-222222222222", name: "Døgnbemannet hendelseshåndtering", description: "Mottak, prioritering og koordinering av kritiske IT-hendelser hele døgnet, alle dager. Ansvarsgrenser og responstider avtales før oppstart. Tjenesten inkluderer ikke migrering, sikkerhetskopiering eller garantert gjenopprettingstid.", keywords: ["drift", "beredskap"], selected: true },
  { id: "33333333-3333-4333-8333-333333333333", name: "Lønn og reiseregninger", description: "Behandler lønnsutbetalinger, reiseregninger og refusjoner. Tilbyr ikke IT-drift, hendelseshåndtering, sikkerhetskopiering eller plattformmigrering.", keywords: ["lønn", "reiseregninger"], selected: false },
].map((service) => ({ ...service, inclusion_mode: "selected", recommended: false, recommendation_score: 0, recommendation_reason: "Ingen automatisk forhåndsanbefaling i denne kontrollen.", documents: [], created_at: timestamp, updated_at: timestamp }));
const cases = original.cases.filter((c) => ["development", "holdout"].includes(c.split)).map((fixture) => {
  assert.equal(sha(JSON.stringify(fixture.input)), fixture.inputSha256);
  const input = structuredClone(fixture.input);
  input.serviceCandidates = structuredClone(services);
  return { ...fixture, input, inputSha256: sha(JSON.stringify(input)) };
});
writeFileSync(path.join(dir, "generation-inputs-populated-services.json"), JSON.stringify({ at: new Date().toISOString(), originalFixtureSha256: sha(source), scope: "Paired direct section-services owner test with a nonempty fixed catalog. Only serviceCandidates differ from the original frozen development/holdout inputs. No project sources, prior outputs, stored catalog or holdout text are edited; this is not persisted catalog recommendation integration.", cases }, null, 2), { flag: "wx" });
assert.equal(sha(readFileSync(path.join(dir, "generation-inputs.json"))), sha(source));
console.log(JSON.stringify({ cases: cases.map(({ caseId, split, inputSha256 }) => ({ caseId, split, inputSha256 })), services: services.length, originalUnchanged: true }));
