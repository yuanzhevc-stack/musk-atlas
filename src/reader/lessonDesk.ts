/** Practice helpers for the lesson workspace. Comparisons are literal word checks. */
import { sentenceSpan } from "./sync";

export const DESK_MODES = ["both", "en", "zh", "dictation", "cloze", "read", "zh2en", "cards"] as const;
export type DeskMode = (typeof DESK_MODES)[number];

export const MODE_LABEL: Record<DeskMode, string> = {
  both: "双语",
  en: "英语",
  zh: "中文",
  dictation: "听写",
  cloze: "挖空",
  read: "阅读",
  zh2en: "中译英",
  cards: "词卡",
};

const STOP = new Set(
  "a an the and or but if of to in on for with at from by as is are was were be been being it this that these those i you we he she they my your our not just so than then there here what when".split(" "),
);

export function showsEnglish(mode: DeskMode) {
  return mode === "both" || mode === "en" || mode === "read" || mode === "cloze";
}

export function showsChinese(mode: DeskMode) {
  return mode === "both" || mode === "zh" || mode === "read" || mode === "zh2en";
}

export function wordsOf(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+(?:'[a-z0-9]+)?/g) ?? []).filter(Boolean);
}

export interface WordCheck {
  expected: string[];
  typed: string[];
  matches: boolean[];
  extra: string[];
  correct: number;
  total: number;
  same: boolean;
}

/** Compare typed English with the sentence. Order matters. Punctuation does not. */
export function checkWords(expected: string, typed: string): WordCheck {
  const want = wordsOf(expected);
  const got = wordsOf(typed);
  const matches = want.map((word, i) => got[i] === word);
  const extra = got.slice(want.length);
  const correct = matches.filter(Boolean).length;
  return {
    expected: want,
    typed: got,
    matches,
    extra,
    correct,
    total: want.length,
    same: extra.length === 0 && matches.every(Boolean) && want.length > 0,
  };
}

export interface ClozePiece {
  kind: "text" | "blank";
  text: string;
}

/** Remove a stable subset of content words. The same sentence always blanks the same words. */
export function clozePieces(sentence: string): { pieces: ClozePiece[]; answers: string[] } {
  const re = /[A-Za-z]+(?:'[A-Za-z]+)?/g;
  const content: { index: number; word: string }[] = [];
  for (const match of sentence.matchAll(re)) {
    const word = match[0];
    if (word.length < 4 || STOP.has(word.toLowerCase())) continue;
    content.push({ index: match.index ?? 0, word });
  }
  const chosen = new Set<number>();
  content.forEach((row, i) => {
    if (i % 3 === 0) chosen.add(row.index);
  });
  if (!chosen.size && content[0]) chosen.add(content[0].index);
  const pieces: ClozePiece[] = [];
  const answers: string[] = [];
  let cursor = 0;
  for (const match of sentence.matchAll(re)) {
    const at = match.index ?? 0;
    if (at > cursor) pieces.push({ kind: "text", text: sentence.slice(cursor, at) });
    if (chosen.has(at)) {
      answers.push(match[0]);
      pieces.push({ kind: "blank", text: match[0] });
    } else pieces.push({ kind: "text", text: match[0] });
    cursor = at + match[0].length;
  }
  if (cursor < sentence.length) pieces.push({ kind: "text", text: sentence.slice(cursor) });
  if (!pieces.length) pieces.push({ kind: "text", text: sentence });
  return { pieces, answers };
}

export function checkCloze(answers: string[], typed: string[]): WordCheck {
  return checkWords(answers.join(" "), typed.join(" "));
}

export interface LoopInput {
  time: number;
  start: number;
  end: number;
  enabled: boolean;
  /** When true and the gap is 0, the sentence stops instead of repeating. */
  pauseAfter: boolean;
  intervalSec: number;
  holding: boolean;
  heldForSec: number;
}

export type LoopDecision = { type: "none" } | { type: "hold" } | { type: "restart"; at: number };

export type SentenceGate = { type: "inside" } | { type: "pause" } | { type: "restart"; at: number } | { type: "follow" };

/** Default study playback pauses at the sentence end and keeps that sentence. Loop repeats it. Follow is the opt-in continuous clock. */
export function holdSentence(input: { time: number; start: number; end: number; loop: boolean; pauseAtEnd: boolean }): SentenceGate {
  if (!Number.isFinite(input.time) || !Number.isFinite(input.start) || !Number.isFinite(input.end) || input.end <= input.start) return { type: "inside" };
  if (input.time < input.end - 0.08) return { type: "inside" };
  if (input.loop) return { type: "restart", at: input.start };
  if (input.pauseAtEnd) return { type: "pause" };
  return { type: "follow" };
}

/** True once the clock has left this sentence. A later tick must still pause; one pause is not enough. */
export function clipReached(time: number, start: number, end: number): boolean {
  return holdSentence({ time, start, end, loop: false, pauseAtEnd: true }).type === "pause";
}
export function keptCaption(current: number, clockIndex: number, follow: boolean): number {
  return follow ? clockIndex : current;
}

/** Clicks on these controls keep their own job. A plain surface click replays the current sentence. */
export const REPLAY_BLOCKED = "button, a, input, textarea, select, summary, label, audio, [data-ti], [role='tab']";

export function loopDecision(input: LoopInput): LoopDecision {
  if (!input.enabled || !Number.isFinite(input.start) || !Number.isFinite(input.end) || input.end <= input.start) return { type: "none" };
  if (input.holding) {
    if (input.pauseAfter && input.intervalSec <= 0) return { type: "none" };
    if (input.heldForSec + 0.02 >= Math.max(0, input.intervalSec)) return { type: "restart", at: input.start };
    return { type: "none" };
  }
  if (input.time < input.end - 0.12) return { type: "none" };
  if (!input.pauseAfter && input.intervalSec <= 0) return { type: "restart", at: input.start };
  return { type: "hold" };
}

export function loopRange(times: number[], from: number, to: number): { start: number; end: number } | null {
  if (!times.length) return null;
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(times.length - 1, Math.max(from, to));
  const span = sentenceSpan(times, b);
  const start = times[a];
  if (span == null || start == null || !Number.isFinite(start)) return null;
  return { start, end: Math.max(span.e, start + 0.2) };
}

export const SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;

export function nextSpeed(current: number): number {
  const i = SPEEDS.findIndex((n) => Math.abs(n - current) < 0.01);
  return SPEEDS[(i + 1) % SPEEDS.length] ?? 1;
}

export interface DeskCard {
  key: string;
  text: string;
  meaning: string;
  due: number;
  hasSrs: boolean;
}

/** Saved personal words only. A lesson never invents a sample card. */
export function personalCards(items: { key: string; text: string; kind: string; meaning: string; status: number; srs?: { due: number }; ctx?: { lesson?: string } }[], lessonId: string, keys: ReadonlySet<string>): DeskCard[] {
  const out: DeskCard[] = [];
  for (const item of items) {
    if (item.kind === "sentence" || item.status === -1) continue;
    const inLesson = item.ctx?.lesson === lessonId || keys.has(item.key);
    if (!inLesson) continue;
    out.push({ key: item.key, text: item.text, meaning: item.meaning, due: item.srs?.due ?? Number.POSITIVE_INFINITY, hasSrs: !!item.srs });
  }
  out.sort((a, b) => a.due - b.due || a.text.localeCompare(b.text));
  return out;
}

/** What the current transcript row may put in the document. Hidden answers are omitted, not faded. */
export type RowDisclosure = "full" | "english-hidden" | "answer-hidden";

export function rowDisclosure(mode: DeskMode, revealed: boolean, isCurrent: boolean, inTranscript: boolean): RowDisclosure {
  if (!isCurrent && !(mode === "zh" && inTranscript)) return "full";
  if ((mode === "dictation" || mode === "cloze") && isCurrent && !revealed) return "answer-hidden";
  if (mode === "zh2en" && isCurrent && !revealed) return "english-hidden";
  if (mode === "zh" && inTranscript) return "english-hidden";
  return "full";
}

export type RowPointer = "lookup" | "seek" | "keep";

/** A word press opens the lookup. A drag keeps that phrase and does not seek. Empty row space may seek. */
export function rowPointer(input: { word: boolean; dragged: boolean }): RowPointer {
  if (input.dragged) return "keep";
  if (input.word) return "lookup";
  return "seek";
}

/** A drag across two different word indexes. A press that stays on one word is a click, not a phrase. */
export function dragPhrase(start: number, end: number): { from: number; to: number } | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < 0 || start === end) return null;
  return { from: Math.min(start, end), to: Math.max(start, end) };
}

