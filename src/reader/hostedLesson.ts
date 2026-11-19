/** Hosted lesson video versus sentence clips.
 *  The public bucket has sentence clips at clips/{youtubeId}/{startMs}.mp4.
 *  Those are a few seconds each. They are not a full lesson, and this module
 *  never returns one of those URLs as the lesson source.
 *  FULL_LESSON_URLS stays empty until a real full-file map exists. */

const DEFAULT_CLIP_BASE = "https://pub-ad0e50befa7b4387a7d73a8c8a796eb3.r2.dev";

function clipBase(): string {
  const env = (import.meta as { env?: { VITE_CLIP_BASE?: string } }).env;
  return env?.VITE_CLIP_BASE || DEFAULT_CLIP_BASE;
}

/** YouTube ids in public/musk/index/manifest.json. Each has sentence clips only. */
export const CLIP_VIDEO_IDS: readonly string[] = [
  "0ygRqjBQAUk",
  "5nMQ0-1jqFs",
  "8vBqtKQx7jg",
  "KnXee-GN8AE",
  "SiIWcoeWeN8",
  "U3Y32ADCjLo",
  "afZTrfvB2AQ",
  "ao5OdiwKp5k",
  "bUYY3QT82B8",
  "cdZZpaB2kDM",
  "eb3pmifEZ44",
  "gVwmNaPsxLc",
  "ktkV0N0Oask",
  "n1j0yHOxcL0",
  "s3RlCVtQ6mA",
  "s9mczdODqzo",
  "uoNIrv_2UIQ",
  "x3tlVE_QXm4",
  "zIwLWfaAg-8",
  "zfwK5BvZrY4",
];

/** Full-lesson files already on the public cache, keyed by YouTube id.
 *  Probed 2026-11-19: no full mp4 for cdZZpaB2kDM at the bucket root, videos/,
 *  full/, lessons/, source/, watch/, or clips/{id}.mp4. The one object that
 *  exists, clips/cdZZpaB2kDM/140239.mp4, is a 136KB sentence clip. */
export const FULL_LESSON_URLS: Readonly<Record<string, string>> = {};

export type LessonCache = { kind: "full"; url: string } | { kind: "clips" } | { kind: "none" };

export function sentenceClipUrl(videoId: string, startMs: number): string {
  return `${clipBase()}/clips/${videoId}/${startMs}.mp4`;
}

export function classifyLesson(videoId: string, full: Readonly<Record<string, string>>, clips: readonly string[]): LessonCache {
  const url = full[videoId];
  if (url && !url.includes("/clips/")) return { kind: "full", url };
  if (clips.includes(videoId)) return { kind: "clips" };
  return { kind: "none" };
}

export function lessonCache(videoId: string): LessonCache {
  return classifyLesson(videoId, FULL_LESSON_URLS, CLIP_VIDEO_IDS);
}

export function cacheNote(kind: LessonCache["kind"]): string {
  if (kind === "clips") return "这节课只有已经上传的单句片段，没有整段视频。片段不能当作整节课。当前仍是在线。";
  if (kind === "none") return "这节课没有已放好的整段视频。本地指已经缓存的片子，不会从这台设备选文件。当前仍是在线。";
  return "";
}

const PREF_KEY = "musk-atlas:video-source:v1";
export type SourceChoice = "local" | "online";

type Pref = { version: 1; byVideo: Record<string, SourceChoice> };

function readPref(): Pref {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return { version: 1, byVideo: {} };
    const parsed = JSON.parse(raw) as Pref;
    if (parsed?.version !== 1 || typeof parsed.byVideo !== "object" || !parsed.byVideo) return { version: 1, byVideo: {} };
    return parsed;
  } catch {
    return { version: 1, byVideo: {} };
  }
}

export function readChoice(videoId: string): SourceChoice | undefined {
  const choice = readPref().byVideo[videoId];
  return choice === "local" || choice === "online" ? choice : undefined;
}

export function saveChoice(videoId: string, choice: SourceChoice) {
  try {
    const pref = readPref();
    pref.byVideo[videoId] = choice;
    localStorage.setItem(PREF_KEY, JSON.stringify(pref));
  } catch {
    /* the choice still applies this visit */
  }
}

/** Play a verified full cache unless this lesson was set to online. */
export function initialSource(videoId: string): SourceChoice {
  if (lessonCache(videoId).kind === "full" && readChoice(videoId) !== "online") return "local";
  return "online";
}
