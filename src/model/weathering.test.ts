import { describe, expect, it } from "vite-plus/test";
import { DAY_MS, createRng, hashString, weathering } from "./weathering.ts";

describe("weathering", () => {
  it("is pristine right after sweeping", () => {
    const w = weathering(0);
    expect(w.dust).toBe(0);
    expect(w.weeds).toBe(0);
    expect(w.moss).toBe(0);
    expect(w.flowers).toBe(1);
  });

  it("clamps negative elapsed time", () => {
    expect(weathering(-5 * DAY_MS)).toEqual(weathering(0));
  });

  it("grows monotonically with time", () => {
    let prev = weathering(0);
    for (let d = 1; d <= 400; d += 7) {
      const w = weathering(d * DAY_MS);
      expect(w.dust).toBeGreaterThanOrEqual(prev.dust);
      expect(w.weeds).toBeGreaterThanOrEqual(prev.weeds);
      expect(w.moss).toBeGreaterThanOrEqual(prev.moss);
      expect(w.flowers).toBeLessThanOrEqual(prev.flowers);
      prev = w;
    }
  });

  it("saturates after long neglect", () => {
    const w = weathering(365 * DAY_MS);
    expect(w.dust).toBeGreaterThan(0.99);
    expect(w.weeds).toBe(1);
    expect(w.moss).toBe(1);
    expect(w.flowers).toBe(0);
  });
});

describe("seeded randomness", () => {
  it("is deterministic per seed", () => {
    const a = createRng(hashString("streamer-a"));
    const b = createRng(hashString("streamer-a"));
    for (let i = 0; i < 10; i++) expect(a()).toBe(b());
  });

  it("differs between seeds and stays in [0, 1)", () => {
    const a = createRng(hashString("streamer-a"));
    const b = createRng(hashString("streamer-b"));
    const xs = Array.from({ length: 100 }, a);
    expect(xs).not.toEqual(Array.from({ length: 100 }, b));
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});
