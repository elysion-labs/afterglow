import {
  BoxGeometry,
  type BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  type Object3D,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Shape,
  SphereGeometry,
  Vector3,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Rect } from "../model/layout.ts";
import { createRng } from "../model/weathering.ts";
import { OUTLINE_LAYER } from "./tombstone.ts";
import { toonMaterial } from "./toon.ts";

const SERIF = `"Noto Serif SC","Source Han Serif SC","Songti SC","STSong","SimSun",serif`;

/** Main opening of the gate; the fence stops at the outer side pillars. */
const GATE = { mainHalf: 1.9, sideX: 3.3, mainH: 3.6, sideH: 2.7 };
export const GATE_HALF_WIDTH = GATE.sideX + 0.25;

function finish<T extends Object3D>(o: T, outline = true): T {
  o.traverse((c) => {
    c.castShadow = true;
    c.receiveShadow = true;
    if (outline) c.layers.enable(OUTLINE_LAYER);
  });
  return o;
}

function signTexture(
  text: string,
  w: number,
  h: number,
  style: { bg: string; fg: string; border: string; font: string },
): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = style.bg;
  ctx.fillRect(0, 0, w, h);
  const b = h * 0.07;
  ctx.strokeStyle = style.border;
  ctx.lineWidth = b * 0.6;
  ctx.strokeRect(b, b, w - b * 2, h - b * 2);
  ctx.lineWidth = b * 0.25;
  ctx.strokeRect(b * 2, b * 2, w - b * 4, h - b * 4);
  ctx.fillStyle = style.fg;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  let size = h * 0.55;
  ctx.font = `700 ${size}px ${style.font}`;
  while (size > 8 && ctx.measureText(text).width > w * 0.82) {
    size -= 2;
    ctx.font = `700 ${size}px ${style.font}`;
  }
  ctx.fillText(text, w / 2, h / 2 + size * 0.04);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** A two-sided sign: a box with the texture on front and back faces. */
function signBoard(w: number, h: number, d: number, frame: Material, face: Material): Group {
  const g = new Group();
  g.add(new Mesh(new BoxGeometry(w, h, d), frame));
  for (const side of [1, -1]) {
    const p = new Mesh(new PlaneGeometry(w * 0.94, h * 0.9), face);
    p.position.z = (side * d) / 2 + side * 0.002;
    if (side < 0) p.rotation.y = Math.PI;
    g.add(p);
  }
  return g;
}

// ---------------------------------------------------------------------------
// Fence
// ---------------------------------------------------------------------------

/** Cream wooden picket fence around `rect`, open at the front centre for the gate. */
export function buildFence(rect: Rect, gateHalf: number): Group {
  const group = new Group();
  const wood = toonMaterial({ color: 0xf3e6cf });
  const postSpacing = 2.4;
  const picketSpacing = 0.22;

  const picketShape = new Shape();
  picketShape.moveTo(-0.035, 0);
  picketShape.lineTo(0.035, 0);
  picketShape.lineTo(0.035, 0.62);
  picketShape.lineTo(0, 0.7);
  picketShape.lineTo(-0.035, 0.62);
  const picketGeo = new ExtrudeGeometry(picketShape, { depth: 0.022, bevelEnabled: false });
  picketGeo.translate(0, 0, -0.011);

  const post = new BoxGeometry(0.1, 0.82, 0.1);
  post.translate(0, 0.41, 0);
  const cap = new ConeGeometry(0.085, 0.09, 4);
  cap.rotateY(Math.PI / 4);
  cap.translate(0, 0.865, 0);
  const postGeo = mergeGeometries([post.toNonIndexed(), cap.toNonIndexed()])!;
  const railGeo = new BoxGeometry(1, 0.05, 0.025);

  const { minX, maxX, minZ, maxZ } = rect;
  const runs: [Vector3, Vector3][] = [
    [new Vector3(minX, 0, maxZ), new Vector3(-gateHalf, 0, maxZ)],
    [new Vector3(gateHalf, 0, maxZ), new Vector3(maxX, 0, maxZ)],
    [new Vector3(maxX, 0, maxZ), new Vector3(maxX, 0, minZ)],
    [new Vector3(maxX, 0, minZ), new Vector3(minX, 0, minZ)],
    [new Vector3(minX, 0, minZ), new Vector3(minX, 0, maxZ)],
  ];

  const posts: Vector3[] = [];
  const pickets: Matrix4[] = [];
  const rails: Matrix4[] = [];
  const up = new Vector3(0, 1, 0);
  const seen = new Set<string>();
  for (const [a, b] of runs) {
    const len = a.distanceTo(b);
    if (len < 0.05) continue;
    const dir = b.clone().sub(a).normalize();
    const q = new Quaternion().setFromAxisAngle(up, Math.atan2(-dir.z, dir.x));
    const n = Math.max(1, Math.ceil(len / postSpacing));
    for (let i = 0; i <= n; i++) {
      const p = a.clone().lerp(b, i / n);
      const key = `${p.x.toFixed(2)},${p.z.toFixed(2)}`;
      if (!seen.has(key)) {
        seen.add(key);
        posts.push(p);
      }
      if (i === n) break;
      const p2 = a.clone().lerp(b, (i + 1) / n);
      const segLen = p.distanceTo(p2);
      const mid = p.clone().add(p2).multiplyScalar(0.5);
      for (const y of [0.22, 0.55]) {
        rails.push(new Matrix4().compose(mid.clone().setY(y), q, new Vector3(segLen, 1, 1)));
      }
      const count = Math.floor(segLen / picketSpacing);
      for (let k = 1; k < count; k++) {
        const pos = p.clone().lerp(p2, k / count);
        pickets.push(new Matrix4().compose(pos, q, new Vector3(1, 1, 1)));
      }
    }
  }

  const instanced = (geo: BufferGeometry, mats: Matrix4[]) => {
    const im = new InstancedMesh(geo, wood, mats.length);
    mats.forEach((m, i) => im.setMatrixAt(i, m));
    return im;
  };
  group.add(
    instanced(
      postGeo,
      posts.map((p) => new Matrix4().makeTranslation(p.x, 0, p.z)),
    ),
    instanced(picketGeo, pickets),
    instanced(railGeo, rails),
  );
  return finish(group);
}

