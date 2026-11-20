import {
  Color,
  DepthTexture,
  HalfFloatType,
  MeshNormalMaterial,
  type PerspectiveCamera,
  type Scene,
  ShaderMaterial,
  Vector2,
  type WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

const DEPTH_GLSL = /* glsl */ `
#include <packing>
uniform float uNear, uFar;
float viewDepth(sampler2D t, vec2 uv) {
  return -perspectiveDepthToViewZ(texture2D(t, uv).x, uNear, uFar);
}
`;

/**
 * 1. scene -> colour (+ depth)
 * 2. outlined objects -> view normals (+ depth), edge filter -> composite
 * 3. depth of field around the focused grave -> screen
 */
export class PostPipeline {
  outline = true;
  dof = true;
  /** 0 = everything sharp (overview), 1 = full depth of field (focused). */
  focusAmount = 0;
  /** View distance (m) that stays sharp. */
  focusDistance = 5;

  private readonly color = new WebGLRenderTarget(1, 1, {
    samples: 4,
    type: HalfFloatType,
    depthTexture: new DepthTexture(1, 1),
  });
  private readonly normals = new WebGLRenderTarget(1, 1, {
    samples: 4,
    depthTexture: new DepthTexture(1, 1),
  });
  private readonly composite = new WebGLRenderTarget(1, 1, { type: HalfFloatType });
  private readonly normalMaterial = new MeshNormalMaterial();
  private readonly outlineQuad: FullScreenQuad;
  private readonly dofQuad: FullScreenQuad;
  private readonly outlineMaterial: ShaderMaterial;
  private readonly dofMaterial: ShaderMaterial;
  private readonly clear = new Color();
  private readonly layer: number;

  constructor(layer: number) {
    this.layer = layer;
    this.outlineMaterial = new ShaderMaterial({
      uniforms: {
        tColor: { value: this.color.texture },
        tNormal: { value: this.normals.texture },
        tDepth: { value: this.normals.depthTexture },
        uTexel: { value: new Vector2() },
        uNear: { value: 0.1 },
        uFar: { value: 100 },
        uLine: { value: new Color(0x3b2440) },
        uEnabled: { value: 1 },
      },
      vertexShader: QUAD_VERTEX,
      fragmentShader: /* glsl */ `
        ${DEPTH_GLSL}
        uniform sampler2D tColor, tNormal, tDepth;
        uniform vec2 uTexel;
        uniform float uEnabled;
        uniform vec3 uLine;
        varying vec2 vUv;
        void main() {
          vec4 col = texture2D(tColor, vUv);
          if (uEnabled > 0.5) {
            vec4 n0 = texture2D(tNormal, vUv);
            float d0 = viewDepth(tDepth, vUv);
            float edge = 0.0;
            vec2 offs[4];
            offs[0] = vec2(uTexel.x, 0.0);
            offs[1] = vec2(-uTexel.x, 0.0);
            offs[2] = vec2(0.0, uTexel.y);
            offs[3] = vec2(0.0, -uTexel.y);
            for (int i = 0; i < 4; i++) {
              vec2 uv = vUv + offs[i];
              vec4 n = texture2D(tNormal, uv);
              float d = viewDepth(tDepth, uv);
              float dn = length(n.rgb - n0.rgb) + abs(n.a - n0.a);
              float dd = abs(d - d0) / min(d, d0);
              edge = max(edge, smoothstep(0.35, 0.6, dn));
              edge = max(edge, smoothstep(0.03, 0.06, dd));
            }
            col.rgb = mix(col.rgb, uLine, edge * 0.9);
          }
          gl_FragColor = vec4(col.rgb, 1.0);
        }
      `,
    });
    this.dofMaterial = new ShaderMaterial({
      uniforms: {
        tColor: { value: this.composite.texture },
        tDepth: { value: this.color.depthTexture },
        uTexel: { value: new Vector2() },
        uNear: { value: 0.1 },
        uFar: { value: 100 },
        uFocus: { value: 5 },
        uAmount: { value: 0 },
        uMaxBlur: { value: 10 },
      },
      vertexShader: QUAD_VERTEX,
      fragmentShader: /* glsl */ `
        ${DEPTH_GLSL}
        uniform sampler2D tColor, tDepth;
        uniform vec2 uTexel;
        uniform float uFocus, uAmount, uMaxBlur;
        varying vec2 vUv;
        // 0 inside the sharp zone around the focused grave, ramping to 1 away from it.
        float coc(vec2 uv) {
          float d = viewDepth(tDepth, uv);
          return clamp((abs(d - uFocus) - 0.7) / 2.5, 0.0, 1.0);
        }
        void main() {
          vec3 col = texture2D(tColor, vUv).rgb;
          if (uAmount > 0.001) {
            float c0 = coc(vUv) * uAmount;
            float radius = c0 * uMaxBlur;
            if (radius > 0.5) {
              vec3 acc = col;
              float wsum = 1.0;
              const int TAPS = 24;
              for (int i = 0; i < TAPS; i++) {
                float fi = float(i) + 0.5;
                float r = sqrt(fi / float(TAPS)) * radius;
                float a = fi * 2.39996;
                vec2 uv = vUv + vec2(cos(a), sin(a)) * r * uTexel;
                // Only gather from samples that are themselves blurry enough to
                // reach here, so sharp edges do not bleed into the blur.
                float w = smoothstep(r - 1.0, r + 1.0, coc(uv) * uAmount * uMaxBlur + 1.0);
                acc += texture2D(tColor, uv).rgb * w;
                wsum += w;
              }
              col = acc / wsum;
            }
            // Out-of-focus areas also lose a little colour and light.
            float g = dot(col, vec3(0.299, 0.587, 0.114));
            col = mix(col, vec3(g), c0 * 0.35) * (1.0 - c0 * 0.12);
            vec2 v = vUv - 0.5;
            col *= 1.0 - uAmount * smoothstep(0.35, 0.85, length(v * vec2(1.2, 1.0))) * 0.35;
          }
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }
      `,
    });
    this.outlineQuad = new FullScreenQuad(this.outlineMaterial);
    this.dofQuad = new FullScreenQuad(this.dofMaterial);
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    const w = Math.floor(width * pixelRatio);
    const h = Math.floor(height * pixelRatio);
    this.color.setSize(w, h);
    this.normals.setSize(w, h);
    this.composite.setSize(w, h);
    // ~1.5 CSS px lines regardless of DPR.
    this.outlineMaterial.uniforms.uTexel!.value.set(
      (0.75 * pixelRatio) / w,
      (0.75 * pixelRatio) / h,
    );
    this.dofMaterial.uniforms.uTexel!.value.set(1 / w, 1 / h);
    this.dofMaterial.uniforms.uMaxBlur!.value = 9 * pixelRatio;
  }

  render(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera): void {
    renderer.shadowMap.needsUpdate = true;
    renderer.setRenderTarget(this.color);
    renderer.render(scene, camera);

    if (this.outline) {
      const mask = camera.layers.mask;
      const background = scene.background;
      const fog = scene.fog;
      renderer.getClearColor(this.clear);
      const alpha = renderer.getClearAlpha();
      camera.layers.set(this.layer);
      scene.overrideMaterial = this.normalMaterial;
      scene.background = null;
      scene.fog = null;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(this.normals);
      renderer.clear();
      renderer.render(scene, camera);
      scene.overrideMaterial = null;
      scene.background = background;
      scene.fog = fog;
      camera.layers.mask = mask;
      renderer.setClearColor(this.clear, alpha);
    }

    for (const m of [this.outlineMaterial, this.dofMaterial]) {
      m.uniforms.uNear!.value = camera.near;
      m.uniforms.uFar!.value = camera.far;
    }
    this.outlineMaterial.uniforms.uEnabled!.value = this.outline ? 1 : 0;
    renderer.setRenderTarget(this.composite);
    this.outlineQuad.render(renderer);

    this.dofMaterial.uniforms.uAmount!.value = this.dof ? this.focusAmount : 0;
    this.dofMaterial.uniforms.uFocus!.value = this.focusDistance;
    renderer.setRenderTarget(null);
    this.dofQuad.render(renderer);
  }
}

const QUAD_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
