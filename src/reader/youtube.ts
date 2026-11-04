/** YouTube -> reader lesson. Captions come from the musk-atlas Worker (public captions, no cookies), cached in R2. */
import { TTS_URL } from "./tts";
import { splitSentences } from "./model";

export interface Captions {
  v: string;
  title: string;
  author: string;
  lang: string;
  kind: "manual" | "asr";
  segs: [number, number, string][];
}

export function youtubeId(input: string): string | null {
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s.startsWith("http") ? s : `https://${s}`);
    const host = u.hostname.replace(/^(www|m|music)\./, "");
    if (host === "youtu.be") return u.pathname.slice(1, 12) || null;
    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      const v = u.searchParams.get("v");
      if (v) return v.slice(0, 11);
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[1];
    }
  } catch {
    /* not a url */
  }
  return null;
}

const ERR: Record<string, string> = {
  no_captions: "这个视频没有字幕",
  no_english: "这个视频没有英文字幕",
  timedtext_blocked: "YouTube 暂时拒绝了字幕请求，稍后再试",
  empty_captions: "字幕是空的",
};

export async function fetchCaptions(v: string): Promise<Captions> {
  const r = await fetch(`${TTS_URL}/captions?v=${v}`).catch(() => null);
  if (!r) throw new Error("网络不通，稍后再试");
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(ERR[j.error ?? ""] ?? `字幕获取失败（${r.status}）`);
  }
  return (await r.json()) as Captions;
}

const NOISE = /^[[(（][^\])）]{0,40}[\])）]$/; // [Music] (Laughter) (Applause)
const MAX_WORDS = 36;

/** Captions -> lesson text (one sentence per line, blank line on long pauses) + per-sentence start seconds. */
export function captionsToLesson(c: Captions) {
  // One stream of text with a time for every character offset (start of the caption segment it came from).
  let stream = "";
  const marks: [number, number][] = []; // [charOffset, ms]
  for (const [ms, , raw] of c.segs) {
    const t = raw.replace(/\s+/g, " ").replace(/^>>\s*/, "").trim();
    if (!t || NOISE.test(t)) continue;
    marks.push([stream.length + (stream ? 1 : 0), ms]);
    stream += (stream ? " " : "") + t;
  }
  const timeAt = (off: number) => {
    let lo = 0;
    let hi = marks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (marks[mid][0] <= off) lo = mid;
      else hi = mid - 1;
    }
    return marks[lo]?.[1] ?? 0;
  };
  const lines: { text: string; ms: number }[] = [];
  let off = 0;
  for (const raw of splitSentences(stream)) {
    const at = stream.indexOf(raw, off);
    off = at + raw.length;
    // Unpunctuated auto captions: cap a "sentence" at ~MAX_WORDS, breaking on segment boundaries.
    const words = raw.trim().split(/\s+/);
    if (words.length <= MAX_WORDS) {
      lines.push({ text: raw.trim(), ms: timeAt(at) });
      continue;
    }
    let start = at;
    let cur = "";
    let n = 0;
    for (const m of raw.matchAll(/\S+\s*/g)) {
      const pos = at + (m.index ?? 0);
      const isBoundary = marks.some(([o]) => o === pos);
      if (n >= MAX_WORDS * 0.6 && (isBoundary || n >= MAX_WORDS)) {
        lines.push({ text: cur.trim(), ms: timeAt(start) });
        cur = "";
        n = 0;
        start = pos;
      }
      cur += m[0];
      n++;
    }
    if (cur.trim()) lines.push({ text: cur.trim(), ms: timeAt(start) });
  }
  // Paragraphs: break on a pause of 2.5 s+ or every 6 sentences.
  const paras: string[][] = [];
  const times: number[] = [];
  let para: string[] = [];
  lines.forEach((l, k) => {
    const gap = k > 0 ? l.ms - lines[k - 1].ms : 0;
    if (para.length && (para.length >= 6 || gap > 9000)) {
      paras.push(para);
      para = [];
    }
    para.push(l.text);
    // parse() re-splits each line with the same splitter; keep one time per resulting sentence.
    for (let i = 0; i < Math.max(1, splitSentences(l.text).length); i++) times.push(Math.round(l.ms / 100) / 10);
  });
  if (para.length) paras.push(para);
  return { text: paras.map((p) => p.join("\n")).join("\n\n"), times };
}

export const watchUrl = (v: string, t = 0) => `https://www.youtube.com/watch?v=${v}${t > 0 ? `&t=${Math.floor(t)}s` : ""}`;
export const clockOf = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
