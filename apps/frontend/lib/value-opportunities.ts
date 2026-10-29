import type { ValueOpportunity } from "@/lib/types";

// A manual list can allocate one whole percent to each of at most 100 entries.
// Older, longer lists are still displayed intact and may include zero shares.
export const MAX_MANUAL_VALUE_OPPORTUNITIES = 100;
export const MANUAL_VALUE_OPPORTUNITIES_ERROR =
  "Verdi må inneholde maksimalt 100 gyldige verdimuligheter med prosent mellom 0 og 100.";

export function isValidManualValueOpportunities(
  value: unknown,
): value is ValueOpportunity[] {
  return Array.isArray(value) &&
    value.length <= MAX_MANUAL_VALUE_OPPORTUNITIES &&
    value.every((item: unknown) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const entry = item as Record<string, unknown>;
      return typeof entry.title === "string" &&
        typeof entry.description === "string" &&
        Array.isArray(entry.value_categories) &&
        entry.value_categories.every((category) => typeof category === "string") &&
        typeof entry.profit_share_percent === "number" &&
        Number.isFinite(entry.profit_share_percent) &&
        entry.profit_share_percent >= 0 && entry.profit_share_percent <= 100;
    });
}

export function getDisplayProfitShares(opportunities: readonly ValueOpportunity[]): number[] {
  if (!opportunities.length) return [];
  const weights = opportunities.map(({ profit_share_percent: value }) =>
    Number.isFinite(value) && value > 0 ? value : 0,
  );
  const largest = weights.reduce((maximum, value) => Math.max(maximum, value), 0);
  // Scale before summing: old stored finite numbers can overflow their raw total.
  const scaled = weights.map((value) => largest > 0 ? value / largest : 1);
  const total = scaled.reduce((sum, value) => sum + value, 0);
  const quotas = scaled.map((value) => value / total * 100);
  const shares = quotas.map(Math.floor);
  const remainder = 100 - shares.reduce((sum, value) => sum + value, 0);
  const order = quotas.map((quota, index) => ({ index, fraction: quota - shares[index] }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  // Largest remainder allocation has a fixed bound; no convergence loop is needed.
  for (let index = 0; index < Math.min(remainder, order.length); index += 1) {
    shares[order[index].index] += 1;
  }
  return shares;
}
