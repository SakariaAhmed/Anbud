/** One vote per result per query; duplicate rows never acquire extra votes. */
export function reciprocalRankFusion<T>(rankings: T[][], key: (item: T) => string, smoothing = 60): T[] {
  const votes = new Map<string, { item: T; score: number; first: number }>();
  for (const ranking of rankings) {
    const seen = new Set<string>();
    let rank = 0;
    for (const item of ranking) {
      const id = key(item);
      if (seen.has(id)) continue;
      seen.add(id);
      rank++;
      const current = votes.get(id);
      if (current) current.score += 1 / (smoothing + rank);
      else votes.set(id, { item, score: 1 / (smoothing + rank), first: votes.size });
    }
  }
  return [...votes.values()].sort((a, b) => b.score - a.score || a.first - b.first).map(row => row.item);
}
