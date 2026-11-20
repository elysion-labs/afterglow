/** Minimal path interface shared by THREE.Shape and canvas 2D (via `canvasPen`). */
export interface PathPen {
  moveTo(x: number, y: number): unknown;
  lineTo(x: number, y: number): unknown;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): unknown;
}

/**
 * Arched tombstone outline in y-up coordinates, origin at bottom centre.
 * `shoulder` is how far down from the apex the arch meets the straight sides.
 */
export function traceArch(pen: PathPen, width: number, height: number, shoulder: number): void {
  const hw = width / 2;
  const k = 0.5523; // cubic bezier approximation of a quarter ellipse
  const s = height - shoulder;
  pen.moveTo(-hw, 0);
  pen.lineTo(hw, 0);
  pen.lineTo(hw, s);
  pen.bezierCurveTo(hw, s + shoulder * k, hw * k, height, 0, height);
  pen.bezierCurveTo(-hw * k, height, -hw, s + shoulder * k, -hw, s);
  pen.lineTo(-hw, 0);
}

/** Adapts a canvas context to `PathPen`, mapping y-up arch space into pixel space. */
export function canvasPen(
  ctx: CanvasRenderingContext2D,
  map: (x: number, y: number) => [number, number],
): PathPen {
  return {
    moveTo: (x, y) => ctx.moveTo(...map(x, y)),
    lineTo: (x, y) => ctx.lineTo(...map(x, y)),
    bezierCurveTo: (a, b, c, d, x, y) => {
      const [p, q] = map(a, b);
      const [r, s] = map(c, d);
      const [u, v] = map(x, y);
      ctx.bezierCurveTo(p, q, r, s, u, v);
    },
  };
}
