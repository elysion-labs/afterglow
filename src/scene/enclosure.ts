import {
  BoxGeometry,
  type BufferGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  type Object3D,
  Quaternion,
  SphereGeometry,
  Vector3,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Rect } from "../model/layout.ts";
import { createRng } from "../model/weathering.ts";
import { OUTLINE_LAYER } from "./tombstone.ts";
import { toonMaterial } from "./toon.ts";

/** Entrance opening in the front balustrade, a little wider than the path. */
export const ENTRANCE_HALF_WIDTH = 1.4;

function finish<T extends Object3D>(o: T, outline = true): T {
  o.traverse((c) => {
    c.castShadow = true;
    c.receiveShadow = true;
    if (outline) c.layers.enable(OUTLINE_LAYER);
  });
  return o;
}

// ---------------------------------------------------------------------------
// Fence
// ---------------------------------------------------------------------------

/** Stone balustrade dimensions (m). */
const RAIL = {
  spacing: 2.4,
  post: 0.26,
  postH: 0.92,
  baseH: 0.14,
  baseD: 0.36,
  panelH: 0.46,
  panelD: 0.14,
  railH: 0.09,
  railD: 0.22,
};

/** The two posts flanking the entrance are a little bigger, marking the way in. */
const ENTRANCE_POST_SCALE = new Vector3(1.45, 1.3, 1.45);

/**
 * Chinese-style stone balustrade around `rect`, open at the front centre for
 * the entrance: square posts topped with stone balls, solid panels between
 * them, a plinth course below and a handrail on top.
 */
export function buildFence(rect: Rect, entranceHalf: number): Group {
  const group = new Group();
  const r = RAIL;

  const shaft = new RoundedBoxGeometry(r.post, r.postH, r.post, 2, 0.025);
  shaft.translate(0, r.postH / 2, 0);
  const capSlab = new RoundedBoxGeometry(r.post + 0.08, 0.08, r.post + 0.08, 2, 0.02);
  capSlab.translate(0, r.postH + 0.04, 0);
  const ball = new SphereGeometry(0.1, 12, 8);
  ball.translate(0, r.postH + 0.17, 0);
  // RoundedBoxGeometry is already non-indexed; only the sphere needs converting.
  const postGeo = mergeGeometries([shaft, capSlab, ball.toNonIndexed()])!;
  // Unit-length pieces, stretched along x per segment.
  const unitBox = (h: number, d: number, y: number) => {
    const g = new BoxGeometry(1, h, d);
    g.translate(0, y, 0);
    return g;
  };
  const baseGeo = unitBox(r.baseH, r.baseD, r.baseH / 2);
  const panelGeo = unitBox(r.panelH, r.panelD, r.baseH + r.panelH / 2);
  const railGeo = unitBox(r.railH, r.railD, r.baseH + r.panelH + r.railH / 2);

  const { minX, maxX, minZ, maxZ } = rect;
  const runs: [Vector3, Vector3][] = [
    [new Vector3(minX, 0, maxZ), new Vector3(-entranceHalf, 0, maxZ)],
    [new Vector3(entranceHalf, 0, maxZ), new Vector3(maxX, 0, maxZ)],
    [new Vector3(maxX, 0, maxZ), new Vector3(maxX, 0, minZ)],
    [new Vector3(maxX, 0, minZ), new Vector3(minX, 0, minZ)],
    [new Vector3(minX, 0, minZ), new Vector3(minX, 0, maxZ)],
  ];

  const posts: Matrix4[] = [];
  const spans: Matrix4[] = [];
  const up = new Vector3(0, 1, 0);
  const seen = new Set<string>();
  for (const [a, b] of runs) {
    const len = a.distanceTo(b);
    if (len < 0.05) continue;
    const dir = b.clone().sub(a).normalize();
    const q = new Quaternion().setFromAxisAngle(up, Math.atan2(-dir.z, dir.x));
    const n = Math.max(1, Math.ceil(len / r.spacing));
    for (let i = 0; i <= n; i++) {
      const p = a.clone().lerp(b, i / n);
      const key = `${p.x.toFixed(2)},${p.z.toFixed(2)}`;
      if (!seen.has(key)) {
        seen.add(key);
        const atEntrance = p.z === maxZ && Math.abs(Math.abs(p.x) - entranceHalf) < 0.01;
        posts.push(
          new Matrix4().compose(p, q, atEntrance ? ENTRANCE_POST_SCALE : new Vector3(1, 1, 1)),
        );
      }
      if (i === n) break;
      const p2 = a.clone().lerp(b, (i + 1) / n);
      // Spans run between the post faces.
      const span = p.distanceTo(p2) - r.post;
      const mid = p.clone().add(p2).multiplyScalar(0.5);
      spans.push(new Matrix4().compose(mid, q, new Vector3(span, 1, 1)));
    }
  }

  const instanced = (geo: BufferGeometry, color: number, mats: Matrix4[]) => {
    const im = new InstancedMesh(geo, toonMaterial({ color }), mats.length);
    mats.forEach((m, i) => im.setMatrixAt(i, m));
    return im;
  };
  group.add(
    instanced(postGeo, 0xc6c2cf, posts),
    instanced(baseGeo, 0x9893a8, spans),
    instanced(panelGeo, 0xb0abbd, spans),
    instanced(railGeo, 0xc6c2cf, spans),
  );
  return finish(group);
}

