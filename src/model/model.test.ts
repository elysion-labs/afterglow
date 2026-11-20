import { describe, expect, it, vi } from "vite-plus/test";
import { PITCH_X, PITCH_Z, layoutGrid } from "./layout.ts";
import { searchStreamers } from "./search.ts";
import { type Streamer, formatDate, normalizeStreamers } from "./streamers.ts";

const s = (uid: string, name: string): Streamer => ({
  uid,
  name,
  roomId: "1",
  debutAt: "2020-01-01",
  graduatedAt: "2021-01-01",
});

describe("searchStreamers", () => {
  const list = [
    s("123456", "柚子茶 Yuzu"),
    s("1234", "夜雨"),
    s("999", "Yuzuki"),
    s("555", "白鸮"),
  ];

  it("ranks exact uid, uid prefix, name prefix, then substring", () => {
    expect(searchStreamers(list, "1234").map((x) => x.uid)).toEqual(["1234", "123456"]);
    expect(searchStreamers(list, "yuzu").map((x) => x.uid)).toEqual(["999", "123456"]);
  });

  it("is case-insensitive and trims", () => {
    expect(searchStreamers(list, "  YUZUKI ").map((x) => x.uid)).toEqual(["999"]);
  });

  it("returns nothing for empty or unmatched queries", () => {
    expect(searchStreamers(list, "   ")).toEqual([]);
    expect(searchStreamers(list, "zzz")).toEqual([]);
  });

  it("respects the limit", () => {
    expect(searchStreamers(list, "1", 1)).toHaveLength(1);
  });
});

describe("normalizeStreamers", () => {
  it("coerces numbers, drops invalid and duplicate entries", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = normalizeStreamers([
      {
        uid: 42,
        name: "A",
        roomId: 7,
        debutAt: "2020-01-01",
        graduatedAt: "2021-01-01",
        color: "#ABCDEF",
      },
      { uid: "42", name: "dup" },
      { name: "no uid" },
      null,
      { uid: "9", name: "B", color: "red", face: "b.png" },
    ]);
    expect(out.map((x) => x.uid)).toEqual(["42", "9"]);
    expect(out[0]).toMatchObject({ roomId: "7", color: "#ABCDEF" });
    expect(out[1]!.color).toBeUndefined();
    expect(out[1]!.face).toBe("b.png");
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it("rejects non-arrays", () => {
    expect(() => normalizeStreamers({})).toThrow();
  });

  it("formats dates", () => {
    expect(formatDate("2025-08-31")).toBe("2025.08.31");
  });
});

describe("layoutGrid", () => {
  it("places every grave on a unique grid cell", () => {
    for (const n of [1, 2, 7, 40, 101]) {
      const { positions } = layoutGrid(n);
      expect(positions).toHaveLength(n);
      const keys = new Set(positions.map((p) => `${p.x.toFixed(3)},${p.z.toFixed(3)}`));
      expect(keys.size).toBe(n);
    }
  });

  it("uses the pitch and centres the grid", () => {
    const l = layoutGrid(40);
    expect(l.minX).toBeCloseTo(-l.maxX);
    expect(l.minZ).toBeCloseTo(-l.maxZ);
    const xs = [...new Set(l.positions.map((p) => p.x))].sort((a, b) => a - b);
    expect(xs[1]! - xs[0]!).toBeCloseTo(PITCH_X);
    const zs = [...new Set(l.positions.map((p) => p.z))].sort((a, b) => a - b);
    expect(zs[1]! - zs[0]!).toBeCloseTo(PITCH_Z);
  });

  it("fills the front row first", () => {
    const l = layoutGrid(10);
    expect(l.positions[0]!.z).toBe(l.maxZ);
  });
});
