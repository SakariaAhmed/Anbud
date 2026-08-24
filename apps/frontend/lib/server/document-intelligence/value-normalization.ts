import type { ValueCategory, ValueOpportunity } from "@/lib/types";
import {
  isNearDuplicate,
  splitIntoSentences,
} from "./text-normalization";

const VALUE_CATEGORIES: ValueCategory[] = [
  "Høyere produktivitet",
  "Lavere kostnader",
  "Redusert risiko",
  "Bedre brukeropplevelse",
];

export function normalizePercentShare(raw: unknown) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return null;
  }
  return Math.min(100, Math.max(1, Math.round(raw)));
}

function isValueCategory(value: unknown): value is ValueCategory {
  return (
    typeof value === "string" &&
    VALUE_CATEGORIES.includes(value as ValueCategory)
  );
}

function inferValueCategory(
  item: Pick<ValueOpportunity, "title" | "description">,
): ValueCategory {
  const text = `${item.title} ${item.description}`.toLowerCase();

  if (
    /risiko|sikkerhet|avbrudd|nedetid|kontroll|compliance|etterlevelse|robust|sårbar/.test(
      text,
    )
  ) {
    return "Redusert risiko";
  }

  if (
    /kost|kostnad|besparelse|økonomi|lisens|driftskost|finops|forbruk|reduser|reducer/.test(
      text,
    )
  ) {
    return "Lavere kostnader";
  }

  if (
    /bruker|opplevelse|selvbetjening|tilgjengelighet|adopsjon|respons|kundeopplevelse/.test(
      text,
    )
  ) {
    return "Bedre brukeropplevelse";
  }

  if (
    /produktiv|effektiv|automatis|arbeidsflyt|prosess|kapasitet|tidsbruk|standardiser/.test(
      text,
    )
  ) {
    return "Høyere produktivitet";
  }

  return "Redusert risiko";
}

function normalizeSingleValueCategory(item: ValueOpportunity): ValueCategory {
  const firstValidCategory = Array.isArray(item.value_categories)
    ? item.value_categories.find(isValueCategory)
    : null;

  return firstValidCategory ?? inferValueCategory(item);
}

function mergeValueOpportunityDescriptions(descriptions: string[]) {
  const mergedSentences: string[] = [];

  for (const description of descriptions) {
    const normalizedDescription = description.replace(/\s+/g, " ").trim();
    const sentences = splitIntoSentences(normalizedDescription);
    const candidates = sentences.length ? sentences : [normalizedDescription];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      if (
        mergedSentences.some((existing) =>
          isNearDuplicate(existing, candidate, 0.76),
        )
      ) {
        continue;
      }

      mergedSentences.push(candidate);
    }
  }

  return mergedSentences.join(" ").replace(/\s+/g, " ").trim();
}

export function normalizeValueOpportunities(
  items: ValueOpportunity[],
): ValueOpportunity[] {
  const normalizedItems = (Array.isArray(items) ? items : [])
    .filter((item) => item && item.title && item.description)
    .filter((item, index, array) => {
      return !array.some(
        (existing, existingIndex) =>
          existingIndex < index &&
          isNearDuplicate(existing.title, item.title, 0.8) &&
          isNearDuplicate(existing.description, item.description, 0.72),
      );
    })
    .map((item) => ({
      title: item.title.replace(/\s+/g, " ").trim(),
      description: item.description.replace(/\s+/g, " ").trim(),
      value_categories: [normalizeSingleValueCategory(item)],
      profit_share_percent:
        normalizePercentShare(
          (item as ValueOpportunity & { profit_share_percent?: unknown })
            .profit_share_percent,
        ) ?? 0,
    }));

  if (!normalizedItems.length) {
    return [];
  }

  const mergedByCategory = new Map<ValueCategory, ValueOpportunity>();

  for (const item of normalizedItems) {
    const category = item.value_categories[0];
    const existing = mergedByCategory.get(category);

    if (!existing) {
      mergedByCategory.set(category, item);
      continue;
    }

    mergedByCategory.set(category, {
      ...existing,
      description: mergeValueOpportunityDescriptions([
        existing.description,
        item.description,
      ]),
      value_categories: [category],
      profit_share_percent:
        existing.profit_share_percent + item.profit_share_percent,
    });
  }

  const filtered = VALUE_CATEGORIES.map((category) =>
    mergedByCategory.get(category),
  )
    .filter((item): item is ValueOpportunity => Boolean(item))
    .slice(0, 4);

  const providedTotal = filtered.reduce(
    (sum, item) => sum + (item.profit_share_percent || 0),
    0,
  );

  const normalizedPercents =
    providedTotal > 0
      ? filtered.map((item) =>
          Math.max(
            1,
            Math.round((item.profit_share_percent / providedTotal) * 100),
          ),
        )
      : filtered.map(() => Math.floor(100 / filtered.length));

  let currentTotal = normalizedPercents.reduce((sum, value) => sum + value, 0);
  let index = 0;
  while (currentTotal !== 100 && filtered.length > 0) {
    const direction = currentTotal < 100 ? 1 : -1;
    const targetIndex = index % filtered.length;
    if (direction > 0 || normalizedPercents[targetIndex] > 1) {
      normalizedPercents[targetIndex] += direction;
      currentTotal += direction;
    }
    index += 1;
  }

  return filtered.map((item, itemIndex) => ({
    ...item,
    profit_share_percent: normalizedPercents[itemIndex] || 1,
  }));
}
