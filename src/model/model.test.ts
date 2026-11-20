import { describe, expect, it, vi } from "vite-plus/test";
import {
  AISLE,
  COLUMNS,
  FILL_ORDER,
  PITCH_X,
  PITCH_Z,
  graduationTime,
  layoutCemetery,
} from "./layout.ts";
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

describe("graduation dates", () => {
  it("parses common formats and rejects garbage", () => {
    expect(graduationTime("2024-05-01")).toBe(Date.UTC(2024, 4, 1));
    expect(graduationTime("2024.5.1")).toBe(Date.UTC(2024, 4, 1));
    expect(graduationTime("2024/05")).toBe(Date.UTC(2024, 4, 1));
    expect(graduationTime("")).toBeNull();
    expect(graduationTime("2024-13-01")).toBeNull();
    expect(graduationTime("someday")).toBeNull();
  });
});

describe("layoutCemetery", () => {
  const g = (id: string, graduatedAt: string) => ({ id, graduatedAt });
  const year = (y: number, n: number) =>
    Array.from({ length: n }, (_, i) =>
      g(`${y}-${i}`, `${y}-${String((i % 12) + 1).padStart(2, "0")}-01`),
    );

  it("keeps the JSON order and starts a new row whenever the year changes", () => {
    const input = [...year(2025, 3), ...year(2023, COLUMNS + 2), ...year(2024, 1)];
    const l = layoutCemetery(input);
    expect(l.items.map((i) => i.id)).toEqual(input.map((i) => i.id));
    expect(l.sections.map((s) => [s.label, s.firstRow, s.rows, s.count])).toEqual([
      ["2025", 0, 1, 3],
      ["2023", 1, 2, COLUMNS + 2],
      ["2024", 3, 1, 1],
    ]);
    expect(l.rows).toBe(4);
    expect(l.positions[0]).toMatchObject({ row: 0, col: COLUMNS / 2 - 1, z: 0 });
    expect(l.positions[3]).toMatchObject({ row: 1, col: COLUMNS / 2 - 1, z: -PITCH_Z });
  });

  it("only groups consecutive entries of the same year", () => {
    const l = layoutCemetery([g("a", "2023-01"), g("b", "2024-01"), g("c", "2023-06")]);
    expect(l.sections.map((s) => s.label)).toEqual(["2023", "2024", "2023"]);
  });

  it("never moves existing graves when entries are appended", () => {
    const base = [...year(2023, 5), ...year(2024, 7)];
    const before = layoutCemetery(base);
    const after = layoutCemetery([...base, g("late", "2022-03-01"), ...year(2025, 2)]);
    expect(after.positions.slice(0, base.length)).toEqual(before.positions);
  });

  it("labels graves without a usable date", () => {
    const l = layoutCemetery([g("u", ""), ...year(2022, 1)]);
    expect(l.sections.map((s) => s.label)).toEqual(["未记录", "2022"]);
  });

  it("opens a central aisle and keeps the fence width fixed", () => {
    const small = layoutCemetery(year(2024, 1));
    const big = layoutCemetery(year(2024, 50));
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
    const l = layoutCemetery([]);
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