// ---------------------------------------------------------------------------
// Gate (paifang)
// ---------------------------------------------------------------------------

/** Curved tiled roof with upturned eaves; the ridge runs along x. */
function roofGeometry(width: number, depth: number, height: number): BufferGeometry {
  const d = depth / 2;
  const s = new Shape();
  s.moveTo(-d, 0.12);
  s.quadraticCurveTo(-d * 0.35, -0.02, 0, height);
  s.quadraticCurveTo(d * 0.35, -0.02, d, 0.12);
  s.lineTo(d - 0.05, 0.02);
  s.quadraticCurveTo(d * 0.3, -0.12, 0, height - 0.16);
  s.quadraticCurveTo(-d * 0.3, -0.12, -d + 0.05, 0.02);
  const geo = new ExtrudeGeometry(s, {
    depth: width,
    bevelEnabled: true,
    bevelThickness: 0.03,
    bevelSize: 0.03,
    bevelSegments: 2,
    curveSegments: 12,
  });
  geo.translate(0, 0, -width / 2);
  geo.rotateY(Math.PI / 2);
  return geo;
}

function roof(
  width: number,
  depth: number,
  height: number,
  tile: Material,
  ridge: Material,
): Group {
  const g = new Group();
  g.add(new Mesh(roofGeometry(width, depth, height), tile));
  const ridgeBox = new Mesh(new BoxGeometry(width * 0.92, 0.12, 0.14), ridge);
  ridgeBox.position.y = height + 0.02;
  g.add(ridgeBox);
  // Curled ridge ends and upturned eave corners.
  const curl = new ConeGeometry(0.07, 0.3, 6);
  for (const sx of [-1, 1]) {
    const end = new Mesh(curl, ridge);
    end.position.set((sx * width * 0.92) / 2, height + 0.16, 0);
    end.rotation.z = -sx * 0.5;
    g.add(end);
    for (const sz of [-1, 1]) {
      const tip = new Mesh(curl, ridge);
      tip.scale.set(0.45, 0.6, 0.45);
      tip.position.set((sx * width) / 2, 0.17, (sz * depth) / 2);
      tip.rotation.set(sz * 0.35, 0, -sx * 0.35);
      g.add(tip);
    }
  }
  return g;
}

