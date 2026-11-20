import {
  MOUSE,
  PCFShadowMap,
  PerspectiveCamera,
  Raycaster,
  Scene,
  TOUCH,
  Timer,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { type Streamer, saveLastSwept } from "../model/streamers.ts";
import { DAY_MS, type Weathering } from "../model/weathering.ts";
import { Cemetery } from "./cemetery.ts";
import { type Environment, buildEnvironment } from "./environment.ts";
import type { TimeUniform } from "./grass.ts";
import { Inscription } from "./inscription.ts";
import { PostPipeline } from "./post.ts";
import {
  CleanMask,
  GRAVE_HEIGHT,
  OUTLINE_LAYER,
  PANEL_SHAPE,
  type Tombstone,
} from "./tombstone.ts";

export interface GraveStatus {
  streamer: Streamer;
  weathering: Weathering;
  /** 0..1 progress of this visit's wiping. */
  cleaned: number;
  needsWipe: boolean;
  weeds: number;
}

/** Fraction of the stone that must be wiped before a visit counts. */
const CLEAN_TARGET = 0.8;
/** Camera placement relative to a focused grave: between it and the next row. */
const FOCUS_OFFSET = new Vector3(0.8, 1.45, 3.75);
const FOCUS_LOOK = new Vector3(0, 1.05, 0);
/** Pointer travel (px) under which a press counts as a click, not a drag. */
const CLICK_SLOP = 6;

interface Tween {
  fromPos: Vector3;
  toPos: Vector3;
  fromTarget: Vector3;
  toTarget: Vector3;
  start: number;
  duration: number;
}

export class GraveApp {
  onStatus: (s: GraveStatus | null) => void = () => {};
  onSwept: (s: Streamer) => void = () => {};
  onFocusChange: (s: Streamer | null) => void = () => {};
  /** Hovered grave label position in CSS px, or null. */
  onHover: (s: Streamer | null, x: number, y: number) => void = () => {};

  private readonly container: HTMLElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(35, 1, 0.1, 600);
  private readonly controls: OrbitControls;
  private readonly post = new PostPipeline(OUTLINE_LAYER);
  private readonly cemetery: Cemetery;
  private readonly env: Environment;
  private readonly timer = new Timer();
  private readonly time: TimeUniform = { value: 0 };
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly mask = new CleanMask();
  private readonly hiRes = new Inscription(PANEL_SHAPE, 768);
  private readonly extent: number;
  private readonly home: { pos: Vector3; target: Vector3 };

  private focused: Tombstone | null = null;
  /** Where the visitor was in the overview before focusing, to fly back to. */
  private returnView: { pos: Vector3; target: Vector3 } | null = null;
  private hovered: Tombstone | null = null;
  private tween: Tween | null = null;
  private offsetDays = 0;
  private cleaned = 0;
  private wiping = false;
  private down: { x: number; y: number } | null = null;
  private lastRatioCheck = 0;

  constructor(container: HTMLElement, streamers: readonly Streamer[]) {
    this.container = container;
    this.renderer = new WebGLRenderer({ antialias: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    container.appendChild(this.renderer.domElement);

    this.cemetery = new Cemetery(streamers, this.time);
    this.scene.add(this.cemetery.group);
    const b = this.cemetery.bounds;
    const halfW = (b.maxX - b.minX) / 2;
    const halfD = (b.maxZ - b.minZ) / 2;
    this.extent = Math.hypot(halfW, halfD);
    this.env = buildEnvironment(this.scene, this.extent);

    // Registered before OrbitControls so a press on the stone can disable orbiting.
    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("pointercancel", this.onPointerUp);
    el.addEventListener("pointerleave", () => this.setHovered(null));
    el.addEventListener("contextmenu", (e) => e.preventDefault());

    this.controls = new OrbitControls(this.camera, el);
    this.controls.enableDamping = true;

    // Frame the whole cemetery from the front, looking down ~29° so the sky shows.
    const aspect = container.clientWidth / Math.max(1, container.clientHeight);
    const tanHalf = Math.tan((this.camera.fov * Math.PI) / 360);
    const dist = Math.max(halfW / (tanHalf * aspect), halfD / tanHalf) * 0.95 + 4;
    const center = new Vector3((b.minX + b.maxX) / 2, 0.5, (b.minZ + b.maxZ) / 2);
    const pitch = 0.5;
    this.home = {
      pos: center.clone().add(new Vector3(0, Math.sin(pitch) * dist, Math.cos(pitch) * dist)),
      target: center,
    };
    this.camera.position.copy(this.home.pos);
    this.controls.target.copy(this.home.target);
    this.configureOverview();

    this.refresh();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(this.frame);
  }

  /** Fly to a grave by uid. Returns false when no such grave exists. */
  focus(uid: string): boolean {
    const grave = this.cemetery.get(uid);
    if (!grave) return false;
    this.focusGrave(grave);
    return true;
  }

  /** Leave the focused grave and fly back to where the visitor was. */
  overview(): void {
    if (!this.focused) return;
    this.leaveFocused();
    this.configureOverview();
    const back = this.returnView ?? this.home;
    this.flyTo(back.pos, back.target);
    this.returnView = null;
    this.onFocusChange(null);
    this.onStatus(null);
  }

  /** Debug: pretend this many days have passed since now. */
  setTimeOffset(days: number): void {
    this.offsetDays = days;
    this.refresh();
  }

  /** Re-read persisted sweep times (after a reset). */
  reload(lastSwept: (uid: string) => number): void {
    for (const g of this.cemetery.graves) g.lastSweptAt = lastSwept(g.streamer.uid);
    this.refresh();
  }

  setOutline(on: boolean): void {
    this.post.outline = on;
  }

  setDof(on: boolean): void {
    this.post.dof = on;
  }

  setPetals(on: boolean): void {
    this.env.setPetals(on);
  }

  private now(): number {
    return Date.now() + this.offsetDays * DAY_MS;
  }

  private refresh(): void {
    this.cemetery.update(this.now());
    this.emitStatus();
  }

  private focusGrave(grave: Tombstone): void {
    if (this.focused === grave) return;
    if (!this.focused) {
      this.returnView = { pos: this.camera.position.clone(), target: this.controls.target.clone() };
    }
    this.leaveFocused();
    this.focused = grave;
    this.cleaned = 0;
    this.mask.reset();
    grave.attachMask(this.mask);
    this.hiRes.setStreamer(grave.streamer);
    grave.showInscription(this.hiRes);
    this.setHovered(null);
    this.configureFocus();
    const p = grave.group.position;
    this.flyTo(p.clone().add(FOCUS_OFFSET), p.clone().add(FOCUS_LOOK));
    this.onFocusChange(grave.streamer);
    this.emitStatus();
  }

  private leaveFocused(): void {
    const g = this.focused;
    if (!g) return;
    g.attachMask(null);
    g.showInscription(null);
    g.weeds.resetPlucks();
    this.focused = null;
  }

  private configureOverview(): void {
    const c = this.controls;
    c.enablePan = true;
    c.screenSpacePanning = false;
    c.zoomToCursor = true;
    c.mouseButtons = { LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE };
    c.touches = { ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_ROTATE };
    c.minDistance = 4;
    c.maxDistance = this.home.pos.distanceTo(this.home.target) * 1.6;
    c.minPolarAngle = 0.3;
    c.maxPolarAngle = 1.3;
    c.minAzimuthAngle = -1.2;
    c.maxAzimuthAngle = 1.2;
  }

  private configureFocus(): void {
    const c = this.controls;
    c.enablePan = false;
    c.zoomToCursor = false;
    c.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE };
    c.touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_ROTATE };
    c.minDistance = 1.8;
    c.maxDistance = 3.9;
    c.minPolarAngle = 0.6;
    c.maxPolarAngle = 1.5;
    c.minAzimuthAngle = -0.8;
    c.maxAzimuthAngle = 0.8;
  }

  private flyTo(pos: Vector3, target: Vector3): void {
    const travel = this.camera.position.distanceTo(pos);
    this.tween = {
      fromPos: this.camera.position.clone(),
      toPos: pos,
      fromTarget: this.controls.target.clone(),
      toTarget: target,
      start: performance.now(),
      duration: Math.min(1800, Math.max(800, travel * 70)),
    };
    this.controls.enabled = false;
  }

  private needsWipe(): boolean {
    const w = this.focused?.current;
    return !!w && (w.dust > 0.08 || w.moss > 0.02);
  }

  private emitStatus(): void {
    const g = this.focused;
    if (!g) return;
    this.onStatus({
      streamer: g.streamer,
      weathering: g.current,
      cleaned: this.needsWipe() ? Math.min(1, this.cleaned / CLEAN_TARGET) : 1,
      needsWipe: this.needsWipe(),
      weeds: g.weeds.visibleClumps(),
    });
  }

  /** Called after any sweeping action: completes the visit once everything is tidy. */
  private checkDone(): void {
    const g = this.focused;
    if (!g) return;
    const wiped = !this.needsWipe() || this.cleaned >= CLEAN_TARGET;
    if (wiped && g.weeds.visibleClumps() === 0) {
      g.lastSweptAt = this.now();
      saveLastSwept(g.streamer.uid, g.lastSweptAt);
      g.update(this.now());
      g.weeds.resetPlucks();
      this.mask.reset();
      this.cleaned = 0;
      this.emitStatus();
      this.onSwept(g.streamer);
    } else {
      this.emitStatus();
    }
  }

  private setPointer(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  private hitStone() {
    if (!this.focused) return null;
    return this.raycaster.intersectObjects(this.focused.stoneMeshes, false)[0] ?? null;
  }

  private setHovered(g: Tombstone | null): void {
    this.hovered = g;
    if (!g) this.onHover(null, 0, 0);
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    this.down = { x: e.clientX, y: e.clientY };
    if (!this.focused || this.tween) return;
    this.setPointer(e);
    const stone = this.hitStone();
    const weed = this.focused.weeds.pick(this.raycaster.ray);
    if (weed && (!stone || weed.distance < stone.distance + 0.15)) {
      this.controls.enabled = false;
      this.focused.weeds.pluck(weed.index, this.time.value);
      this.checkDone();
      return;
    }
    if (stone) {
      this.controls.enabled = false;
      this.wiping = true;
      this.renderer.domElement.setPointerCapture(e.pointerId);
      this.mask.wipeAt(this.focused.toLocal(stone.point));
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    this.setPointer(e);
    if (this.wiping && this.focused) {
      const stone = this.hitStone();
      if (stone) this.mask.wipeAt(this.focused.toLocal(stone.point));
      const t = performance.now();
      if (t - this.lastRatioCheck > 150) {
        this.lastRatioCheck = t;
        this.cleaned = this.mask.ratio();
        this.emitStatus();
      }
      return;
    }
    if (e.buttons !== 0 || this.tween) return;
    let cursor = "";
    let hover: Tombstone | null = null;
    if (this.focused && this.focused.weeds.pick(this.raycaster.ray)) cursor = "grab";
    else if (this.hitStone()) cursor = "crosshair";
    else {
      const pick = this.cemetery.pick(this.raycaster.ray);
      if (pick && pick.grave !== this.focused) {
        hover = pick.grave;
        cursor = "pointer";
      }
    }
    this.setHovered(hover);
    this.renderer.domElement.style.cursor = cursor;
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.tween) this.controls.enabled = true;
    const down = this.down;
    this.down = null;
    if (this.wiping) {
      this.wiping = false;
      this.cleaned = this.mask.ratio();
      this.checkDone();
      return;
    }
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP) return;
    this.setPointer(e);
    const pick = this.cemetery.pick(this.raycaster.ray);
    if (pick && pick.grave !== this.focused) this.focusGrave(pick.grave);
  };

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    this.renderer.setSize(w, h);
    this.post.setSize(w, h, this.renderer.getPixelRatio());
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private updateCamera(): void {
    const tw = this.tween;
    if (tw) {
      const t = Math.min(1, (performance.now() - tw.start) / tw.duration);
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      this.camera.position.lerpVectors(tw.fromPos, tw.toPos, e);
      this.controls.target.lerpVectors(tw.fromTarget, tw.toTarget, e);
      this.camera.lookAt(this.controls.target);
      if (t >= 1) {
        this.tween = null;
        this.controls.enabled = true;
        this.controls.update();
      }
      return;
    }
    this.controls.update();
    if (!this.focused) {
      // Keep overview panning over the cemetery.
      const b = this.cemetery.bounds;
      const t = this.controls.target;
      const dx = Math.min(b.maxX + 2, Math.max(b.minX - 2, t.x)) - t.x;
      const dz = Math.min(b.maxZ + 2, Math.max(b.minZ - 2, t.z)) - t.z;
      if (dx || dz) {
        t.x += dx;
        t.z += dz;
        this.camera.position.x += dx;
        this.camera.position.z += dz;
      }
    }
  }

  private frame = (timestamp: number): void => {
    this.timer.update(timestamp);
    const dt = Math.min(0.1, this.timer.getDelta());
    this.time.value = this.timer.getElapsed();
    this.updateCamera();

    // Ease depth of field in and out; keep the focused grave on the focal plane.
    const want = this.focused ? 1 : 0;
    this.post.focusAmount += (want - this.post.focusAmount) * Math.min(1, dt * 2.5);
    if (this.focused) {
      const p = this.focused.group.position.clone().add(FOCUS_LOOK);
      const forward = this.camera.getWorldDirection(new Vector3());
      this.post.focusDistance = p.sub(this.camera.position).dot(forward);
    }

    if (this.hovered) {
      const top = this.hovered.group.position.clone();
      top.y += GRAVE_HEIGHT + 0.25;
      top.project(this.camera);
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.onHover(
        this.hovered.streamer,
        rect.left + ((top.x + 1) / 2) * rect.width,
        rect.top + ((1 - top.y) / 2) * rect.height,
      );
    }

    const radius = this.focused ? 5 : this.extent + 4;
    this.env.update(this.time.value, this.camera.position, this.controls.target, radius);
    this.post.render(this.renderer, this.scene, this.camera);
  };
}
