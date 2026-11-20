import { CanvasTexture, SRGBColorSpace } from "three";
import { createRng, hashString } from "../model/weathering.ts";
import { type Streamer, faceUrl, formatDate, oshiColor } from "../model/streamers.ts";
import { canvasPen, traceArch } from "./arch.ts";

const imageCache = new Map<string, Promise<HTMLImageElement | null>>();

/** Loads (once) an avatar; resolves null when the file is missing or broken. */
function loadImage(url: string): Promise<HTMLImageElement | null> {
  let p = imageCache.get(url);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = () => {
        console.warn(`头像加载失败，改用生成头像：${url}`);
        resolve(null);
      };
      img.src = url;
    });
    imageCache.set(url, p);
  }
  return p;
}

const SERIF = `"Noto Serif SC","Source Han Serif SC","Songti SC","STSong","SimSun",serif`;

export interface PanelShape {
  width: number;
  height: number;
  shoulder: number;
}

/**
 * Draws the polished inset panel (portrait, name, room, dates, epitaph) into a
 * canvas. Two textures come out: the colour map, and a "glow" map holding only
 * the gold inlay so it can catch the sunset as a faint emissive.
 */
export class Inscription {
  readonly map: CanvasTexture;
  readonly glow: CanvasTexture;
  private readonly mapCanvas = document.createElement("canvas");
  private readonly glowCanvas = document.createElement("canvas");
  private avatar: HTMLImageElement | null = null;
  private streamer: Streamer | null = null;
  private loadToken = 0;

  private readonly shape: PanelShape;

  /** `width` is the canvas width in px: small for the overview, large when focused. */
  constructor(shape: PanelShape, width: number) {
    this.shape = shape;
    const w = width;
    const h = Math.round((w * shape.height) / shape.width);
    for (const c of [this.mapCanvas, this.glowCanvas]) {
      c.width = w;
      c.height = h;
    }
    this.map = new CanvasTexture(this.mapCanvas);
    this.glow = new CanvasTexture(this.glowCanvas);
    for (const t of [this.map, this.glow]) {
      t.colorSpace = SRGBColorSpace;
      t.anisotropy = 8;
    }
  }

  setStreamer(streamer: Streamer): void {
    this.streamer = streamer;
    this.avatar = null;
    const token = ++this.loadToken;
    const url = faceUrl(streamer);
    if (url) {
      void loadImage(url).then((img) => {
        if (!img || token !== this.loadToken) return;
        this.avatar = img;
        this.redraw();
      });
    }
    this.redraw();
  }

  private redraw(): void {
    if (!this.streamer) return;
    this.paint(this.mapCanvas.getContext("2d")!, this.streamer, false);
    this.paint(this.glowCanvas.getContext("2d")!, this.streamer, true);
    this.map.needsUpdate = true;
    this.glow.needsUpdate = true;
  }

