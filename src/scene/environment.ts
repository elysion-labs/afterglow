import {
  BackSide,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  Fog,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  type Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from "three";
import { createRng } from "../model/weathering.ts";
import { toonMaterial } from "./toon.ts";

/** Where the sun sits in the painted sky (artistic: not the key light direction). */
const SUN_DIR = new Vector3(-0.55, 0.1, -0.83).normalize();

const NOISE_2D = /* glsl */ `
float eHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float eNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(eHash(i), eHash(i + vec2(1, 0)), f.x), mix(eHash(i + vec2(0, 1)), eHash(i + vec2(1, 1)), f.x), f.y);
}
float eFbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * eNoise(p); p *= 2.07; a *= 0.5; }
  return s;
}
`;

export interface Environment {
  /**
   * `focus` is what the camera looks at; `radius` is how much ground around
   * it needs crisp shadows (small when focused, the whole cemetery in overview).
   */
  update(time: number, camera: Vector3, focus: Vector3, radius: number): void;
  setPetals(visible: boolean): void;
}

const SUN_OFFSET = new Vector3(-3.5, 4.2, 4.5).normalize().multiplyScalar(30);

/** `extent` is the cemetery's radius in metres. */
export function buildEnvironment(scene: Scene, extent: number): Environment {
  const fogColor = new Color(0xf2b6a0);
  const fog = new Fog(fogColor, 20, 60);
  scene.fog = fog;

  // Lights: warm key from front-left, lavender fill from the sky.
  const hemi = new HemisphereLight(0xffe6e0, 0x6c5a96, 1.4);
  scene.add(hemi);
  const sun = new DirectionalLight(0xffc596, 2.8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 80;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);
  let shadowRadius = 0;

  const sky = buildSky();
  scene.add(sky);
  scene.add(buildHills(extent + 45, 10, 0x9a7aa8, 3.0, 0));
  scene.add(buildHills(extent + 30, 6, 0x6e5788, 7.0, 1));

  const ground = new Mesh(new CircleGeometry(extent + 90, 96), toonMaterial({ color: 0x86a95e }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const petals = buildPetals();
  scene.add(petals.mesh);

  return {
    update(time, camera, focus, radius) {
      sky.position.copy(camera);
      // Haze starts just behind what the camera is looking at, at any zoom level.
      const dist = camera.distanceTo(focus);
      fog.near = dist * 0.9;
      fog.far = fog.near + Math.max(40, dist * 1.5);
      sun.target.position.copy(focus);
      sun.position.copy(focus).add(SUN_OFFSET);
      // Resize the shadow frustum only when it changes noticeably.
      if (Math.abs(radius - shadowRadius) > shadowRadius * 0.05) {
        shadowRadius = radius;
        const c = sun.shadow.camera;
        c.left = c.bottom = -radius;
        c.right = c.top = radius;
        c.updateProjectionMatrix();
      }
      const u = petals.material.uniforms;
      u.uTime!.value = time;
      u.uCenter!.value.copy(focus).setY(0);
      u.uSpread!.value = Math.max(1, radius / 4);
    },
    setPetals(visible) {
      petals.mesh.visible = visible;
    },
  };
}

function buildSky(): Mesh {
  const material = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    uniforms: {
      uSunDir: { value: SUN_DIR },
      uZenith: { value: new Color(0x4b4f93) },
      uMid: { value: new Color(0xb28ccc) },
      uLow: { value: new Color(0xff9fa6) },
      uHorizon: { value: new Color(0xffc18f) },
      uSun: { value: new Color(0xfff4d6) },
      uCloudLit: { value: new Color(0xffe0c8) },
      uCloudShade: { value: new Color(0xd88aa6) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      ${NOISE_2D}
      uniform vec3 uSunDir, uZenith, uMid, uLow, uHorizon, uSun, uCloudLit, uCloudShade;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float y = d.y;
        vec3 col = mix(uHorizon, uLow, smoothstep(0.0, 0.12, y));
        col = mix(col, uMid, smoothstep(0.1, 0.38, y));
        col = mix(col, uZenith, smoothstep(0.35, 0.9, y));
        col = mix(col, uHorizon, step(y, 0.0));

        float sd = max(dot(d, uSunDir), 0.0);
        col += uSun * (pow(sd, 12.0) * 0.45 + pow(sd, 120.0) * 0.6);
        col = mix(col, uSun, smoothstep(0.9988, 0.9992, sd));

        // Flat, banded anime clouds: lit tops, pink undersides.
        float az = atan(d.z, d.x);
        vec2 cp = vec2(az * 3.2, y * 16.0);
        float n = eFbm(cp + vec2(0.0, 3.0));
        float band = smoothstep(0.04, 0.12, y) * (1.0 - smoothstep(0.32, 0.5, y));
        float cloud = smoothstep(0.56, 0.58, n * band + 0.2 * band);
        float under = smoothstep(0.56, 0.58, eFbm(cp + vec2(0.0, 3.25)) * band + 0.2 * band);
        vec3 cloudCol = mix(uCloudShade, uCloudLit, under);
        cloudCol += uSun * pow(sd, 6.0) * 0.4;
        col = mix(col, cloudCol, cloud);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
  const sky = new Mesh(new SphereGeometry(300, 48, 24), material);
  sky.renderOrder = -1;
  return sky;
}

/** Silhouette ring of hills / tree line; the hill profile is noise around the circle. */
function buildHills(
  radius: number,
  height: number,
  color: number,
  freq: number,
  seed: number,
): Mesh {
  const material = new ShaderMaterial({
    side: DoubleSide,
    fog: false,
    uniforms: {
      uColor: { value: new Color(color) },
      uHaze: { value: new Color(0xf6b9a4) },
      uFreq: { value: freq },
      uSeed: { value: seed * 13.7 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      ${NOISE_2D}
      uniform vec3 uColor, uHaze;
      uniform float uFreq, uSeed;
      varying vec2 vUv;
      void main() {
        // Wrap-around safe profile: sample noise on a circle.
        vec2 p = vec2(cos(vUv.x * 6.2831), sin(vUv.x * 6.2831)) * uFreq + uSeed;
        float h = 0.35 + 0.45 * eFbm(p) + 0.12 * eNoise(p * 9.0);
        if (vUv.y > h) discard;
        vec3 col = mix(uColor, uHaze, (1.0 - vUv.y / h) * 0.35);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new Mesh(new CylinderGeometry(radius, radius, height, 128, 1, true), material);
  mesh.position.y = height / 2 - 0.3;
  return mesh;
}

function buildPetals(): { mesh: Mesh; material: ShaderMaterial } {
  const count = 180;
  const rng = createRng(20261120);
  const geo = new InstancedBufferGeometry();
  geo.setAttribute(
    "position",
    new Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
  );
  geo.setAttribute("uv", new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < seeds.length; i++) seeds[i] = rng();
  geo.setAttribute("aSeed", new InstancedBufferAttribute(seeds, 4));
  geo.instanceCount = count;

  const material = new ShaderMaterial({
    side: DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uCenter: { value: new Vector3() },
      uSpread: { value: 1 },
      uA: { value: new Color(0xffd3e0) },
      uB: { value: new Color(0xff9fbf) },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      uniform float uTime;
      uniform vec3 uCenter;
      uniform float uSpread;
      varying vec2 vUv;
      varying float vShade;
      mat3 rot(vec3 a) {
        vec3 s = sin(a), c = cos(a);
        mat3 rx = mat3(1, 0, 0, 0, c.x, s.x, 0, -s.x, c.x);
        mat3 ry = mat3(c.y, 0, -s.y, 0, 1, 0, s.y, 0, c.y);
        mat3 rz = mat3(c.z, s.z, 0, -s.z, c.z, 0, 0, 0, 1);
        return rz * ry * rx;
      }
      void main() {
        vUv = uv;
        float speed = 0.18 + aSeed.w * 0.15;
        float y = mod(aSeed.y * 4.0 * uSpread - uTime * speed, 4.0 * uSpread);
        float x = mod(aSeed.x * 8.0 * uSpread + uTime * 0.22 + sin(uTime * 0.7 + aSeed.z * 6.28) * 0.4, 8.0 * uSpread) - 4.0 * uSpread;
        float z = (aSeed.z * 6.0 - 3.0) * uSpread + cos(uTime * 0.5 + aSeed.x * 6.28) * 0.3;
        vec3 spin = vec3(uTime * (0.8 + aSeed.x), uTime * (1.1 + aSeed.y), aSeed.z * 6.28);
        mat3 r = rot(spin);
        vec3 p = r * (position * vec3(0.05, 0.035, 1.0));
        vShade = abs((r * vec3(0, 0, 1)).y);
        gl_Position = projectionMatrix * viewMatrix * vec4(uCenter + vec3(x, y, z) + p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uA, uB;
      varying vec2 vUv;
      varying float vShade;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        // Petal: ellipse with a notch at the tip.
        float e = p.x * p.x + p.y * p.y * 1.6;
        float notch = length(p - vec2(1.05, 0.0));
        if (e > 1.0 || notch < 0.32) discard;
        vec3 col = mix(uB, uA, step(0.4, vShade));
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new Mesh(geo, material);
  mesh.frustumCulled = false;
  return { mesh, material };
}