/** A three-bay paifang with a name plaque and two lanterns, facing +z. */
export function buildGate(title: string): Group {
  const g = new Group();
  const lacquer = toonMaterial({ color: 0xc9463d });
  const stone = toonMaterial({ color: 0x9d9db2 });
  const beam = toonMaterial({ color: 0x3f7491 });
  const trim = toonMaterial({ color: 0xe0b45a });
  const tile = toonMaterial({ color: 0x3f4466 });
  const ridge = toonMaterial({ color: 0x2c2f4d });

  const pillar = (x: number, h: number, r: number) => {
    const p = new Mesh(new CylinderGeometry(r, r * 1.08, h, 16), lacquer);
    p.position.set(x, h / 2, 0);
    const base = new Mesh(new RoundedBoxGeometry(r * 3.6, 0.42, r * 3.6, 2, 0.04), stone);
    base.position.set(x, 0.21, 0);
    g.add(p, base);
  };
  const bar = (x0: number, x1: number, y: number, h: number, d: number, m: Material) => {
    const b = new Mesh(new BoxGeometry(Math.abs(x1 - x0), h, d), m);
    b.position.set((x0 + x1) / 2, y, 0);
    g.add(b);
    return b;
  };

  const { mainHalf, sideX, mainH, sideH } = GATE;
  for (const sx of [-1, 1]) {
    pillar(sx * mainHalf, mainH, 0.16);
    pillar(sx * sideX, sideH, 0.12);
    // Side bay beam and roof.
    bar(sx * mainHalf, sx * sideX, sideH - 0.3, 0.18, 0.2, beam);
    bar(sx * mainHalf, sx * sideX, sideH - 0.42, 0.04, 0.21, trim);
    const r = roof(sideX - mainHalf + 0.9, 1.15, 0.42, tile, ridge);
    r.position.set((sx * (mainHalf + sideX)) / 2, sideH - 0.15, 0);
    g.add(r);
  }
  // Main bay: two beams with the plaque between, then the big roof.
  bar(-mainHalf - 0.3, mainHalf + 0.3, mainH - 1.0, 0.22, 0.24, beam);
  bar(-mainHalf - 0.3, mainHalf + 0.3, mainH - 1.14, 0.05, 0.25, trim);
  bar(-mainHalf - 0.3, mainHalf + 0.3, mainH - 0.22, 0.24, 0.26, beam);
  const main = roof(mainHalf * 2 + 1.3, 1.45, 0.62, tile, ridge);
  main.position.y = mainH - 0.08;
  g.add(main);

  const plaqueFace = toonMaterial({
    map: signTexture(title, 768, 224, {
      bg: "#22305a",
      fg: "#f3cf73",
      border: "#e0b45a",
      font: SERIF,
    }),
    emissive: new Color(0xffe0a0),
    emissiveIntensity: 0.12,
  });
  const plaque = signBoard(1.9, 0.56, 0.1, trim, plaqueFace);
  plaque.position.y = mainH - 0.6;
  g.add(plaque);

  // Red paper lanterns, glowing softly in the sunset.
  const lanternMat = toonMaterial({
    color: 0xe0483c,
    emissive: new Color(0xff5a3c),
    emissiveIntensity: 0.55,
  });
  const lanternGeo = new SphereGeometry(0.2, 16, 12);
  lanternGeo.scale(1, 1.25, 1);
  for (const sx of [-1, 1]) {
    const lantern = new Group();
    const body = new Mesh(lanternGeo, lanternMat);
    const capTop = new Mesh(new CylinderGeometry(0.1, 0.1, 0.06, 12), ridge);
    capTop.position.y = 0.26;
    const capBottom = capTop.clone();
    capBottom.position.y = -0.26;
    const cord = new Mesh(new CylinderGeometry(0.01, 0.01, 0.3, 4), ridge);
    cord.position.y = 0.42;
    lantern.add(body, capTop, capBottom, cord);
    lantern.position.set(sx * (mainHalf - 0.45), mainH - 1.7, 0);
    g.add(lantern);
  }
  return finish(g);
}

// ---------------------------------------------------------------------------
// Aisle
// ---------------------------------------------------------------------------

/** Irregular stepping stones down the central aisle from z0 (gate) to z1 (back). */
export function buildAislePath(z0: number, z1: number): InstancedMesh {
  const rng = createRng(11);
  const geo = new RoundedBoxGeometry(0.85, 0.06, 0.5, 2, 0.03);
  geo.translate(0, 0.02, 0);
  const mats: Matrix4[] = [];
  const q = new Quaternion();
  const yAxis = new Vector3(0, 1, 0);
  for (let z = z0 - 0.4; z > z1; z -= 0.68) {
    q.setFromAxisAngle(yAxis, (rng() - 0.5) * 0.35);
    const s = 0.85 + rng() * 0.3;
    mats.push(
      new Matrix4().compose(
        new Vector3((rng() - 0.5) * 0.18, 0, z),
        q,
        new Vector3(s, 1, 0.9 + rng() * 0.2),
      ),
    );
  }
  const im = new InstancedMesh(geo, toonMaterial({ color: 0xd6cdc4 }), mats.length);
  mats.forEach((m, i) => im.setMatrixAt(i, m));
  im.receiveShadow = true;
  im.layers.enable(OUTLINE_LAYER);
  return im;
}
