import { DAY_MS, createRng, hashString } from "./weathering.ts";

/** One entry of `public/streamers.json`. */
export interface Streamer {
  uid: string;
  name: string;
  /** Live room id; linked to live.bilibili.com. */
  roomId: string;
  /** "YYYY-MM-DD". */
  debutAt: string;
  graduatedAt: string;
  epitaph?: string;
  /** Oshi colour "#rrggbb"; derived from the uid when omitted. */
  color?: string;
  /** File name inside `public/face/`; a generated avatar is drawn when omitted or missing. */
  face?: string;
}

const PALETTE = [
  "#8fb8ff",
  "#ffb347",
  "#c38fff",
  "#ff8fb1",
  "#7fd8be",
  "#ffd86b",
  "#9ad0ff",
  "#f59e9e",
];

export function oshiColor(s: Streamer): string {
  return s.color ?? PALETTE[hashString(s.uid) % PALETTE.length]!;
}

export function faceUrl(s: Streamer): string | null {
  return s.face ? `${import.meta.env.BASE_URL}face/${encodeURIComponent(s.face)}` : null;
}

export function liveRoomUrl(s: Streamer): string {
  return `https://live.bilibili.com/${encodeURIComponent(s.roomId)}`;
}

/** "2025-08-31" -> "2025.08.31" */
export function formatDate(date: string): string {
  return date.replaceAll("-", ".");
}

/**
 * Validates raw JSON. Entries without a uid or name are dropped (with a
 * warning), numeric ids are accepted, and duplicate uids keep the first entry.
 */
export function normalizeStreamers(raw: unknown): Streamer[] {
  if (!Array.isArray(raw)) throw new TypeError("streamers.json must be an array");
  const seen = new Set<string>();
  const out: Streamer[] = [];
  raw.forEach((item, i) => {
    const r = (item ?? {}) as Record<string, unknown>;
    const str = (v: unknown) =>
      typeof v === "string" || typeof v === "number" ? String(v).trim() : "";
    const uid = str(r.uid);
    const name = str(r.name);
    if (!uid || !name) {
      console.warn(`streamers.json[${i}] skipped: uid and name are required`);
      return;
    }
    if (seen.has(uid)) {
      console.warn(`streamers.json[${i}] skipped: duplicate uid ${uid}`);
      return;
    }
    seen.add(uid);
    const s: Streamer = {
      uid,
      name,
      roomId: str(r.roomId),
      debutAt: str(r.debutAt),
      graduatedAt: str(r.graduatedAt),
    };
    const epitaph = str(r.epitaph);
    const color = str(r.color);
    const face = str(r.face);
    if (epitaph) s.epitaph = epitaph;
    if (/^#[0-9a-f]{6}$/i.test(color)) s.color = color;
    if (face) s.face = face;
    out.push(s);
  });
  return out;
}

export async function loadStreamers(): Promise<Streamer[]> {
  const res = await fetch(`${import.meta.env.BASE_URL}streamers.json`);
  if (!res.ok) throw new Error(`加载 streamers.json 失败：${res.status}`);
  return normalizeStreamers(await res.json());
}

const STORAGE_KEY = "vtb-grave:lastSweptAt";

/**
 * Stand-in for the shared backend: a real deployment stores one `lastSweptAt`
 * per uid on the server (no login needed, anyone can sweep). Graves never swept
 * on this device get a deterministic pseudo-random age so the demo cemetery
 * shows every stage of neglect.
 */
export function loadLastSwept(uid: string): number {
  const all = readAll();
  if (all[uid] !== undefined) return all[uid];
  const r = createRng(hashString(`${uid}:age`))();
  return Date.now() - Math.floor(r * r * 240) * DAY_MS;
}

export function saveLastSwept(uid: string, ts: number): void {
  const all = readAll();
  all[uid] = ts;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

export function resetAllSwept(): void {
  localStorage.removeItem(STORAGE_KEY);
}

function readAll(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}