/** Tokens a native selection actually covers. One word stays a click. */
export function selectedPhrase(indexes: number[]): { from: number; to: number } | null {
  const ids = indexes.filter((n) => Number.isInteger(n) && n >= 0);
  if (ids.length < 2) return null;
  return { from: Math.min(...ids), to: Math.max(...ids) };
}

/** Blue words left behind when the reader moves on. Saved words, saved phrases, and the open selection stay. */
export function unmarkedWords(
  tokens: { i: number; key?: string; text: string }[],
  saved: ReadonlySet<string>,
  phraseAt: ReadonlyMap<number, unknown>,
  keep: { from: number; to: number } | null = null,
): string[] {
  const held = new Set<string>();
  if (keep) {
    for (const t of tokens) if (t.key && t.i >= keep.from && t.i <= keep.to) held.add(t.key);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (!t.key || saved.has(t.key) || phraseAt.has(t.i) || held.has(t.key)) continue;
    if (seen.has(t.key)) continue;
    seen.add(t.key);
    out.push(t.text);
  }
  return out;
}

/**
 * Indexes of words that should share one highlight, plus the spaces between them.
 * A saved word or a phrase word joins the run. Plain gaps stay inside; an unmarked word breaks it.
 */
export function highlightRuns<T extends { key?: string }>(
  tokens: T[],
  marked: (token: T, index: number) => boolean,
): { from: number; to: number }[] {
  const runs: { from: number; to: number }[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (!tokens[i].key || !marked(tokens[i], i)) {
      i++;
      continue;
    }
    let end = i;
    while (end + 1 < tokens.length) {
      let k = end + 1;
      while (k < tokens.length && !tokens[k].key) k++;
      if (k < tokens.length && marked(tokens[k], k)) end = k;
      else break;
    }
    runs.push({ from: i, to: end });
    i = end + 1;
  }
  return runs;
}
