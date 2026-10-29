import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export async function createExportFixture(root) {
  const env = JSON.parse(readFileSync(path.join(root, "output/speed-quality-2026-09-08/local-environment.json"), "utf8"));
  assert.equal(env.DATA_API_URL, "http://127.0.0.1:55440");
  const id = randomUUID();
  const artifactId = randomUUID();
  const timestamp = new Date().toISOString();
  const title = "Fiktiv gjennomføringsplan og risiko";
  const content = [
    "## Beslutning og ansvar",
    "Dette er en fiktiv eksportkontroll. Leverandøren beskriver planen, og kunden godkjenner hvert kontrollpunkt før neste fase. Æ, ø og å skal vises riktig.",
    ["| Krav | Leveranse og verifikasjon | Ansvar |",
      "| --- | --- | --- |",
      "| E-01 | Tilbakeføringsplan testes før produksjonssetting. | Leverandør |",
      "| E-02 | Kunden signerer testprotokollen. | Kunde |"].join("\n"),
    ...Array.from({ length: 6 }, (_, index) => [
      `## Fase ${index + 1}: gjennomføring og kvalitetssikring`,
      "Arbeidet planlegges sammen med applikasjonseiere og driftsansvarlige. Avhengigheter skal være dokumentert, ansvar fordelt og nødvendige tilganger kontrollert før endringen starter.",
      "- **Kontrollpunkt:** Utfør en dokumentert test med avtalte måleverdier.",
      "- **Risiko:** Manglende avklaring kan forsinke overgangen og krever en navngitt eier.",
      "- **Tiltak:** Registrer avviket med frist og verifiser rettingen før kunden godkjenner neste fase.",
      "Kundens godkjenning gjelder det dokumenterte testresultatet. Den innebærer ikke at åpne avvik eller avgrensninger automatisk er akseptert.",
    ].join("\n\n")),
    "## Avslutning",
    "Sluttkontroll: Alle seks faser, tabellen, ansvar og forbehold skal være med i eksporten.",
  ].join("\n\n");
  const created = [];
  async function request(origin, route, method, body) {
    const response = await fetch(`${origin}/${route}`, { method, headers: { authorization: `Bearer ${env.DATA_API_SERVICE_ROLE_KEY}`, "content-type": "application/json", prefer: "return=representation" }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.ok(response.ok, `Local export fixture ${method} failed (${response.status}).`);
    return response.json();
  }
  async function cleanup() {
    for (const origin of created) {
      await request(origin, `projects?id=eq.${id}`, "DELETE");
      assert.deepEqual(await request(origin, `projects?id=eq.${id}&select=id`, "GET"), []);
    }
  }
  try {
    for (const origin of ["http://127.0.0.1:55440", "http://127.0.0.1:55443"]) {
      await request(origin, "projects", "POST", { id, owner_id: env.APP_ADMIN_PRINCIPAL_ID, title, client_name: "Fiktiv eksportkunde", created_at: timestamp, updated_at: timestamp });
      created.push(origin);
      await request(origin, "generated_artifacts", "POST", { id: artifactId, project_id: id, artifact_type: "gjennomforing_og_risiko", title, content_markdown: content, artifact_version: 1, created_at: timestamp, updated_at: timestamp });
    }
    return { id, artifactId, title, content, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
