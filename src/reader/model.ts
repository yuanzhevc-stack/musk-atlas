/** LingQ-style reader + "我的语料库" (My Corpus), kept in localStorage (per device; use JSON export/import to move).
 *
 * Integration contract (see README "Reader / 语料库"):
 *  - Every corpus item has `key` = normalize(text): lowercase, straight apostrophes, single spaces.
 *    The same key is what the Musk sharded index is queried with (src/musk/corpus.ts lemmatizes it).
 *  - `ctx` stores the source: lesson id + sentence index + the sentence text (or a Musk clip for items imported from the Musk phrasebook).
 *  - `srs` is an optional FSRS card (src/store/srs.ts) so items can join spaced review. */
import { useSyncExternalStore } from "react";
import { review, type CardState, type Grade } from "../store/srs";

/** 1–4 = LingQ learning levels (yellow fading), 5 = known, -1 = ignored. Blue (new) words are simply absent. */
export type Status = 1 | 2 | 3 | 4 | 5 | -1;
export const STATUS_LABEL: Record<string, string> = { "0": "新词", "1": "1 新", "2": "2 认得", "3": "3 熟悉", "4": "4 掌握", "5": "已知", "-1": "忽略" };

export interface Context {
  /** Lesson id, or "musk" for items imported from the Musk phrasebook. */
  lesson: string;
  title: string;
  /** Sentence index inside the lesson (global, across pages). */
  sid: number;
  sentence: string;
  /** Musk source (videoId@seconds) when the context is a Musk clip. */
  musk?: { v: string; t: number; ms?: number };
}

export interface Item {
  key: string;
  text: string;
  kind: "word" | "phrase" | "sentence";
  status: Status;
  meaning: string;
  notes: string;
  ctx?: Context;
  created: number;
  updated: number;
  srs?: CardState;
}

export interface Lesson {
  id: string;
  title: string;
  url?: string;
  text: string;
  created: number;
  opened?: number;
  page?: number;
  /** Imported from YouTube: video id + start time (seconds) of every sentence (by sid). */
  yt?: { v: string; times: number[]; kind: "manual" | "asr"; author?: string };
}

interface State {
  version: 1;
  lessons: Lesson[];
  items: Record<string, Item>;
}

const KEY = "musk-atlas:reader:v1";
const empty = (): State => ({ version: 1, lessons: [], items: {} });
let state: State = (() => {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null") as State | null;
    return s && s.version === 1 && Array.isArray(s.lessons) && s.items ? s : empty();
  } catch {
    return empty();
  }
})();
const subs = new Set<() => void>();
function commit(next: State) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* quota: keep in memory */
  }
  subs.forEach((f) => f());
}
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};
export const useReader = () => useSyncExternalStore(subscribe, () => state);