  private paint(ctx: CanvasRenderingContext2D, s: Streamer, glowOnly: boolean): void {
    const { width: W, height: H } = ctx.canvas;
    const k = W / 768; // fixed pixel sizes below were tuned at 768px
    const color = oshiColor(s);
    const { width: pw, height: ph, shoulder } = this.shape;
    const toPx = (x: number, y: number): [number, number] => [
      ((x + pw / 2) / pw) * W,
      (1 - y / ph) * H,
    ];
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";

    // Polished dark stone with speckles and anime-style diagonal gloss.
    if (glowOnly) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
    } else {
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, "#353047");
      bg.addColorStop(1, "#1f1c2b");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      const rng = createRng(hashString(s.uid));
      for (let i = 0; i < 1600 * k * k; i++) {
        ctx.fillStyle = `rgba(255,255,255,${0.03 + rng() * 0.09})`;
        ctx.fillRect(rng() * W, rng() * H, 1 + rng() * 2, 1 + rng() * 2);
      }
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (const [x, wBand, a] of [
        [0.18, 0.16, 0.07],
        [0.42, 0.05, 0.05],
      ] as const) {
        ctx.fillStyle = `rgba(255,240,255,${a})`;
        ctx.beginPath();
        ctx.moveTo(W * x, H);
        ctx.lineTo(W * (x + wBand), H);
        ctx.lineTo(W * (x + wBand + 0.7), 0);
        ctx.lineTo(W * (x + 0.7), 0);
        ctx.fill();
      }
      ctx.restore();
    }

    // Gold inlay border following the arch.
    const inset = pw * 0.05;
    ctx.beginPath();
    traceArch(
      canvasPen(ctx, (x, y) => toPx(x, y + inset)),
      pw - inset * 2,
      ph - inset * 2,
      shoulder - inset,
    );
    ctx.lineWidth = W * 0.008;
    ctx.strokeStyle = gold(ctx, 0, H);
    ctx.stroke();

    // Portrait.
    const cx = W / 2;
    const cy = H * 0.27;
    const rx = W * 0.2;
    const ry = W * 0.25;
    if (!glowOnly) {
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.clip();
      if (this.avatar) drawCover(ctx, this.avatar, cx - rx, cy - ry, rx * 2, ry * 2);
      else drawChibi(ctx, cx - rx, cy - ry, rx * 2, ry * 2, s.uid, color);
      ctx.restore();
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = W * 0.04;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx + W * 0.018, ry + W * 0.018, 0, 0, Math.PI * 2);
      ctx.lineWidth = W * 0.01;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.restore();
    }
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx + W * 0.006, ry + W * 0.006, 0, 0, Math.PI * 2);
    ctx.lineWidth = W * 0.014;
    ctx.strokeStyle = gold(ctx, cy - ry, cy + ry);
    ctx.stroke();

    // Name.
    const nameY = H * 0.58;
    const nameSize = fitFont(ctx, s.name, W * 0.8, W * 0.11, `700 {size}px ${SERIF}`, k);
    engrave(ctx, s.name, cx, nameY, nameSize, `700 ${nameSize}px ${SERIF}`, glowOnly);

    // Divider ornament.
    const divY = nameY + W * 0.05;
    const d = 12 * k;
    ctx.fillStyle = gold(ctx, divY - d, divY + d);
    ctx.fillRect(cx - W * 0.3, divY - 1.5 * k, W * 0.24, 3 * k);
    ctx.fillRect(cx + W * 0.06, divY - 1.5 * k, W * 0.24, 3 * k);
    ctx.beginPath();
    ctx.moveTo(cx, divY - d);
    ctx.lineTo(cx + d, divY);
    ctx.lineTo(cx, divY + d);
    ctx.lineTo(cx - d, divY);
    ctx.fill();

    const small = W * 0.045;
    const lines = [
      s.roomId ? `B站直播间 ${s.roomId}` : "",
      s.debutAt ? `出道  ${formatDate(s.debutAt)}` : "",
      s.graduatedAt ? `毕业  ${formatDate(s.graduatedAt)}` : "",
    ];
    [0.1, 0.19, 0.26].forEach((dy, i) => {
      if (lines[i])
        engrave(ctx, lines[i], cx, divY + W * dy, small, `500 ${small}px ${SERIF}`, glowOnly);
    });

    if (s.epitaph) {
      const epSize = fitFont(ctx, s.epitaph, W * 0.8, W * 0.042, `italic 400 {size}px ${SERIF}`, k);
      ctx.globalAlpha = 0.8;
      engrave(ctx, s.epitaph, cx, H * 0.93, epSize, `italic 400 ${epSize}px ${SERIF}`, glowOnly);
    }
    ctx.restore();
  }
}

function gold(ctx: CanvasRenderingContext2D, y0: number, y1: number): CanvasGradient {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, "#fff1b8");
  g.addColorStop(0.45, "#d9a54a");
  g.addColorStop(0.55, "#b8822f");
  g.addColorStop(1, "#f5d687");
  return g;
}

/** Gold-filled carved letters: dark lip on top, faint highlight below. */
function engrave(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  font: string,
  glowOnly: boolean,
): void {
  ctx.font = font;
  if (!glowOnly) {
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillText(text, x, y - size * 0.05);
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    ctx.fillText(text, x, y + size * 0.05);
  }
  ctx.fillStyle = gold(ctx, y - size, y + size * 0.15);
  ctx.fillText(text, x, y);
}

function fitFont(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  size: number,
  template: string,
  k: number,
): number {
  let s = size;
  ctx.font = template.replace("{size}", String(s));
  while (s > 12 * k && ctx.measureText(text).width > maxWidth) {
    s -= 2 * k;
    ctx.font = template.replace("{size}", String(s));
  }
  return s;
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const iw = img.naturalWidth * scale;
  const ih = img.naturalHeight * scale;
  ctx.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
}

