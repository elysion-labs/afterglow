import {
  type BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  Euler,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  Matrix4,
  Mesh,
  type MeshToonMaterial,
  Shape,
  ShapeGeometry,
  type Vector3,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { type Streamer, loadLastSwept, oshiColor } from "../model/streamers.ts";
import { type Weathering, createRng, hashString, weathering } from "../model/weathering.ts";
import { traceArch } from "./arch.ts";
import { type Footprint, type TimeUniform, Weeds } from "./grass.ts";
import { Inscription } from "./inscription.ts";
import { WeatherState, applyWeathering, toonMaterial } from "./toon.ts";

export const OUTLINE_LAYER = 1;

const BASE_LOW = { w: 1.7, h: 0.16, d: 0.95 };
const BASE_UP = { w: 1.32, h: 0.14, d: 0.62 };
const SLAB = { w: 1.0, h: 1.45, shoulder: 0.42, d: 0.16, bevel: 0.03 };
const PANEL = { w: 0.8, h: 1.2, shoulder: 0.34, lift: 0.12 };
const SLAB_BOTTOM = BASE_LOW.h + BASE_UP.h;
export const GRAVE_HEIGHT = SLAB_BOTTOM + SLAB.h + SLAB.bevel * 2;
export const PANEL_SHAPE = { width: PANEL.w, height: PANEL.h, shoulder: PANEL.shoulder };

export const GRAVE_FOOTPRINT: Footprint = {
  hx: BASE_LOW.w / 2,
  hz: BASE_LOW.d / 2,
  ledges: [
    [BASE_LOW.w / 2 - 0.06, (BASE_UP.d / 2 + BASE_LOW.d / 2) / 2, BASE_LOW.h],
    [BASE_UP.w / 2 - 0.06, (SLAB.d / 2 + SLAB.bevel + BASE_UP.d / 2) / 2, SLAB_BOTTOM],
  ],
};

/** Grave-local rectangle the clean mask covers (projected along z). */
const MASK = { x0: -0.9, y0: 0, w: 1.8, h: 2.0, px: 256 };

interface SharedGeometry {
  base: BufferGeometry;
  slab: BufferGeometry;
  panel: BufferGeometry;
}

let shared: SharedGeometry | null = null;

/** Geometry is identical for every grave, so it is built once. */
function sharedGeometry(): SharedGeometry {
  if (shared) return shared;
  const low = new RoundedBoxGeometry(BASE_LOW.w, BASE_LOW.h, BASE_LOW.d, 4, 0.03);
  low.translate(0, BASE_LOW.h / 2, 0);
  const up = new RoundedBoxGeometry(BASE_UP.w, BASE_UP.h, BASE_UP.d, 4, 0.03);
  up.translate(0, BASE_LOW.h + BASE_UP.h / 2, 0);
  const base = mergeGeometries([low, up])!;

  const slabShape = new Shape();
  traceArch(slabShape, SLAB.w, SLAB.h, SLAB.shoulder);
  const slab = new ExtrudeGeometry(slabShape, {
    depth: SLAB.d,
    bevelEnabled: true,
    bevelThickness: SLAB.bevel,
    bevelSize: SLAB.bevel,
    bevelSegments: 4,
    curveSegments: 48,
  });
  slab.translate(0, SLAB_BOTTOM + SLAB.bevel, -SLAB.d / 2);

  const panelShape = new Shape();
  traceArch(panelShape, PANEL.w, PANEL.h, PANEL.shoulder);
  const panel = new ShapeGeometry(panelShape, 48);
  // ShapeGeometry UVs are in shape units; normalise them to 0..1.
  const uv = panel.attributes.uv!;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (uv.getX(i) + PANEL.w / 2) / PANEL.w, uv.getY(i) / PANEL.h);
  }
  panel.translate(0, SLAB_BOTTOM + SLAB.bevel + PANEL.lift, SLAB.d / 2 + SLAB.bevel + 0.002);

  shared = { base, slab, panel };
  return shared;
}

/** Fully dirty mask used by every grave that is not being cleaned right now. */
const DIRTY = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
DIRTY.needsUpdate = true;

/**
 * The visitor's wipe progress. There is only one: it is attached to the
 * focused grave and reset whenever focus moves.
 */
export class CleanMask {
  readonly texture: CanvasTexture;
  private readonly ctx: CanvasRenderingContext2D;
  /** 1 where stone is visible from the front; used to measure progress. */
  private readonly silhouette: Uint8Array;

