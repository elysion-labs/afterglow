/**
 * Cemetery layout: graves are placed in the order of `streamers.json`, row by
 * row from the entrance (z = 0) towards the back (negative z). The column
 * count is fixed, so the fence width never changes, and entries appended to
 * the list never move existing graves.
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

export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface CemeteryLayout {
  /** `positions[i]` belongs to the i-th entry of the input list. */
  positions: { x: number; z: number; row: number; col: number }[];
  rows: number;
  /** Extents of the plot centres. */
  plots: Rect;
  /** Fence rectangle; the gate sits at (0, fence.maxZ). */
  fence: Rect;
}

/** X of a column centre; the two halves are pushed apart to open the aisle. */
export function columnX(col: number): number {
  const x = (col - (COLUMNS - 1) / 2) * PITCH_X;
  return x + (col < COLUMNS / 2 ? -AISLE / 2 : AISLE / 2);
}

/**
 * Order in which a row's columns are filled: alternating outwards from the
 * aisle (left, right, left, …), so a partial last row stays balanced.
 */
export const FILL_ORDER: readonly number[] = Array.from({ length: COLUMNS }, (_, i) => {
  const step = Math.floor(i / 2);
  return i % 2 === 0 ? COLUMNS / 2 - 1 - step : COLUMNS / 2 + step;
});

export function rowZ(row: number): number {
  return 0 - row * PITCH_Z; // avoids -0 for the front row
}

export function layoutCemetery(count: number): CemeteryLayout {
  const positions: CemeteryLayout["positions"] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / COLUMNS);
    const col = FILL_ORDER[i % COLUMNS]!;
    positions.push({ x: columnX(col), z: rowZ(row), row, col });
  }
  const rows = Math.max(1, Math.ceil(count / COLUMNS));
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
  return { positions, rows, plots, fence };
}
