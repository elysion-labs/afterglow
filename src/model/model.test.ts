import { describe, expect, it, vi } from "vite-plus/test";
import { AISLE, COLUMNS, FILL_ORDER, PITCH_X, PITCH_Z, layoutCemetery } from "./layout.ts";
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

describe("layoutCemetery", () => {
  it("fills rows in list order from the entrance, outwards from the aisle", () => {
    const l = layoutCemetery(COLUMNS + 3);
    expect(l.rows).toBe(2);
    expect(l.positions.slice(0, COLUMNS).map((p) => p.col)).toEqual([...FILL_ORDER]);
    expect(l.positions[0]).toMatchObject({ row: 0, col: COLUMNS / 2 - 1, z: 0 });
    expect(l.positions[COLUMNS]).toMatchObject({ row: 1, col: COLUMNS / 2 - 1, z: -PITCH_Z });
  });

  it("places every grave on a unique cell", () => {
    const { positions } = layoutCemetery(101);
    const keys = new Set(positions.map((p) => `${p.row},${p.col}`));
    expect(keys.size).toBe(101);
  });

  it("never moves existing graves when entries are appended", () => {
    const before = layoutCemetery(13);
    const after = layoutCemetery(30);
    expect(after.positions.slice(0, 13)).toEqual(before.positions);
  });

  it("opens a central aisle and keeps the fence width fixed", () => {
    const small = layoutCemetery(1);
    const big = layoutCemetery(50);
    expect(small.fence.minX).toBe(big.fence.minX);
    expect(small.fence.maxX).toBe(-small.fence.minX);
    expect(big.fence.minZ).toBeLessThan(small.fence.minZ);
    const xs = [...new Set(big.positions.map((p) => p.x))].sort((a, b) => a - b);
    expect(xs).toHaveLength(COLUMNS);
    expect(xs[1]! - xs[0]!).toBeCloseTo(PITCH_X);
    const mid = COLUMNS / 2;
    expect(xs[mid]! - xs[mid - 1]!).toBeCloseTo(PITCH_X + AISLE);
  });

  it("handles an empty cemetery", () => {
    const l = layoutCemetery(0);
    expect(l.positions).toEqual([]);
    expect(l.rows).toBe(1);
    expect(l.fence.maxZ).toBeGreaterThan(l.fence.minZ);
  });
});

describe("FILL_ORDER", () => {
  it("is a permutation that alternates outwards from the aisle", () => {
    expect([...FILL_ORDER].sort((a, b) => a - b)).toEqual(
      Array.from({ length: COLUMNS }, (_, i) => i),
    );
    expect(FILL_ORDER.slice(0, 4)).toEqual([
      COLUMNS / 2 - 1,
      COLUMNS / 2,
      COLUMNS / 2 - 2,
      COLUMNS / 2 + 1,
    ]);
  });
});