  constructor() {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = MASK.px;
    this.ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    this.texture = new CanvasTexture(canvas);
    this.silhouette = buildSilhouette();
    this.reset();
  }

  /** Paint at a grave-local point. */
  wipeAt(local: Vector3, radius = 0.12, strength = 0.5): void {
    const [x, y] = toMask(local.x, local.y);
    const r = (radius / MASK.w) * MASK.px;
    const g = this.ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,255,255,${strength})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    this.ctx.fillStyle = g;
    this.ctx.fillRect(x - r, y - r, r * 2, r * 2);
    this.texture.needsUpdate = true;
  }

  /** Fraction (0..1) of the front silhouette that has been wiped clean. */
  ratio(): number {
    const data = this.ctx.getImageData(0, 0, MASK.px, MASK.px).data;
    let total = 0;
    let clean = 0;
    for (let i = 0; i < this.silhouette.length; i += 2) {
      if (!this.silhouette[i]) continue;
      total++;
      clean += data[i * 4]! / 255;
    }
    return total ? clean / total : 1;
  }

  reset(): void {
    this.ctx.fillStyle = "#000";
    this.ctx.fillRect(0, 0, MASK.px, MASK.px);
    this.texture.needsUpdate = true;
  }
}

export class Tombstone {
  readonly group = new Group();
  readonly streamer: Streamer;
  /** Meshes the visitor can wipe (raycast targets). */
  readonly stoneMeshes: Mesh[] = [];
  readonly weeds: Weeds;
  lastSweptAt: number;
  current: Weathering = weathering(0);
  private readonly weather = new WeatherState();
  private readonly inscription = new Inscription(PANEL_SHAPE, 256);
  private readonly panelMaterial: MeshToonMaterial;
  private readonly bouquet: Bouquet;

  constructor(streamer: Streamer, position: Vector3, time: TimeUniform) {
    this.streamer = streamer;
    this.lastSweptAt = loadLastSwept(streamer);
    this.group.position.copy(position);
    this.group.name = streamer.uid;

    const geo = sharedGeometry();
    const stoneSlab = applyWeathering(toonMaterial({ color: 0xc8ccda }), this.weather, 1);
    const stoneBase = applyWeathering(toonMaterial({ color: 0x9d9db2 }), this.weather, 1);
    this.panelMaterial = applyWeathering(
      toonMaterial({
        map: this.inscription.map,
        emissive: new Color(0xffd9a0),
        emissiveMap: this.inscription.glow,
        emissiveIntensity: 0.45,
      }),
      this.weather,
      0,
    );
    this.inscription.setStreamer(streamer);

    for (const [g, m] of [
      [geo.base, stoneBase],
      [geo.slab, stoneSlab],
      [geo.panel, this.panelMaterial],
    ] as const) {
      const mesh = new Mesh(g, m);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.layers.enable(OUTLINE_LAYER);
      this.group.add(mesh);
      this.stoneMeshes.push(mesh);
    }

    this.bouquet = new Bouquet(streamer);
    this.bouquet.mesh.position.set(-0.2, BASE_LOW.h, BASE_UP.d / 2 + 0.11);
    this.group.add(this.bouquet.mesh);

    this.weeds = new Weeds(GRAVE_FOOTPRINT, streamer.uid, time);
    this.group.add(this.weeds.mesh);

    this.attachMask(null);
  }

  /** Recompute weathering for the given (possibly simulated) time. */
  update(now: number): Weathering {
    this.current = weathering(now - this.lastSweptAt);
    this.weather.uniforms.uDust.value = this.current.dust;
    this.weather.uniforms.uMoss.value = this.current.moss;
    this.bouquet.setFreshness(this.current.flowers);
    this.weeds.setLevel(this.current.weeds);
    return this.current;
  }

  attachMask(mask: CleanMask | null): void {
    const u = this.weather.uniforms;
    u.uClean.value = mask ? mask.texture : DIRTY;
    u.uCleanOrigin.value.set(this.group.position.x + MASK.x0, this.group.position.y + MASK.y0);
    u.uCleanSize.value.set(MASK.w, MASK.h);
  }

  /** Swap the panel to a high-resolution inscription while focused (null = own low-res one). */
  showInscription(hiRes: Inscription | null): void {
    const ins = hiRes ?? this.inscription;
    this.panelMaterial.map = ins.map;
    this.panelMaterial.emissiveMap = ins.glow;
  }

