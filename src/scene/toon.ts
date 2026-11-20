import {
  type Texture,
  DataTexture,
  MeshToonMaterial,
  NearestFilter,
  RedFormat,
  Vector2,
  type MeshToonMaterialParameters,
} from "three";

let gradient: DataTexture | null = null;

/** Three-band ramp: shadow / mid / lit, the classic cel look. */
export function toonGradient(): DataTexture {
  if (!gradient) {
    gradient = new DataTexture(new Uint8Array([70, 160, 255]), 3, 1, RedFormat);
    gradient.minFilter = NearestFilter;
    gradient.magFilter = NearestFilter;
    gradient.generateMipmaps = false;
    gradient.needsUpdate = true;
  }
  return gradient;
}

export function toonMaterial(params: MeshToonMaterialParameters): MeshToonMaterial {
  return new MeshToonMaterial({ gradientMap: toonGradient(), ...params });
}

/**
 * Per-grave weathering state shared by every stone material. The clean mask is
 * a texture projected onto the grave along +z (world xy), painted white where
 * the visitor has wiped.
 */
export class WeatherState {
  readonly uniforms = {
    uDust: { value: 0 },
    uMoss: { value: 0 },
    uClean: { value: null as Texture | null },
    uCleanOrigin: { value: new Vector2() },
    uCleanSize: { value: new Vector2(1, 1) },
  };
}

const NOISE_GLSL = /* glsl */ `
varying vec3 vWPos;
varying vec3 vWNormal;
uniform float uDust;
uniform float uMoss;
uniform float uGranite;
uniform sampler2D uClean;
uniform vec2 uCleanOrigin;
uniform vec2 uCleanSize;
float wHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float wNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(wHash(i), wHash(i + vec3(1, 0, 0)), f.x), mix(wHash(i + vec3(0, 1, 0)), wHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(wHash(i + vec3(0, 0, 1)), wHash(i + vec3(1, 0, 1)), f.x), mix(wHash(i + vec3(0, 1, 1)), wHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float wFbm(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 4; i++) {
    s += a * wNoise(p);
    p = p * 2.03 + 17.1;
    a *= 0.5;
  }
  return s;
}
`;

const WEATHER_FRAGMENT = /* glsl */ `
#include <map_fragment>
float wCover = 0.0;
{
  vec3 wn = normalize(vWNormal);
  float up = clamp(wn.y, 0.0, 1.0);

  // Granite speckle so bare stone does not read as plastic.
  float g = wNoise(vWPos * 160.0);
  diffuseColor.rgb *= 1.0 - uGranite * (step(0.8, g) * 0.3 + 0.1 * wFbm(vWPos * 5.0));

  vec2 cuv = (vWPos.xy - uCleanOrigin) / uCleanSize;
  float dirty = 1.0 - texture2D(uClean, cuv).r;

  // Dust: a thin film everywhere (text stays readable) plus hard-edged
  // blotches that favour up-facing ledges and vertical rain streaks.
  float f = wFbm(vWPos * 7.0) * 0.75 + up * 0.45;
  float streak = wFbm(vec3(vWPos.x * 40.0, vWPos.y * 1.2, vWPos.z * 40.0));
  f += (1.0 - up) * smoothstep(0.55, 0.7, streak) * 0.25;
  float dThr = 1.0 - uDust * 0.6;
  float blot = smoothstep(dThr, dThr + 0.03, f);
  float speck = step(0.93, wNoise(vWPos * 90.0)) * uDust * 0.4;
  float dust = clamp(uDust * 0.32 + blot * uDust * 0.42 + speck, 0.0, 0.85) * dirty;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.40, 0.35, 0.30), dust);

  // Moss grows on top of the grime: creeps up from the ground, settles on ledges.
  float m = wFbm(vWPos * 5.0 + 7.3) * 0.8 + (1.0 - smoothstep(0.0, 1.1, vWPos.y)) * 0.6 + up * 0.15;
  // m peaks around 1.5 on low, up-facing ledges, so the threshold must start
  // above that: a freshly swept grave (uMoss = 0) shows no moss at all.
  float mThr = 1.6 - uMoss * 1.05;
  float moss = smoothstep(mThr, mThr + 0.03, m) * step(0.001, uMoss) * dirty;
  vec3 mossCol = mix(vec3(0.12, 0.3, 0.05), vec3(0.3, 0.52, 0.08), step(0.5, wNoise(vWPos * 24.0)));
  diffuseColor.rgb = mix(diffuseColor.rgb, mossCol, moss);
  wCover = max(dust, moss);
}
`;

/** Injects dust / moss / clean-mask logic into a MeshToonMaterial. */
export function applyWeathering(
  material: MeshToonMaterial,
  state: WeatherState,
  granite: number,
): MeshToonMaterial {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, state.uniforms, { uGranite: { value: granite } });
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;",
      )
      .replace(
        "#include <project_vertex>",
        `#include <project_vertex>
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${NOISE_GLSL}`)
      .replace("#include <map_fragment>", WEATHER_FRAGMENT)
      .replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\ntotalEmissiveRadiance *= 1.0 - wCover;",
      );
  };
  material.customProgramCacheKey = () => "weathered-toon";
  return material;
}
