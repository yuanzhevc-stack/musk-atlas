/** Ask the Worker to cache a full YouTube lesson, then read the verified result.
 *  The browser never downloads or uploads the video. A missing Worker is a status, not a spinner. */
import { lessonCache, type SourceChoice } from "./hostedLesson";

const TTS_URL = "https://musk-atlas-tts.yuanzhevc.workers.dev";

export const PUBLIC_BASE = "https://pub-ad0e50befa7b4387a7d73a8c8a796eb3.r2.dev";
/** Bump when a stored file is replaced, so the browser does not keep the previous bytes. */
const MEDIA_REV: Record<string, string> = { kmyvBlKYfic: "2" };
export const fullMediaUrl = (v: string) => {
  const base = `${PUBLIC_BASE}/full/${v}.mp4`;
  const rev = MEDIA_REV[v];
  return rev ? `${base}?r=${rev}` : base;
};

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
  height?: number;
  fps?: number;
  vcodec?: string;
  acodec?: string;
  progress?: { phase: "download" | "upload"; received: number; total?: number };
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
  const expected = fullMediaUrl(videoId);
  const bare = (url: string) => url.split("?")[0];
  if (!rec || bare(rec.url) !== bare(expected) || rec.url.includes("/clips/")) return null;
  if (rec.bytes < 2_000_000) return null;
  if (rec.duration > 0 && rec.duration < 20) return null;
  if (rec.url !== expected) {
    rec.url = expected;
    writeJson(READY_KEY, store);
  }
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
  if (rememberedReady(videoId) || lessonCache(videoId).kind === "full") return "local";
  return "online";
}

/** Use the stored full file as soon as it is verified. A missing file falls back to YouTube. */
export function adoptReady(started: SourceChoice, phase: "loading" | "playing" | "paused" | "other", ready: boolean, kept = false): "online" | "local" | "stay" {
  if (ready || kept) return "local";
  if (started === "local" && phase === "loading") return "online";
  return "stay";
}

function viewFrom(raw: Partial<CacheView> & { v?: string }, fallback: string): CacheView {
  const v = raw.v || fallback;
  const big = typeof raw.bytes === "number" && raw.bytes >= 2_000_000;
  const longEnough = raw.duration == null || (typeof raw.duration === "number" && raw.duration >= 20);
  const verified =
    raw.status === "ready" &&
    big &&
    longEnough &&
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
    height: typeof raw.height === "number" ? raw.height : undefined,
    fps: typeof raw.fps === "number" ? raw.fps : undefined,
    vcodec: typeof raw.vcodec === "string" ? raw.vcodec : undefined,
    acodec: typeof raw.acodec === "string" ? raw.acodec : undefined,
    progress: progressOf(raw.progress),
  };
}

function picture(view: CacheView): string {
  if (!view.height) return "";
  const codecs = [view.vcodec, view.acodec].filter(Boolean).join("/");
  return `实际 ${view.height}p${view.fps ? ` ${view.fps}fps` : ""}${codecs ? ` ${codecs}` : ""}`;
}

function progressOf(raw: CacheView["progress"] | undefined): CacheView["progress"] {
  if (!raw || typeof raw.received !== "number" || raw.received < 0) return undefined;
  const total = typeof raw.total === "number" && raw.total > 0 ? raw.total : undefined;
  return { phase: raw.phase === "upload" ? "upload" : "download", received: raw.received, total };
}

/** 0–100 when the download has reported a size. Null means nothing is moving. */
export function downloadPercent(progress: CacheView["progress"]): number | null {
  if (!progress?.total) return null;
  return Math.max(0, Math.min(100, Math.round((progress.received / progress.total) * 100)));
}

export function cacheStatusLine(view: CacheView | null, playingLocal: boolean): string {
  if (playingLocal) return "本地 · 已缓存的整段";
  if (!view || view.status === "unknown") {
    if (view?.runner === "unreachable") return "缓存服务还没接上，先用在线。不会从这台设备选文件。";
    return "这节课还没有整段缓存，先用在线。";
  }
  if (view.status === "queued" && view.runner === "missing") return "已记下这节课。下载机还没接上，先用在线。";
  if (view.status === "queued") return "已排队。目标不超过 720p、优先 30 帧的 H.264/AAC。先用在线。";
  if (view.status === "running") {
    const pct = downloadPercent(view.progress);
    if (pct == null) return "下载停着，没有进度。先用在线。";
    const what = view.progress?.phase === "upload" ? "正在上传" : "正在下载";
    return `${what} ${pct}%。先用在线。`;
  }
  if (view.status === "refused") return "YouTube 拒绝了下载。先用在线。不会绕过这个检查。";
  if (view.error === "daily-cap") return "今天的缓存额度用完了，先用在线。";
  if (view.error === "retry-cap") return "这节课的手动重试次数已经用完。先用在线。";
  if (view.status === "ready" && view.verified) {
    const seen = picture(view);
    return seen ? `整段已在存储，${seen}。` : "整段已在存储。";
  }
  const why = publicError(view.error);
  if (why === "ejs-missing") return "下载机缺少 yt-dlp-ejs，没有请求视频。先用在线。";
  if (why === "deno-missing") return "下载机缺少 deno，没有请求视频。先用在线。";
  if (why === "above-720") return "成片高于 720p，已拒绝，没有上传。先用在线。";
  if (why === "unmeasured-height") return "没有量到画面高度，已拒绝，没有上传。先用在线。";
  if (why) return `缓存没有做成：${why}。先用在线。`;
  return "缓存没有做成，已停止重试。先用在线。";
}

