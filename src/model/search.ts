import type { Streamer } from "./streamers.ts";

/**
 * Ranks streamers for a query: exact uid, then uid prefix, then name prefix,
 * then name substring (case-insensitive). Empty query returns nothing.
 */
export function searchStreamers(list: readonly Streamer[], query: string, limit = 8): Streamer[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { s: Streamer; score: number; i: number }[] = [];
  list.forEach((s, i) => {
    const name = s.name.toLowerCase();
    let score = -1;
    if (s.uid === q) score = 0;
    else if (s.uid.startsWith(q)) score = 1;
    else if (name.startsWith(q)) score = 2;
    else if (name.includes(q)) score = 3;
    if (score >= 0) scored.push({ s, score, i });
  });
  scored.sort((a, b) => a.score - b.score || a.i - b.i);
  return scored.slice(0, limit).map((x) => x.s);
}
