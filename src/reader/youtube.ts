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
  captions_blocked: "YouTube 暂时拦下了字幕请求（登录或机器人检查），稍后再试",
  unavailable: "这个视频不存在或已无法观看",
  age_restricted: "这个视频有年龄限制，公开字幕拿不到",
};

export function captionErrorMessage(code: string | undefined, status: number): string {
  return ERR[code ?? ""] ?? `字幕获取失败（${status}）`;
}

export async function fetchCaptions(v: string): Promise<Captions> {
  const r = await fetch(`${TTS_URL}/captions?v=${v}`).catch(() => null);
  if (!r) throw new Error("网络不通，稍后再试");
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(captionErrorMessage(j.error, r.status));
  }
  return (await r.json()) as Captions;
}

const NOISE = /^[[(（][^\])）]{0,40}[\])）]$/; // [Music] (Laughter) (Applause)

const BRAND: Record<string, string> = {
  spacex: "SpaceX",
  starlink: "Starlink",
  starship: "Starship",
  tesla: "Tesla",
  paypal: "PayPal",
  youtube: "YouTube",
  openai: "OpenAI",
  neuralink: "Neuralink",
  twitter: "Twitter",
  cybertruck: "Cybertruck",
  elon: "Elon",
  musk: "Musk",
};
const ACRONYM = new Set(["ai", "nasa", "ceo", "cfo", "cto", "coo", "ipo", "fbi", "cia", "gdp", "ufo", "phd"]);

/** All-caps captions become sentence case. A line that already has normal case is left alone. */
export function sentenceCase(text: string): string {
  const letters = text.match(/[A-Za-z]/g) ?? [];
  if (letters.length < 2) return text;
  const uppers = letters.filter((ch) => ch >= "A" && ch <= "Z").length;
  if (uppers / letters.length < 0.75) return text;
  let start = true;
  return text.replace(/[A-Za-z]+(?:'[A-Za-z]+)?/g, (word) => {
    const lower = word.toLowerCase();
    let next = BRAND[lower] ?? (ACRONYM.has(lower) ? lower.toUpperCase() : lower);
    if (next === lower && (/^i$/.test(lower) || /^i'(m|ve|d|ll|re)$/.test(lower))) next = "I" + lower.slice(1);
    if (next === lower && start) next = lower.charAt(0).toUpperCase() + lower.slice(1);
    start = false;
    return next;
  });
}

/** Break one caption into sentences. A trailing fragment stays, so the next caption can finish it. */
export function splitSpeech(text: string): string[] {
  return splitSentences(text.trim()).map((line) => line.trim()).filter(Boolean);
}

const CLAUSE_BREAK = /[,;]\s*$/;
const BUT_START = /^but\b/i;

function endsSentence(text: string): boolean {
  return /[.!?…]["'”’)\]]*\s*$/.test(text);
}

/** One study sentence. Caption lines join until a real stop, or a comma followed by "but". */
export function speechLines(segs: [number, number, string][]): { text: string; ms: number }[] {
  const pieces: { text: string; ms: number }[] = [];
  for (const [ms, dur, raw] of segs) {
    const text = raw.replace(/\s+/g, " ").replace(/^>>\s*/, "").trim();
    if (!text || NOISE.test(text)) continue;
    const duration = dur >= 400 ? dur : 4000;
    const parts = splitSpeech(text);
    const weights = parts.map((part) => Math.max(1, part.split(/\s+/).filter(Boolean).length));
    const total = weights.reduce((sum, n) => sum + n, 0) || 1;
    let used = 0;
    parts.forEach((part, i) => {
      pieces.push({ text: part, ms: ms + (duration * used) / total });
      used += weights[i];
    });
  }
  const lines: { text: string; ms: number }[] = [];
  let buf: { text: string; ms: number }[] = [];
  const flush = () => {
    if (!buf.length) return;
    const text = sentenceCase(buf.map((part) => part.text).join(" ").replace(/\s+/g, " ").trim());
    if (text) lines.push({ text, ms: buf[0].ms });
    buf = [];
  };
  for (const piece of pieces) {
    const prev = buf.map((part) => part.text).join(" ");
    if (buf.length && CLAUSE_BREAK.test(prev) && BUT_START.test(piece.text)) flush();
    buf.push(piece);
    if (endsSentence(buf.map((part) => part.text).join(" "))) flush();
  }
  flush();
  return lines;
}

/** Captions -> lesson text. Fragments of one sentence share that sentence's start. */
export function captionsToLesson(c: Captions) {
  const spoken = speechLines(c.segs);
  let last = -1;
  const times = spoken.map((line) => {
    let t = Math.round(line.ms / 100) / 10;
    if (t <= last) t = Math.round((last + 0.1) * 10) / 10;
    last = t;
    return t;
  });
  const paras: string[][] = [];
  let para: string[] = [];
  spoken.forEach((line, k) => {
    const gap = k > 0 ? line.ms - spoken[k - 1].ms : 0;
    if (para.length && (para.length >= 6 || gap > 9000)) {
      paras.push(para);
      para = [];
    }
    para.push(line.text);
  });
  if (para.length) paras.push(para);
  return { text: paras.map((p) => p.join("\n")).join("\n\n"), times };
}

export const watchUrl = (v: string, t = 0) => `https://www.youtube.com/watch?v=${v}${t > 0 ? `&t=${Math.floor(t)}s` : ""}`;
export const clockOf = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
