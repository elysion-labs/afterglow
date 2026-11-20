/**
 * Cemetery layout: graves are placed in the order given (the order of
 * `streamers.json`), from the entrance (z = 0) towards the back (negative z).
 * Whenever the graduation year differs from the previous grave's, a new
 * section starts on a fresh row with its own year sign, so a chronologically
 * kept list reads as one section per year. The column count is fixed, so the
 * fence width never changes, and entries appended to the list never move
 * existing graves.
 */

export const COLUMNS = 8;
export const PITCH_X = 3.2;
/** Rows are deep enough for the focus camera to fit between them. */
export const PITCH_Z = 4.2;
/** Extra width of the central aisle that leads from the gate. */
export const AISLE = 1.6;
export const PLOT_W = 2.5;
export const PLOT_D = 2.4;
/** Space inside the fence around the plots, and the forecourt behind the gate. */
export const FENCE_MARGIN = 2.2;
export const FORECOURT = 5;

export interface Dated {
  graduatedAt: string;
}

export interface Section {
  /** "2024" or "未记录" for graves without a usable date. */
  label: string;
  year: number | null;
  firstRow: number;
  rows: number;
  count: number;
}

export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface CemeteryLayout<T> {
  /** Input items in their original order; `positions[i]` belongs to `items[i]`. */
  items: T[];
  positions: { x: number; z: number; row: number; col: number }[];
  sections: Section[];
  rows: number;
  /** Extents of the plot centres. */
  plots: Rect;
  /** Fence rectangle; the gate sits at (0, fence.maxZ). */
  fence: Rect;
}

/** Parses "YYYY-MM-DD", "YYYY-MM", "YYYY.MM.DD" or "YYYY/MM/DD"; null if unusable. */
export function graduationTime(date: string): number | null {
  const m = /^(\d{4})[-./](\d{1,2})(?:[-./](\d{1,2}))?$/.exec(date.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 1)];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return Date.UTC(y, mo - 1, d);
}

/** X of a column centre; the two halves are pushed apart to open the aisle. */
export function columnX(col: number): number {
  const x = (col - (COLUMNS - 1) / 2) * PITCH_X;
  return x + (col < COLUMNS / 2 ? -AISLE / 2 : AISLE / 2);
}

/**
 * Order in which a row's columns are filled: alternating outwards from the
 * aisle (left, right, left, …), so partial rows stay balanced on both sides.
 */
export const FILL_ORDER: readonly number[] = Array.from({ length: COLUMNS }, (_, i) => {
  const step = Math.floor(i / 2);
  return i % 2 === 0 ? COLUMNS / 2 - 1 - step : COLUMNS / 2 + step;
});

export function rowZ(row: number): number {
  return 0 - row * PITCH_Z; // avoids -0 for the front row
}

export function layoutCemetery<T extends Dated>(input: readonly T[]): CemeteryLayout<T> {
  const items = [...input];
  const positions: CemeteryLayout<T>["positions"] = [];
  const sections: Section[] = [];
  let row = 0;
  let current: Section | null = null;

  for (const item of items) {
    const t = graduationTime(item.graduatedAt);
    const year = t === null ? null : new Date(t).getUTCFullYear();
    if (!current || current.year !== year) {
      if (current) row += current.rows; // close previous section
      current = {
        label: year === null ? "未记录" : String(year),
        year,
        firstRow: row,
        rows: 0,
        count: 0,
      };
      sections.push(current);
    }
    const r = current.firstRow + Math.floor(current.count / COLUMNS);
    const col = FILL_ORDER[current.count % COLUMNS]!;
    positions.push({ x: columnX(col), z: rowZ(r), row: r, col });
    current.count++;
    current.rows = Math.ceil(current.count / COLUMNS);
  }

  const rows = Math.max(1, current ? current.firstRow + current.rows : 1);
  const plots: Rect = {
    minX: columnX(0),
    maxX: columnX(COLUMNS - 1),
    minZ: rowZ(rows - 1),
    maxZ: 0,
  };
  const fence: Rect = {
    minX: plots.minX - PLOT_W / 2 - FENCE_MARGIN,
    maxX: plots.maxX + PLOT_W / 2 + FENCE_MARGIN,
    minZ: plots.minZ - PLOT_D / 2 - FENCE_MARGIN,
    maxZ: plots.maxZ + PLOT_D / 2 + FORECOURT,
  };
  return { items, positions, sections, rows, plots, fence };
}
