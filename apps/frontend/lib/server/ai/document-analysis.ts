import "server-only";

import { createJsonCompletion, createTextCompletion } from "@/lib/server/ai/completion";
import { compactText } from "@/lib/server/ai/context";
import { FAST_MODEL, FAST_REASONING_EFFORT } from "@/lib/server/ai/model-config";
import {
  buildDelimitedContext,
  buildProjectMetadataPrompt,
  buildPromptTemplate,
} from "@/lib/server/prompts";
import type { ProjectMetadataInference } from "@/lib/types";

export async function summarizeServiceDocumentForAi(input: {
  title: string;
  fileName: string;
  rawText: string;
}) {
  return createTextCompletion({
    system: buildPromptTemplate({
      role: "Du lager korte, presise AI-sammendrag av tjenestebeskrivelser for tilbudsarbeid.",
      task: [
        "Oppsummer tjenestedokumentet slik at en senere AI raskt kan vurdere om tjenesten er relevant for et kundeprosjekt.",
      ],
      rules: [
        "Skriv på norsk.",
        "Maks 140 ord.",
        "Fokuser på leveranseområde, ansvar, driftsmodell, sikkerhet, SLA, avgrensninger, kundebidrag, verktøy og typiske krav tjenesten besvarer.",
        "Ikke skriv markedsføring eller generiske kvalitetsutsagn.",
      ],
      outputContract: ["Returner ren tekst, ikke JSON."],
      exampleOutput:
        "Tjenesten dekker <leveranseområde>, med ansvar for <ansvar>, typiske krav om <kravtyper> og avgrensninger rundt <avgrensning>.",
    }),
    user: [
      buildDelimitedContext(
        "Dokumentmetadata",
        [`Tittel: ${input.title}`, `Filnavn: ${input.fileName}`].join("\n"),
      ),
      buildDelimitedContext("Dokumenttekst", compactText(input.rawText, 10000)),
    ].join("\n\n"),
    temperature: 0.1,
    model: FAST_MODEL,
    reasoningEffort: FAST_REASONING_EFFORT,
  });
}

export async function inferProjectMetadataFromCustomerDocument(input: {
  fileName: string;
  title: string;
  rawText: string;
}): Promise<ProjectMetadataInference> {
  const userPrompt = [
    "Analyser dokumentet som Bilag 1 / primært kundedokument og returner kun gyldig JSON.",
    "Feltene skal være korte og direkte brukbare i prosjektoversikten.",
    buildDelimitedContext(
      "Dokumentmetadata",
      [`Tittel: ${input.title}`, `Filnavn: ${input.fileName}`].join("\n"),
    ),
    buildDelimitedContext("Dokumenttekst", compactText(input.rawText, 18000)),
  ].join("\n\n");

  const result = await createJsonCompletion<ProjectMetadataInference>({
    system: buildProjectMetadataPrompt(),
    user: userPrompt,
    temperature: 0.1,
    model: FAST_MODEL,
    reasoningEffort: FAST_REASONING_EFFORT,
    promptCacheKey: "project-metadata",
  });

  return {
    name:
      typeof result.name === "string" && result.name.trim()
        ? result.name.trim()
        : null,
    customer_name:
      typeof result.customer_name === "string" && result.customer_name.trim()
        ? result.customer_name.trim()
        : null,
    industry:
      typeof result.industry === "string" && result.industry.trim()
        ? result.industry.trim()
        : null,
    description:
      typeof result.description === "string" && result.description.trim()
        ? result.description.trim()
        : null,
  };
}
