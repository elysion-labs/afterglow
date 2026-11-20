/**
 * Weathering model: the only persisted state of a grave is `lastSweptAt`.
 * Everything visible (dust, moss, weeds, wilting flowers) is a pure function
 * of the elapsed time plus a per-streamer seed, so every visitor sees the
 * same grave without storing any per-pixel state on a server.
 */

export const DAY_MS = 86_400_000;

export interface Weathering {
  /** Days since the grave was last swept. */
  days: number;
  /** 0..1 dust coverage, fast: noticeable after a few days, saturated in ~a month. */
  dust: number;
  /** 0..1 weed growth, starts after a couple of days, fully overgrown in ~3 months. */
  weeds: number;
  /** 0..1 moss coverage, slow: needs months of neglect. */
  moss: number;
  /** 0..1 freshness of the flowers left by the last visitor (1 = fresh, 0 = gone). */
  flowers: number;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function weathering(elapsedMs: number): Weathering {
  const days = Math.max(0, elapsedMs / DAY_MS);
  return {
    days,
    dust: 1 - Math.exp(-days / 10),
    weeds: smoothstep(2, 90, days),
    moss: smoothstep(20, 300, days),
    flowers: 1 - smoothstep(1, 14, days),
  };
}

/** Deterministic 32-bit hash of a string (FNV-1a). */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Seeded PRNG (mulberry32), returns floats in [0, 1). */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
