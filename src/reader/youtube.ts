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

/** A YouTube id anywhere in a note, a source link, or a pasted paragraph. */
export function youtubeIdIn(input: string): string | null {
  const direct = youtubeId(input);
  if (direct) return direct;
  const parts = input.match(/https?:\/\/[^\s)]+|youtu\.be\/[A-Za-z0-9_-]{11}/gi) ?? [];
  for (const part of parts) {
    const id = youtubeId(part);
    if (id) return id;
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

const SPOKEN_START = /^(but|so|now|luckily|however|plus|yes|for example|in his book|a good example|thank you|the third point)\b/i;
const CANNOT_END = /^(a|an|the|to|of|in|on|for|and|or|but|with|from|that|this|into|about|like|as|at|by|if|so|than|then|your|my|our|their|his|her|its|is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|can|could|should|just|very|more|most|not|no|nor|because|which|who|when|where|what|how|why|after|before|although|though|while|during|through|over|under|between|without|within|also|even|really|it's|that's|there's|i'm|i've)$/i;

function barelyPunctuated(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 40) return false;
  const stops = text.match(/[.!?]/g)?.length ?? 0;
  return stops * 40 < words.length;
}

function canEndWord(word: string): boolean {
  const bare = word.replace(/[^A-Za-z']/g, "");
  return Boolean(bare) && !CANNOT_END.test(bare);
}

function finishSpoken(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  const lead = trimmed.replace(/^[a-z]/, (ch) => ch.toUpperCase());
  if (/[.!?…]["'”’)\]]*$/.test(lead)) return lead;
  const question = /^(have you|are we|are you|do you|did you|what|why|how|who|when|where|can you)\b/i.test(lead);
  return `${lead}${question ? "?" : "."}`;
}

/** Auto captions often have no periods. Break only before a new clause, never in the middle of a phrase. */
export function breakUnpunctuated(text: string): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const parts: string[] = [];
  let start = 0;
  for (let i = 1; i < words.length; i++) {
    if (i - start < 12 || !canEndWord(words[i - 1])) continue;
    const rest = words.slice(i, i + 4).join(" ");
    if (!SPOKEN_START.test(rest)) continue;
    parts.push(words.slice(start, i).join(" "));
    start = i;
  }
  parts.push(words.slice(start).join(" "));
  return parts.map(finishSpoken).filter(Boolean);
}

function endsSentence(text: string): boolean {
  return /[.!?…]["'”’)\]]*\s*$/.test(text);
}

const CLAUSE_BREAK = /[,;]\s*$/;
const BUT_START = /^but\b/i;

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
  if (!lines.length) return lines;
  const joined = pieces.map((piece) => piece.text).join(" ");
  if (!barelyPunctuated(joined)) return lines;
  const words = pieces.flatMap((piece) => {
    const bits = piece.text.split(/\s+/).filter(Boolean);
    return bits.map((word) => ({ word, ms: piece.ms }));
  });
  const spoken = breakUnpunctuated(words.map((piece) => piece.word).join(" "));
  let at = 0;
  return spoken.map((text) => {
    const count = text.replace(/[.!?]/g, "").split(/\s+/).filter(Boolean).length;
    const ms = words[Math.min(at, words.length - 1)]?.ms ?? 0;
    at += count;
    return { text, ms };
  });
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