/** Visible failure text. Credential-shaped fragments are removed. */
export function publicError(error: string | undefined): string {
  if (!error) return "";
  return error
    .replace(/bearer\s+\S+/gi, "")
    .replace(/(secret|token|authorization|api[_-]?key)\s*[=:]\s*\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function rememberJob(view: CacheView) {
  const store = readJson<JobStore>(JOB_KEY, { version: 1, byVideo: {} });
  if (!store.byVideo) store.byVideo = {};
  store.version = 1;
  store.byVideo[view.v] = view;
  writeJson(JOB_KEY, store);
  if (view.verified && view.bytes) rememberReady(view.v, view.bytes, view.duration && view.duration >= 20 ? view.duration : 0);
}

export function rememberedJob(videoId: string): CacheView | null {
  const store = readJson<JobStore>(JOB_KEY, { version: 1, byVideo: {} });
  return store.byVideo?.[videoId] ?? null;
}

async function readBody(res: Response, v: string): Promise<CacheView> {
  const raw = (await res.json().catch(() => ({}))) as Partial<CacheView>;
  if (res.status === 429) return viewFrom({ ...raw, v, status: raw.status ?? "failed", error: raw.error ?? "daily-cap", runner: raw.runner ?? "configured" }, v);
  return viewFrom(raw, v);
}

export async function retryFullCache(v: string, fetchImpl: typeof fetch = fetch): Promise<CacheView> {
  try {
    const res = await fetchImpl(`${TTS_URL}/full/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ v, origin: "manual", retry: true }),
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

export async function enqueueFullCache(v: string, fetchImpl: typeof fetch = fetch): Promise<CacheView> {
  try {
    const res = await fetchImpl(`${TTS_URL}/full/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ v, origin: "manual" }),
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

function objectBytes(res: Response): number | null {
  const range = res.headers.get("content-range") ?? "";
  const total = range.match(/\/(\d+)\s*$/);
  if (total) return Number(total[1]);
  const len = Number(res.headers.get("content-length"));
  if (res.ok && Number.isFinite(len) && len >= 2_000_000) return len;
  return null;
}

/** A file already in storage wins over a job that still says it is downloading. */
async function storedFile(v: string, fetchImpl: typeof fetch): Promise<CacheView | null> {
  try {
    const pub = await fetchImpl(`${PUBLIC_BASE}/full/ready/${v}.json`, { cache: "no-store" });
    if (pub.ok) {
      const rec = (await pub.json().catch(() => null)) as { bytes?: number; duration?: number; url?: string } | null;
      if (rec) {
        const view = viewFrom({ v, status: "ready", runner: "configured", bytes: rec.bytes, duration: rec.duration, url: rec.url || fullMediaUrl(v) }, v);
        if (view.verified) return view;
      }
    }
  } catch {
    /* the object itself is the other way to know */
  }
  try {
    const head = await fetchImpl(fullMediaUrl(v), { method: "HEAD", cache: "no-store" });
    const bytes = objectBytes(head);
    if (bytes == null) return null;
    const view = viewFrom({ v, status: "ready", runner: "configured", bytes, url: fullMediaUrl(v) }, v);
    return view.verified ? view : null;
  } catch {
    return null;
  }
}

export async function readFullCache(v: string, fetchImpl: typeof fetch = fetch): Promise<CacheView> {
  let job: CacheView | null = null;
  try {
    const res = await fetchImpl(`${TTS_URL}/full/jobs?v=${encodeURIComponent(v)}`);
    if (res.ok || res.status === 429) job = await readBody(res, v);
  } catch {
    /* the public file is the fallback */
  }
  if (job?.verified) {
    rememberJob(job);
    return job;
  }
  const stored = await storedFile(v, fetchImpl);
  if (stored) {
    rememberJob(stored);
    return stored;
  }
  if (job) {
    rememberJob(job);
    return job;
  }
  return rememberedJob(v) ?? { v, status: "unknown", runner: "unreachable", verified: false };
}