// ---------------------------------------------------------------------------
// Aisle
// ---------------------------------------------------------------------------

const PATH = { half: 0.65, kerb: 0.13, kerbH: 0.12, gap: 0.035 };
/** Half width of the paved path including its kerbs; no lawn grows inside. */
export const PATH_HALF_WIDTH = PATH.half + PATH.kerb;

/**
 * Flagstone path from z0 (outside the entrance) to z1 (the back row):
 * staggered courses of one or two grey slabs on a dark grout bed, with a
 * kerb of short stone blocks along each side.
 */
export function buildAislePath(z0: number, z1: number): Group {
  const g = new Group();
  const rng = createRng(11);
  const width = PATH.half * 2;

  const bed = new Mesh(new BoxGeometry(width, 0.03, z0 - z1), toonMaterial({ color: 0x77738a }));
  bed.position.set(0, 0.015, (z0 + z1) / 2);
  bed.receiveShadow = true;

  const slabGeo = new BoxGeometry(1, 0.06, 1);
  slabGeo.translate(0, 0.03, 0);
  const tones = [0xd3cfda, 0xc4bfce, 0xdcd8e0, 0xb9b4c4].map((c) => new Color(c));
  const slabs: { m: Matrix4; c: Color }[] = [];
  const noRotation = new Quaternion();
  for (let z = z0; z - z1 > 0.15;) {
    const depth = Math.min(0.38 + rng() * 0.22, z - z1);
    const zc = z - depth / 2;
    // Most courses are split in two at a random point, so joints never line up.
    const split = rng() < 0.75 ? -PATH.half + width * (0.3 + rng() * 0.4) : PATH.half;
    const parts =
      split < PATH.half
        ? [
            [-PATH.half, split],
            [split, PATH.half],
          ]
        : [[-PATH.half, PATH.half]];
    for (const [x0, x1] of parts as [number, number][]) {
      slabs.push({
        m: new Matrix4().compose(
          new Vector3((x0 + x1) / 2, 0.01, zc),
          noRotation,
          new Vector3(x1 - x0 - PATH.gap, 1, depth - PATH.gap),
        ),
        c: tones[Math.floor(rng() * tones.length)]!,
      });
    }
    z -= depth;
  }
  const slabMesh = new InstancedMesh(slabGeo, toonMaterial({ color: 0xffffff }), slabs.length);
  slabs.forEach(({ m, c }, i) => {
    slabMesh.setMatrixAt(i, m);
    slabMesh.setColorAt(i, c);
  });
  slabMesh.receiveShadow = true;

  const kerbGeo = new BoxGeometry(PATH.kerb, PATH.kerbH, 1);
  kerbGeo.translate(0, PATH.kerbH / 2, 0);
  const kerbs: Matrix4[] = [];
  const blockLen = 0.9;
  for (const side of [-1, 1]) {
    for (let z = z0; z - z1 > 0.1; z -= blockLen) {
      const len = Math.min(blockLen, z - z1) - 0.03;
      kerbs.push(
        new Matrix4().compose(
          new Vector3(side * (PATH.half + PATH.kerb / 2), 0, z - len / 2),
          noRotation,
          new Vector3(1, 1, len),
        ),
      );
    }
  }
  const kerbMesh = new InstancedMesh(kerbGeo, toonMaterial({ color: 0xa09bb0 }), kerbs.length);
  kerbs.forEach((m, i) => kerbMesh.setMatrixAt(i, m));
  kerbMesh.castShadow = true;
  kerbMesh.receiveShadow = true;
  kerbMesh.layers.enable(OUTLINE_LAYER);

  g.add(bed, slabMesh, kerbMesh);
  return g;
}