  toLocal(world: Vector3): Vector3 {
    return world.clone().sub(this.group.position);
  }
}

function toMask(x: number, y: number): [number, number] {
  return [((x - MASK.x0) / MASK.w) * MASK.px, (1 - (y - MASK.y0) / MASK.h) * MASK.px];
}

function buildSilhouette(): Uint8Array {
  const c = document.createElement("canvas");
  c.width = c.height = MASK.px;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  const rect = (w: number, y0: number, h: number) => {
    const [x, y] = toMask(-w / 2, y0 + h);
    ctx.fillRect(x, y, (w / MASK.w) * MASK.px, (h / MASK.h) * MASK.px);
  };
  rect(BASE_LOW.w, 0, BASE_LOW.h);
  rect(BASE_UP.w, BASE_LOW.h, BASE_UP.h);
  const at = (x: number, y: number) => toMask(x, y + SLAB_BOTTOM);
  ctx.beginPath();
  traceArch(
    {
      moveTo: (x, y) => ctx.moveTo(...at(x, y)),
      lineTo: (x, y) => ctx.lineTo(...at(x, y)),
      bezierCurveTo: (a, b, cc, d, x, y) =>
        ctx.bezierCurveTo(...at(a, b), ...at(cc, d), ...at(x, y)),
    },
    SLAB.w + SLAB.bevel * 2,
    SLAB.h + SLAB.bevel * 2,
    SLAB.shoulder,
  );
  ctx.fill();
  const px = ctx.getImageData(0, 0, MASK.px, MASK.px).data;
  const out = new Uint8Array(MASK.px * MASK.px);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4]! > 127 ? 1 : 0;
  return out;
}

/** Flowers left by the last visitor, merged into one vertex-coloured mesh; they wilt as days pass. */
class Bouquet {
  readonly mesh: Mesh;
  private readonly material = toonMaterial({ vertexColors: true, side: DoubleSide });
  private readonly wilted = new Color(0x9a7a5a);

  constructor(s: Streamer) {
    const rng = createRng(hashString(`${s.uid}:flowers`));
    const color = oshiColor(s);
    const palette = [
      new Color(color),
      new Color(0xffffff),
      new Color(0xffc4d6),
      new Color(0xfff1a8),
    ];
    const parts: BufferGeometry[] = [];
    const add = (g: BufferGeometry, c: Color, m: Matrix4) => {
      const geo = g.index ? g.toNonIndexed() : g;
      geo.applyMatrix4(m);
      const colors = new Float32Array(geo.attributes.position!.count * 3);
      for (let i = 0; i < colors.length; i += 3) c.toArray(colors, i);
      geo.setAttribute("color", new Float32BufferAttribute(colors, 3));
      parts.push(geo);
    };
    // Laid on the lower step, pointing sideways.
    const lay = new Matrix4().makeRotationFromEuler(new Euler(0, 0.35, -Math.PI / 2 + 0.2));
    lay.setPosition(0, 0.05, 0);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const tilt = new Matrix4()
        .makeRotationX(Math.cos(a) * 0.18)
        .multiply(new Matrix4().makeRotationZ(Math.sin(a) * 0.18));
      const stem = new CylinderGeometry(0.006, 0.006, 0.32, 5);
      stem.translate(0, 0.16, 0);
      add(stem, new Color(0x5c8a3a), lay.clone().multiply(tilt));
      const head = new IcosahedronGeometry(0.035, 0);
      head.translate(0, 0.32, 0);
      add(head, palette[Math.floor(rng() * palette.length)]!, lay.clone().multiply(tilt));
    }
    const wrap = new ConeGeometry(0.09, 0.22, 8, 1, true);
    wrap.translate(0, 0.11, 0);
    wrap.rotateX(Math.PI);
    wrap.translate(0, 0.22, 0);
    add(wrap, new Color(color).lerp(new Color(0xffffff), 0.7), lay);

    this.mesh = new Mesh(mergeGeometries(parts)!, this.material);
    this.mesh.castShadow = true;
    this.mesh.layers.enable(OUTLINE_LAYER);
  }

  setFreshness(f: number): void {
    this.mesh.visible = f > 0.01;
    this.material.color.set(0xffffff).lerp(this.wilted, (1 - f) * 0.8);
    this.mesh.scale.setScalar(0.8 + 0.2 * f);
  }
}
