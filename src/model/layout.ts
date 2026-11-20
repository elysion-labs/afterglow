/** Plot grid spacing in metres. Rows are deep enough for the focus camera to fit between them. */
export const PITCH_X = 3.2;
export const PITCH_Z = 4.2;

export interface Layout {
  positions: { x: number; z: number }[];
  /** Extents of the grave centres. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * Lays graves out on a centred grid, a bit wider than deep, filling the front
 * row (largest z, nearest the entrance camera) first. A partial last row is centred.
 */
export function layoutGrid(count: number): Layout {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count * 1.4)));
  const rows = Math.max(1, Math.ceil(count / columns));
  const positions: { x: number; z: number }[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / columns);
    const inRow = row === rows - 1 ? count - row * columns : columns;
    const col = i % columns;
    positions.push({
      x: (col - (inRow - 1) / 2) * PITCH_X,
      z: ((rows - 1) / 2 - row) * PITCH_Z,
    });
  }
  const xs = positions.map((p) => p.x);
  const zs = positions.map((p) => p.z);
  return {
    positions,
    minX: Math.min(0, ...xs),
    maxX: Math.max(0, ...xs),
    minZ: Math.min(0, ...zs),
    maxZ: Math.max(0, ...zs),
  };
}
