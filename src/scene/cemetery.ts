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
import { PITCH_Z, layoutGrid } from "../model/layout.ts";
import type { Streamer } from "../model/streamers.ts";
import { createRng } from "../model/weathering.ts";
import { type TimeUniform, createLawn } from "./grass.ts";
import { GRAVE_HEIGHT, OUTLINE_LAYER, Tombstone } from "./tombstone.ts";
import { toonMaterial } from "./toon.ts";

/** Each grave sits in its own kerbed gravel plot. */
const PLOT = { w: 2.5, d: 2.4, kerb: 0.1, kerbH: 0.09, gap: 0.6, graveZ: -0.3 };

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export class Cemetery {
  readonly group = new Group();
  readonly graves: Tombstone[] = [];
  /** Extents of all plots. */
  readonly bounds: Bounds;
  private readonly byUid = new Map<string, Tombstone>();
  private readonly boxes: Box3[] = [];

  constructor(streamers: readonly Streamer[], time: TimeUniform) {
    const layout = layoutGrid(streamers.length);
    this.bounds = {
      minX: layout.minX - PLOT.w / 2,
      maxX: layout.maxX + PLOT.w / 2,
      minZ: layout.minZ - PLOT.d / 2,
      maxZ: layout.maxZ + PLOT.d / 2,
    };

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

    // Plots grouped by row so the lawn can skip them cheaply.
    const rows = new Map<number, number[]>();
    const rowOf = (z: number) => Math.round((z - layout.minZ) / PITCH_Z);
    for (const p of layout.positions) {
      const key = rowOf(p.z);
      rows.set(key, [...(rows.get(key) ?? []), p.x]);
    }
    const margin = 10;
    this.group.add(
      createLawn(
        {
          minX: this.bounds.minX - margin,
          maxX: this.bounds.maxX + margin,
          minZ: this.bounds.minZ - margin,
          maxZ: this.bounds.maxZ + margin,
          exclude: (x, z) => {
            const key = rowOf(z);
            if (Math.abs(z - (layout.minZ + key * PITCH_Z)) > PLOT.d / 2) return false;
            return (rows.get(key) ?? []).some((px) => Math.abs(x - px) < PLOT.w / 2);
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