/** Placeholder chibi portrait in the streamer's oshi colour. */
function drawChibi(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  seed: string,
  color: string,
): void {
  const cx = x + w / 2;
  const hair = shade(color, -0.45);
  const rng = createRng(hashString(`${seed}:chibi`));

  const bg = ctx.createRadialGradient(cx, y + h * 0.35, w * 0.1, cx, y + h * 0.5, w * 0.8);
  bg.addColorStop(0, shade(color, 0.6));
  bg.addColorStop(1, color);
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  for (let i = 0; i < 14; i++) star(ctx, x + rng() * w, y + rng() * h * 0.6, 3 + rng() * 6);

  const faceY = y + h * 0.52;
  // Back hair and shoulders.
  ctx.fillStyle = hair;
  ctx.beginPath();
  ctx.ellipse(cx, faceY - h * 0.04, w * 0.4, h * 0.36, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(cx - w * 0.4, faceY - h * 0.04, w * 0.8, h * 0.4);
  ctx.fillStyle = shade(color, -0.15);
  ctx.beginPath();
  ctx.ellipse(cx, y + h * 1.02, w * 0.42, h * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.08, y + h * 0.83);
  ctx.lineTo(cx, y + h * 0.92);
  ctx.lineTo(cx + w * 0.08, y + h * 0.83);
  ctx.fill();

  // Face.
  ctx.fillStyle = "#ffeadf";
  ctx.beginPath();
  ctx.ellipse(cx, faceY + h * 0.04, w * 0.28, h * 0.25, 0, 0, Math.PI * 2);
  ctx.fill();

  // Bangs.
  ctx.fillStyle = hair;
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.34, faceY);
  const tips = 7;
  for (let i = 0; i <= tips; i++) {
    const t = i / tips;
    const bx = cx - w * 0.32 + t * w * 0.64;
    const dip = i % 2 === 0 ? 0.02 : 0.11 + rng() * 0.04;
    ctx.lineTo(bx, faceY - h * 0.08 + h * dip);
  }
  ctx.lineTo(cx + w * 0.34, faceY);
  ctx.lineTo(cx + w * 0.3, faceY - h * 0.3);
  ctx.lineTo(cx - w * 0.3, faceY - h * 0.3);
  ctx.fill();
  // Ahoge.
  ctx.strokeStyle = hair;
  ctx.lineWidth = w * 0.025;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx, faceY - h * 0.38);
  ctx.quadraticCurveTo(cx + w * 0.12, faceY - h * 0.5, cx + w * 0.05, faceY - h * 0.52);
  ctx.stroke();

  // Eyes.
  for (const side of [-1, 1]) {
    const ex = cx + side * w * 0.11;
    const ey = faceY + h * 0.07;
    ctx.fillStyle = "#3a2a4a";
    ctx.beginPath();
    ctx.ellipse(ex, ey, w * 0.055, h * 0.075, 0, 0, Math.PI * 2);
    ctx.fill();
    const iris = ctx.createLinearGradient(0, ey - h * 0.05, 0, ey + h * 0.07);
    iris.addColorStop(0, shade(color, -0.3));
    iris.addColorStop(1, shade(color, 0.3));
    ctx.fillStyle = iris;
    ctx.beginPath();
    ctx.ellipse(ex, ey + h * 0.012, w * 0.042, h * 0.058, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(ex - w * 0.018, ey - h * 0.03, w * 0.017, 0, Math.PI * 2);
    ctx.arc(ex + w * 0.02, ey + h * 0.03, w * 0.008, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,130,150,0.45)";
    ctx.beginPath();
    ctx.ellipse(ex + side * w * 0.04, ey + h * 0.09, w * 0.045, h * 0.02, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = "#a0525e";
  ctx.lineWidth = w * 0.012;
  ctx.beginPath();
  ctx.arc(cx, faceY + h * 0.15, w * 0.025, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.quadraticCurveTo(x, y, x, y + r);
  ctx.quadraticCurveTo(x, y, x - r, y);
  ctx.quadraticCurveTo(x, y, x, y - r);
  ctx.fill();
}

/** Lighten (amount > 0) or darken (amount < 0) a #rrggbb colour. */
export function shade(hex: string, amount: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount)),
  );
  return `rgb(${ch.join(",")})`;
}
