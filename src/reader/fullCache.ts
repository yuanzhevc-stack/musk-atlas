/** Ask the Worker to cache a full YouTube lesson, then read the verified result.
 *  The browser never downloads or uploads the video. A missing Worker is a status, not a spinner. */
import { lessonCache, readChoice, type SourceChoice } from "./hostedLesson";

const TTS_URL = "https://musk-atlas-tts.yuanzhevc.workers.dev";

export const PUBLIC_BASE = "https://pub-ad0e50befa7b4387a7d73a8c8a796eb3.r2.dev";
export const fullMediaUrl = (v: string) => `${PUBLIC_BASE}/full/${v}.mp4`;

export type JobStatus = "queued" | "running" | "ready" | "refused" | "failed";

export interface CacheView {
  v: string;
  status: JobStatus | "unknown";
  runner: "configured" | "missing" | "unreachable";
  verified: boolean;
  bytes?: number;
  duration?: number;
  url?: string;
  error?: string;
}

const JOB_KEY = "musk-atlas:full-job:v1";
const READY_KEY = "musk-atlas:full-ready:v1";

type JobStore = { version: 1; byVideo: Record<string, CacheView> };
type ReadyStore = { version: 1; byVideo: Record<string, { url: string; bytes: number; duration: number }> };

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as T;
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* the visit still uses the value in memory */
  }
}

export function rememberedReady(videoId: string): { url: string; bytes: number; duration: number } | null {
  const store = readJson<ReadyStore>(READY_KEY, { version: 1, byVideo: {} });
  const rec = store.byVideo?.[videoId];
  if (!rec || rec.url !== fullMediaUrl(videoId) || rec.url.includes("/clips/")) return null;
  if (rec.bytes < 2_000_000 || rec.duration < 20) return null;
  return rec;
}

export function rememberReady(videoId: string, bytes: number, duration: number) {
  const store = readJson<ReadyStore>(READY_KEY, { version: 1, byVideo: {} });
  if (!store.byVideo) store.byVideo = {};
  store.version = 1;
  store.byVideo[videoId] = { url: fullMediaUrl(videoId), bytes, duration };
  writeJson(READY_KEY, store);
}

export function forgetReady(videoId: string) {
  const store = readJson<ReadyStore>(READY_KEY, { version: 1, byVideo: {} });
  if (store.byVideo) delete store.byVideo[videoId];
  writeJson(READY_KEY, store);
}

export function openingSource(videoId: string): SourceChoice {
  if (readChoice(videoId) === "online") return "online";
  if (rememberedReady(videoId)) return "local";
  if (lessonCache(videoId).kind === "full") return "local";
  return "online";
}

/** A visit that already started on YouTube stays there. The next open uses the cache. */
export function adoptReady(started: SourceChoice, phase: "loading" | "playing" | "paused" | "other", ready: boolean, kept = false): "online" | "stay" {
  if (!ready && !kept && started === "local" && phase === "loading") return "online";
  return "stay";
}

function viewFrom(raw: Partial<CacheView> & { v?: string }, fallback: string): CacheView {
  const v = raw.v || fallback;
  const verified =
    raw.status === "ready" &&
    typeof raw.bytes === "number" &&
    raw.bytes >= 2_000_000 &&
    typeof raw.duration === "number" &&
    raw.duration >= 20 &&
    !(raw.url || "").includes("/clips/");
  return {
    v,
    status: raw.status ?? "unknown",
    runner: raw.runner ?? "unreachable",
    verified,
    bytes: raw.bytes,
    duration: raw.duration,
    url: verified ? fullMediaUrl(v) : undefined,
    error: raw.error,
  };
}

export function cacheStatusLine(view: CacheView | null, playingLocal: boolean): string {
  if (playingLocal) return "本地 · 已缓存的整段";
  if (!view || view.status === "unknown") {
    if (view?.runner === "unreachable") return "缓存服务还没接上，先用在线。不会从这台设备选文件。";
    return "这节课还没有整段缓存，先用在线。";
  }
  if (view.status === "ready" && view.verified) return "整段已缓存。这次继续在线，下次打开用本地。";
  if (view.status === "queued" && view.runner === "missing") return "已记下这节课。下载机还没接上，先用在线。";
  if (view.status === "queued") return "已排队缓存整段，先用在线。";
  if (view.status === "running") return "正在下载整段，先用在线。";
  if (view.status === "refused") return "YouTube 拒绝了下载。先用在线。不会绕过这个检查。";
  if (view.error === "daily-cap") return "今天的缓存额度用完了，先用在线。";
  return "缓存没有做成，已停止重试。先用在线。";
}

function rememberJob(view: CacheView) {
  const store = readJson<JobStore>(JOB_KEY, { version: 1, byVideo: {} });
  if (!store.byVideo) store.byVideo = {};
  store.version = 1;
  store.byVideo[view.v] = view;
  writeJson(JOB_KEY, store);
  if (view.verified && view.bytes && view.duration) rememberReady(view.v, view.bytes, view.duration);
}

export function rememberedJob(videoId: string): CacheView | null {
  const store = readJson<JobStore>(JOB_KEY, { version: 1, byVideo: {} });
  return store.byVideo?.[videoId] ?? null;
}

async function readBody(res: Response, v: string): Promise<CacheView> {
  const raw = (await res.json().catch(() => ({}))) as Partial<CacheView>;
  if (res.status === 429) return viewFrom({ ...raw, v, status: "failed", error: "daily-cap", runner: raw.runner ?? "configured" }, v);
  return viewFrom(raw, v);
}

export async function enqueueFullCache(v: string, fetchImpl: typeof fetch = fetch): Promise<CacheView> {
  try {
    const res = await fetchImpl(`${TTS_URL}/full/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ v }),
    });
    const view = await readBody(res, v);
    rememberJob(view);
    return view;
  } catch {
    const view: CacheView = { v, status: "unknown", runner: "unreachable", verified: false };
    rememberJob(view);
    return view;
  }
}

export async function readFullCache(v: string, fetchImpl: typeof fetch = fetch): Promise<CacheView> {
  try {
    const res = await fetchImpl(`${TTS_URL}/full/jobs?v=${encodeURIComponent(v)}`);
    if (res.ok || res.status === 429) {
      const view = await readBody(res, v);
      rememberJob(view);
      return view;
    }
  } catch {
    /* the public record is the fallback */
  }
  try {
    const pub = await fetchImpl(`${PUBLIC_BASE}/full/ready/${v}.json`, { cache: "no-store" });
    if (!pub.ok) return rememberedJob(v) ?? { v, status: "unknown", runner: "unreachable", verified: false };
    const rec = (await pub.json()) as { bytes?: number; duration?: number; url?: string };
    const view = viewFrom({ v, status: "ready", runner: "configured", bytes: rec.bytes, duration: rec.duration, url: rec.url }, v);
    rememberJob(view);
    return view;
  } catch {
    return rememberedJob(v) ?? { v, status: "unknown", runner: "unreachable", verified: false };
  }
}
