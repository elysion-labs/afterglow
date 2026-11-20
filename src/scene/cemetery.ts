import {
  Box3,
  CanvasTexture,
  Group,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  type Ray,
  RepeatWrapping,
  SRGBColorSpace,
  Vector3,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  COLUMNS,
  PITCH_Z,
  PLOT_D,
  PLOT_W,
  type Rect,
  columnX,
  layoutCemetery,
  rowZ,
} from "../model/layout.ts";
import type { Streamer } from "../model/streamers.ts";
import { createRng } from "../model/weathering.ts";
import {
  GATE_HALF_WIDTH,
  buildAislePath,
  buildFence,
  buildGate,
  buildYearMarker,
} from "./enclosure.ts";
import { type TimeUniform, createLawn } from "./grass.ts";
import { GRAVE_HEIGHT, OUTLINE_LAYER, Tombstone } from "./tombstone.ts";
import { toonMaterial } from "./toon.ts";

/** Each grave sits in its own kerbed gravel plot. */
const PLOT = { w: PLOT_W, d: PLOT_D, kerb: 0.1, kerbH: 0.09, gap: 0.6, graveZ: -0.3 };
/** Half width of the stepping-stone path; no lawn grows there. */
const PATH_HALF = 0.6;

export class Cemetery {
  readonly group = new Group();
  /** Graves in layout order (by graduation date). */
  readonly graves: Tombstone[] = [];
  /** The fenced area; the gate stands at (0, bounds.maxZ). */
  readonly bounds: Rect;
  private readonly byUid = new Map<string, Tombstone>();
  private readonly boxes: Box3[] = [];

  constructor(input: readonly Streamer[], time: TimeUniform) {
    const layout = layoutCemetery(input);
    const streamers = layout.items;
    this.bounds = layout.fence;

    const kerbs = new InstancedMesh(
      kerbGeometry(),
      toonMaterial({ color: 0xa8a3b5 }),
      streamers.length,
    );
    kerbs.castShadow = true;
    kerbs.receiveShadow = true;
    kerbs.layers.enable(OUTLINE_LAYER);
    const gravelGeo = new PlaneGeometry(PLOT.w - PLOT.kerb * 2, PLOT.d - PLOT.kerb * 2);
    gravelGeo.rotateX(-Math.PI / 2);
    gravelGeo.translate(0, 0.004, 0);
    const gravel = new InstancedMesh(
      gravelGeo,
      toonMaterial({ map: gravelTexture() }),
      streamers.length,
    );
    gravel.receiveShadow = true;

    const m = new Matrix4();
    streamers.forEach((s, i) => {
      const p = layout.positions[i]!;
      m.makeTranslation(p.x, 0, p.z);
      kerbs.setMatrixAt(i, m);
      gravel.setMatrixAt(i, m);
      const grave = new Tombstone(s, new Vector3(p.x, 0, p.z + PLOT.graveZ), time);
      this.graves.push(grave);
      this.byUid.set(s.uid, grave);
      this.boxes.push(
        new Box3(
          new Vector3(p.x - PLOT.w / 2, 0, p.z - PLOT.d / 2),
          new Vector3(p.x + PLOT.w / 2, GRAVE_HEIGHT, p.z + PLOT.d / 2),
        ),
      );
      this.group.add(grave.group);
    });
    this.group.add(kerbs, gravel);

    // Enclosure: fence sized to the layout, gate at the front, a path down the
    // aisle and a signpost where each year's section begins.
    const fence = layout.fence;
    const pathEnd = layout.plots.minZ - PLOT.d / 2;
    this.group.add(buildFence(fence, GATE_HALF_WIDTH), buildAislePath(fence.maxZ, pathEnd));
    const gate = buildGate("毕业纪念园");
    gate.position.z = fence.maxZ;
    this.group.add(gate);
    const aisleEdge = columnX(COLUMNS / 2) - PLOT.w / 2;
    for (const section of layout.sections) {
      const marker = buildYearMarker(section.label);
      marker.position.set(-aisleEdge - 0.15, 0, rowZ(section.firstRow) + PLOT.d / 2 + 0.5);
      this.group.add(marker);
    }

    // Plots grouped by row so the lawn can skip them cheaply.
    const rows = new Map<number, number[]>();
    for (const p of layout.positions) rows.set(p.row, [...(rows.get(p.row) ?? []), p.x]);
    const margin = 12;
    this.group.add(
      createLawn(
        {
          minX: fence.minX - margin,
          maxX: fence.maxX + margin,
          minZ: fence.minZ - margin,
          maxZ: fence.maxZ + margin,
          exclude: (x, z) => {
            if (Math.abs(x) < PATH_HALF && z < fence.maxZ + 0.5 && z > pathEnd) return true;
            const row = Math.round(-z / PITCH_Z);
            if (Math.abs(z - rowZ(row)) > PLOT.d / 2) return false;
            return (rows.get(row) ?? []).some((px) => Math.abs(x - px) < PLOT.w / 2);
          },
        },
        time,
      ),
    );
  }

  get(uid: string): Tombstone | undefined {
    return this.byUid.get(uid);
  }

  /** Nearest plot hit by a world-space ray. */
  pick(ray: Ray): { grave: Tombstone; distance: number } | null {
    let best: { grave: Tombstone; distance: number } | null = null;
    const hit = new Vector3();
    this.boxes.forEach((box, i) => {
      if (!ray.intersectBox(box, hit)) return;
      const distance = hit.distanceTo(ray.origin);
      if (!best || distance < best.distance) best = { grave: this.graves[i]!, distance };
    });
    return best;
  }

  update(now: number): void {
    for (const g of this.graves) g.update(now);
  }
}

/** Low stone kerb around a plot, with an opening at the front. */
function kerbGeometry() {
  const { w, d, kerb, kerbH, gap } = PLOT;
  const piece = (pw: number, pd: number, x: number, z: number) => {
    const g = new RoundedBoxGeometry(pw, kerbH, pd, 2, 0.02);
    g.translate(x, kerbH / 2, z);
    return g;
  };
  const frontW = (w - gap) / 2;
  return mergeGeometries([
    piece(w, kerb, 0, -d / 2 + kerb / 2),
    piece(kerb, d - kerb * 2, -w / 2 + kerb / 2, 0),
    piece(kerb, d - kerb * 2, w / 2 - kerb / 2, 0),
    piece(frontW, kerb, -w / 2 + frontW / 2, d / 2 - kerb / 2),
    piece(frontW, kerb, w / 2 - frontW / 2, d / 2 - kerb / 2),
  ])!;
}

/** Hand-drawn looking pebbles with dark rims, anime background style. */
function gravelTexture(): CanvasTexture {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#b9ab9c";
  ctx.fillRect(0, 0, size, size);
  const rng = createRng(7);
  const tones = ["#d8cdbf", "#cbbfb2", "#e4dccf", "#b3a6a4", "#c9c2cf"];
  for (let i = 0; i < 300; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = 3 + rng() * 6;
    const ry = r * (0.6 + rng() * 0.3);
    const rot = rng() * Math.PI;
    ctx.fillStyle = tones[Math.floor(rng() * tones.length)]!;
    ctx.strokeStyle = "rgba(90,70,80,0.45)";
    ctx.lineWidth = 1.2;
    for (const [dx, dy] of [
      [0, 0],
      [size, 0],
      [-size, 0],
      [0, size],
      [0, -size],
    ] as const) {
      ctx.beginPath();
      ctx.ellipse(x + dx, y + dy, r, ry, rot, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(3, 3);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