export const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[^a-z0-9' -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

export const reader = {
  get: () => state,
  item: (key: string) => state.items[key] as Item | undefined,
  addLesson(l: Omit<Lesson, "id" | "created">) {
    const lesson: Lesson = { ...l, id: uid(), created: Date.now() };
    commit({ ...state, lessons: [lesson, ...state.lessons] });
    return lesson;
  },
  updateLesson(id: string, patch: Partial<Lesson>) {
    commit({ ...state, lessons: state.lessons.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
  },
  removeLesson(id: string) {
    commit({ ...state, lessons: state.lessons.filter((l) => l.id !== id) });
  },
  /** Create or update a corpus item. Context is only set on creation (first encounter), like LingQ. */
  upsert(text: string, patch: Partial<Omit<Item, "key" | "created">>, ctx?: Context) {
    const key = normalize(text);
    if (!key) return;
    const prev = state.items[key];
    const now = Date.now();
    const next: Item = prev
      ? { ...prev, ...patch, updated: now, ctx: prev.ctx ?? ctx }
      : { key, text: text.trim(), kind: key.includes(" ") ? "phrase" : "word", status: 1, meaning: "", notes: "", created: now, updated: now, ctx, ...patch };
    commit({ ...state, items: { ...state.items, [key]: next } });
    return next;
  },
  setStatus(text: string, status: Status, ctx?: Context) {
    return this.upsert(text, { status }, ctx);
  },
  /** Bookmark a whole sentence (kind 句子); toggles. Returns true when saved. */
  toggleSentence(text: string, ctx?: Context) {
    const key = normalize(text);
    if (!key) return false;
    if (state.items[key]?.kind === "sentence") {
      this.remove(key);
      return false;
    }
    this.upsert(text, { kind: "sentence", status: 1 }, ctx);
    return true;
  },
  /** Back to blue: delete the item. */
  remove(key: string) {
    const items = { ...state.items };
    delete items[key];
    commit({ ...state, items });
  },
  /** "Page done": every blue word on the page becomes known. */
  markKnown(words: string[]) {
    const items = { ...state.items };
    const now = Date.now();
    for (const w of words) {
      const key = normalize(w);
      if (key && !items[key]) items[key] = { key, text: w, kind: "word", status: 5, meaning: "", notes: "", created: now, updated: now };
    }
    commit({ ...state, items });
  },
  /** FSRS hook: add to / grade in spaced review. */
  addToReview(key: string) {
    const it = state.items[key];
    if (!it || it.srs) return;
    const now = Date.now();
    this.upsert(it.text, { srs: { due: now, s: 0, d: 0, el: 0, sd: 0, ls: 0, reps: 0, lapses: 0, st: 0, seen: now } });
  },
  removeFromReview(key: string) {
    const it = state.items[key];
    if (it) this.upsert(it.text, { srs: undefined });
  },
  grade(key: string, g: Grade) {
    const it = state.items[key];
    if (!it?.srs) return;
    const fresh = it.srs.reps === 0 && it.srs.s === 0;
    this.upsert(it.text, { srs: review(fresh ? undefined : it.srs, g, Date.now()) });
  },
  exportJSON: () => JSON.stringify({ app: "musk-atlas-reader", exported: new Date().toISOString(), ...state }, null, 1),
  /** Merge a backup: newer `updated` wins per item; lessons merged by id. */
  importJSON(raw: string) {
    const data = JSON.parse(raw) as Partial<State>;
    if (!data || typeof data !== "object" || !data.items || typeof data.items !== "object") throw new Error("不是有效的语料库备份");
    const items = { ...state.items };
    let n = 0;
    for (const [k, v] of Object.entries(data.items)) {
      if (!v || typeof v !== "object" || typeof (v as Item).text !== "string") continue;
      const it = v as Item;
      const key = normalize(it.key || it.text || k);
      if (!key) continue;
      if (!items[key] || (it.updated ?? 0) > items[key].updated) {
        items[key] = { ...it, key };
        n++;
      }
    }
    const have = new Set(state.lessons.map((l) => l.id));
    const lessons = [...state.lessons, ...(Array.isArray(data.lessons) ? data.lessons.filter((l) => l && l.id && !have.has(l.id) && typeof l.text === "string") : [])];
    commit({ ...state, lessons, items });
    return n;
  },
};

/* ---------- tokenizer ---------- */

export interface Token {
  /** Index among all tokens of the lesson. */
  i: number;
  text: string;
  /** Word tokens only. */
  key?: string;
  sid: number;
}
export interface Paragraph {
  tokens: Token[];
  /** Continuation of the previous source paragraph (a long paragraph split for paging). */
  cont?: boolean;
}
export interface Parsed {
  paragraphs: Paragraph[];
  sentences: string[];
  /** Pages of paragraphs (~PAGE_WORDS words each), like LingQ's paged reader. */
  pages: { from: number; to: number; words: number }[];
  words: number;
}

const WORD = /[A-Za-z]+(?:['\u2019][A-Za-z]+)*/g;
export const PAGE_WORDS = 220;

const ABBR = new Set(
  "mr mrs ms dr prof sr jr st mt vs etc e.g i.e cf al approx dept est fig inc ltd co corp no nos vol p pp ph.d u.s u.k u.n u.s.a e.u a.m p.m jan feb mar apr jun jul aug sep sept oct nov dec gen col lt sgt rev gov sen rep".split(" "),
);
/** Sentence split that keeps abbreviations (Mr., U.S., e.g.), initials (J. K.) and decimals (3.5) inside the sentence. */
export function splitSentences(p: string): string[] {
  const out: string[] = [];
  const re = /[.!?…]+["'”’)\]]*(\s+)/g;
  let start = 0;
  for (const m of p.matchAll(re)) {
    const end = (m.index ?? 0) + m[0].length;
    const punct = m[0].trim();
    const before = p.slice(start, m.index).match(/([A-Za-z][A-Za-z.]*)$/)?.[1] ?? "";
    const next = p.slice(end, end + 2);
    if (punct.startsWith(".") && !/^\.{2,}/.test(punct)) {
      const w = before.toLowerCase();
      if (ABBR.has(w) || ABBR.has(w.replace(/\.$/, ""))) continue; // Mr. / U.S. / e.g.
      if (/^[A-Z]$/.test(before)) continue; // initials: J. K. Rowling
      if (/^[A-Za-z](\.[A-Za-z])+$/.test(before)) continue; // a.k.a / U.S.A
    }
    if (next && !/^["'“‘(\[]?[A-Z0-9一-鿿]/.test(next)) continue; // next must start a sentence
    out.push(p.slice(start, end));
    start = end;
  }
  if (start < p.length) out.push(p.slice(start));
  return out.filter((x) => x.trim());
}

export function parse(text: string): Parsed {
  // Blank line = paragraph; a single line break = forced sentence break (one line each).
  const paras = text.replace(/\r/g, "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const sentences: string[] = [];
  const paragraphs: Paragraph[] = [];
  let i = 0;
  for (const p of paras) {
    let tokens: Token[] = [];
    let words = 0;
    let cont = false;
    for (const s of p.split("\n").flatMap((line) => splitSentences(line.trim()))) {
      // Split very long paragraphs (pasted transcripts) at sentence boundaries so paging stays even.
      if (words >= PAGE_WORDS && tokens.length) {
        paragraphs.push({ tokens, ...(cont ? { cont } : {}) });
        tokens = [];
        words = 0;
        cont = true;
      }
      const sid = sentences.length;
      sentences.push(s.trim());
      let last = 0;
      for (const m of s.matchAll(WORD)) {
        const at = m.index ?? 0;
        if (at > last) tokens.push({ i: i++, text: s.slice(last, at), sid });
        tokens.push({ i: i++, text: m[0], key: normalize(m[0]), sid });
        words++;
        last = at + m[0].length;
      }
      if (last < s.length) tokens.push({ i: i++, text: s.slice(last), sid });
    }
    paragraphs.push({ tokens, ...(cont ? { cont } : {}) });
  }
  const pages: Parsed["pages"] = [];
  let from = 0;
  let count = 0;
  let total = 0;
  paragraphs.forEach((p, k) => {
    const w = p.tokens.filter((t) => t.key).length;
    total += w;
    if (count > 0 && count + w > PAGE_WORDS) {
      pages.push({ from, to: k, words: count });
      from = k;
      count = 0;
    }
    count += w;
  });
  if (paragraphs.length) pages.push({ from, to: paragraphs.length, words: count });
  return { paragraphs, sentences, pages, words: total };
}

/** Saved multi-word phrases, indexed by first word for fast in-text matching. */
export function phraseIndex(items: Record<string, Item>) {
  const by = new Map<string, string[][]>();
  for (const it of Object.values(items)) {
    if (it.kind !== "phrase" || it.status === -1) continue;
    const ws = it.key.split(" ");
    const list = by.get(ws[0]) ?? [];
    list.push(ws);
    by.set(ws[0], list);
  }
  return by;
}

export function lessonStats(text: string, items: Record<string, Item>) {
  const keys = new Set(text.match(WORD)?.map(normalize) ?? []);
  let blue = 0;
  let learning = 0;
  for (const k of keys) {
    const s = items[k]?.status;
    if (s == null) blue++;
    else if (s >= 1 && s <= 4) learning++;
  }
  return { unique: keys.size, blue, learning };
}
