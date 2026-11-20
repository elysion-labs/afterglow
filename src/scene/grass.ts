import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  type Ray,
  ShaderMaterial,
  Sphere,
  UniformsLib,
  UniformsUtils,
  Vector3,
} from "three";
import { createRng, hashString } from "../model/weathering.ts";

export const MAX_CLUMPS = 16;

export interface Footprint {
  /** Half extents of the grave base on the ground. */
  hx: number;
  hz: number;
  /** Ledges where weeds can take root: [half width x, z, height y]. */
  ledges: [number, number, number][];
}

/** A uniform shared by every grass material so one write animates them all. */
export type TimeUniform = { value: number };

const vertexShader = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec3 aPos;
attribute vec4 aData;   // height, angle, threshold, clump (-1 = lawn)
attribute vec3 aShape;  // bend, width, tint
uniform float uTime;
uniform float uWeeds;
uniform float uPluck[${MAX_CLUMPS}];
varying float vT;
varying float vTint;
varying float vWeed;
void main() {
  float h = aData.x;
  float grow = 1.0;
  float lift = 0.0;
  vWeed = 0.0;
  if (aData.w >= 0.0) {
    vWeed = 1.0;
    grow = smoothstep(aData.z, aData.z + 0.25, uWeeds);
    float pt = uPluck[int(aData.w)];
    if (pt >= 0.0) {
      float k = clamp((uTime - pt) / 0.6, 0.0, 1.0);
      lift = k * k * 0.5;
      grow *= 1.0 - k;
    }
  }
  vec3 p = position;
  float t = p.y;
  vT = t;
  vTint = aShape.z;
  p.x *= aShape.y;
  p.y *= h * grow;
  vec2 wpos = aPos.xz + modelMatrix[3].xz;
  float wind = sin(uTime * 1.6 + wpos.x * 1.3 + wpos.y * 0.9) * 0.6 + sin(uTime * 3.3 + wpos.x * 4.0) * 0.25;
  p.z += (aShape.x + wind * 0.15) * t * t * h * grow;
  float c = cos(aData.y);
  float s = sin(aData.y);
  p = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
  vec4 mvPosition = modelViewMatrix * vec4(aPos + p + vec3(0.0, lift, 0.0), 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const fragmentShader = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform vec3 uLawnBase;
uniform vec3 uLawnTip;
uniform vec3 uWeedBase;
uniform vec3 uWeedTip;
uniform vec3 uWarm;
varying float vT;
varying float vTint;
varying float vWeed;
void main() {
  vec3 base = mix(uLawnBase, uWeedBase, vWeed);
  vec3 tip = mix(uLawnTip, uWeedTip, vWeed);
  tip = mix(tip, uWarm, vTint * 0.6);
  // Two hard bands instead of a smooth ramp: reads as cel-shaded.
  float band = step(0.45, vT) * 0.6 + step(0.8, vT) * 0.4;
  gl_FragColor = vec4(mix(base, tip, band), 1.0);
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

function bladeMaterial(time: TimeUniform): ShaderMaterial {
  const uniforms = UniformsUtils.merge([
    UniformsLib.fog,
    {
      uWeeds: { value: 0 },
      uPluck: { value: Array.from({ length: MAX_CLUMPS }, () => -1) },
      uLawnBase: { value: new Color(0x3d6b3f) },
      uLawnTip: { value: new Color(0xa9cf62) },
      uWeedBase: { value: new Color(0x2c5530) },
      uWeedTip: { value: new Color(0x8fb24a) },
      uWarm: { value: new Color(0xffc46b) },
    },
  ]);
  // Not cloned by `merge`, so all blade materials share the clock.
  uniforms.uTime = time;
  return new ShaderMaterial({
    vertexShader,
    fragmentShader,
    side: DoubleSide,
    fog: true,
    uniforms,
  });
}

function bladeMesh(material: ShaderMaterial, pos: number[], data: number[], shape: number[]): Mesh {
  const geo = new InstancedBufferGeometry();
  fillBlade(geo);
  geo.instanceCount = pos.length / 3;
  geo.setAttribute("aPos", new InstancedBufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute("aData", new InstancedBufferAttribute(new Float32Array(data), 4));
  geo.setAttribute("aShape", new InstancedBufferAttribute(new Float32Array(shape), 3));
  const mesh = new Mesh(geo, material);
  mesh.frustumCulled = false;
  return mesh;
}

export interface LawnArea {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Return true where no grass should grow (inside plots). */
  exclude(x: number, z: number): boolean;
}

/** The shared, mown lawn covering the paths between plots. */
export function createLawn(area: LawnArea, time: TimeUniform, maxBlades = 120_000): Mesh {
  const rng = createRng(hashString("lawn"));
  const w = area.maxX - area.minX;
  const d = area.maxZ - area.minZ;
  const count = Math.min(maxBlades, Math.round(w * d * 75));
  const pos: number[] = [];
  const data: number[] = [];
  const shape: number[] = [];
  for (let i = 0; i < count; i++) {
    const x = area.minX + rng() * w;
    const z = area.minZ + rng() * d;
    if (area.exclude(x, z)) continue;
    pos.push(x, 0, z);
    data.push(0.05 + rng() * 0.08, rng() * Math.PI * 2, 0, -1);
    shape.push((rng() - 0.5) * 0.6, 0.014 + rng() * 0.012, rng() ** 3);
  }
  return bladeMesh(bladeMaterial(time), pos, data, shape);
}

interface Clump {
  center: Vector3;
  threshold: number;
  height: number;
  radius: number;
  pluckedAt: number;
}

/** Weed clumps around one grave, sprouting one after another as neglect grows. */
export class Weeds {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private readonly clumps: Clump[] = [];
  private level = 0;

  constructor(footprint: Footprint, seedKey: string, time: TimeUniform) {
    const rng = createRng(hashString(`${seedKey}:weeds`));
    const pos: number[] = [];
    const data: number[] = [];
    const shape: number[] = [];

    // Along the front and side edges of the base and on the front ledges; never
    // behind the stone, where a visitor could not reach them.
    const spots: Vector3[] = [];
    for (let i = 0; i < 9; i++) {
      const u = rng() * 2 - 1;
      const out = 0.03 + rng() * 0.06;
      if (rng() < 0.6) {
        spots.push(new Vector3(u * footprint.hx, 0, footprint.hz + out));
      } else {
        const sx = rng() < 0.5 ? -1 : 1;
        spots.push(new Vector3(sx * (footprint.hx + out), 0, u * footprint.hz));
      }
    }
    for (const [lx, lz, ly] of footprint.ledges) {
      for (let i = 0; i < 3; i++) {
        const sx = rng() < 0.5 ? -1 : 1;
        spots.push(new Vector3(sx * lx * (0.3 + rng() * 0.65), ly, lz));
      }
    }
    spots.slice(0, MAX_CLUMPS).forEach((center, idx) => {
      const clump: Clump = {
        center,
        threshold: (idx / spots.length) * 0.7,
        height: 0.18 + rng() * 0.32 - center.y * 0.4,
        radius: 0.05 + rng() * 0.06,
        pluckedAt: -1,
      };
      this.clumps.push(clump);
      const blades = 14 + Math.floor(rng() * 14);
      for (let b = 0; b < blades; b++) {
        const a = rng() * Math.PI * 2;
        const r = rng() * clump.radius;
        pos.push(center.x + Math.cos(a) * r, center.y, center.z + Math.sin(a) * r);
        data.push(clump.height * (0.5 + rng() * 0.6), a + (rng() - 0.5), clump.threshold, idx);
        shape.push(0.25 + rng() * 0.6, 0.02 + rng() * 0.018, rng() ** 2);
      }
    });

    this.material = bladeMaterial(time);
    this.mesh = bladeMesh(this.material, pos, data, shape);
  }

  setLevel(level: number): void {
    this.level = level;
    this.material.uniforms.uWeeds!.value = level;
    this.mesh.visible = level > 0.001;
  }

  private growth(c: Clump): number {
    const x = Math.min(1, Math.max(0, (this.level - c.threshold) / 0.25));
    return x * x * (3 - 2 * x);
  }

  /** Weed clumps big enough to bother pulling out. */
  visibleClumps(): number {
    return this.clumps.filter((c) => c.pluckedAt < 0 && this.growth(c) > 0.15).length;
  }

  /** Nearest pluckable clump hit by a world-space ray, with its distance. */
  pick(ray: Ray): { index: number; distance: number } | null {
    let best: { index: number; distance: number } | null = null;
    const hit = new Vector3();
    const origin = this.mesh.getWorldPosition(new Vector3());
    this.clumps.forEach((c, index) => {
      const g = this.growth(c);
      if (c.pluckedAt >= 0 || g < 0.15) return;
      const h = c.height * g;
      const center = c.center
        .clone()
        .add(origin)
        .setY(origin.y + c.center.y + h * 0.4);
      const sphere = new Sphere(center, Math.max(c.radius, h * 0.5) + 0.03);
      if (!ray.intersectSphere(sphere, hit)) return;
      const distance = hit.distanceTo(ray.origin);
      if (!best || distance < best.distance) best = { index, distance };
    });
    return best;
  }

  pluck(index: number, time: number): void {
    const clump = this.clumps[index];
    if (!clump) return;
    clump.pluckedAt = time;
    (this.material.uniforms.uPluck!.value as number[])[index] = time;
  }

  resetPlucks(): void {
    const arr = this.material.uniforms.uPluck!.value as number[];
    this.clumps.forEach((c, i) => {
      c.pluckedAt = -1;
      arr[i] = -1;
    });
  }
}

/** A tapered blade strip, x in [-0.5, 0.5], y in [0, 1]. */
function fillBlade(geo: BufferGeometry): void {
  const seg = 4;
  const verts: number[] = [];
  const index: number[] = [];
  for (let i = 0; i < seg; i++) {
    const t = i / seg;
    const w = 0.5 * (1 - t) ** 0.8;
    verts.push(-w, t, 0, w, t, 0);
  }
  verts.push(0, 1, 0);
  for (let i = 0; i < seg - 1; i++) {
    const a = i * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const last = (seg - 1) * 2;
  index.push(last, last + 1, seg * 2);
  geo.setAttribute("position", new Float32BufferAttribute(verts, 3));
  geo.setIndex(index);
}
