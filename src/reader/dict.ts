/** Meanings for the reader (LingQ-style suggested meanings):
 *  1. ECDICT (MIT), bundled offline as sharded JSON in public/dict/ (works in mainland China, never rate-limited);
 *     inflections resolve via exchange/lemma data ("looks" -> "look").
 *     No matching headword is an empty list. A failed manifest or shard fetch throws, so "not in the dictionary" stays distinct from "the dictionary did not load".
 *  2. Word Atlas lexicon (Chinese gloss) when the word is in it.
 *  3. Machine translation (MyMemory, then Google gtx) when the dictionary has no hit, and for phrases.
 *  4. English definitions from dictionaryapi.dev when available.
 *  Online results are cached in memory + localStorage. */
import { useEffect, useState } from "react";
import type { Atlas } from "../atlas/types";
import { useAtlas } from "../atlas/context";

/* ---------- Word Atlas lexicon ---------- */
let lex: Map<string, { zh: string; id: string }> | null = null;
let lexOf: Atlas | null = null;
const guesses = (w: string) => {
  const out = [w];
  for (const [suf, rep] of [["ies", "y"], ["ied", "y"], ["ing", ""], ["ing", "e"], ["ed", ""], ["ed", "e"], ["es", ""], ["s", ""], ["er", ""], ["est", ""], ["ly", ""]] as const)
    if (w.endsWith(suf) && w.length > suf.length + 2) out.push(w.slice(0, -suf.length) + rep);
  if (/(.)\1(ing|ed)$/.test(w)) out.push(w.replace(/(.)\1(ing|ed)$/, "$1"));
  return out;
};
export function lexicon(atlas: Atlas, key: string) {
  if (lexOf !== atlas) {
    lex = new Map(atlas.words.map((w) => [w.word.toLowerCase(), { zh: w.zh, id: w.id }]));
    lexOf = atlas;
  }
  for (const f of guesses(key)) {
    const hit = lex!.get(f);
    if (hit) return { ...hit, word: f };
  }
  return null;
}

/* ---------- ECDICT shards ---------- */
type Row = [string, string, string]; // phonetic, zh, en
interface Shard {
  w: Record<string, Row>;
  l: Record<string, string>;
}
function dictRoot() {
  const base = (import.meta.env && import.meta.env.BASE_URL) || "/";
  const b = String(base);
  return `${b.endsWith("/") ? b : `${b}/`}dict/`;
}
let manifest: Promise<{ version: number; shards: string[] }> | null = null;
let shardSet: Set<string> | null = null;
const shards = new Map<string, Promise<Shard>>();
const loadManifest = () =>
  (manifest ??= fetch(`${dictRoot()}manifest.json`)
    .then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    })
    .then((m) => {
      shardSet = new Set(m.shards);
      return m;
    })
    .catch((e) => {
      manifest = null;
      throw e;
    }));
const pref = (k: string, n: number) => k.replace(/[^a-z]/g, "").slice(0, n).padEnd(n, "_");
async function shardOf(k: string): Promise<Shard | null> {
  const m = await loadManifest();
  for (let n = 5; n >= 1; n--) {
    const p = pref(k, n);
    if (!shardSet!.has(p)) continue;
    if (!shards.has(p))
      shards.set(
        p,
        fetch(`${dictRoot()}${p}.json?v=${m.version}`).then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json() as Promise<Shard>;
        }).catch((e) => {
          shards.delete(p);
          throw e;
        }),
      );
    return shards.get(p)!;
  }
  return null;
}
export interface DictHit {
  key: string;
  ipa: string;
  zh: string[];
  en: string[];
  /** Set when the hit came through an inflection ("looks" -> "look"). */
  lemma?: string;
}
async function entry(k: string): Promise<{ row?: Row; lemma?: string }> {
  const s = await shardOf(k);
  return { row: s?.w[k], lemma: s?.l[k] };
}
const toHit = (key: string, r: Row, lemma?: string): DictHit => ({
  key,
  ipa: r[0],
  zh: r[1].split("\n").filter(Boolean),
  en: r[2].split("\n").filter(Boolean),
  lemma,
});
/** Exact entry, its lemma's entry, and for phrases a version with each word lemmatized ("looks at" -> "look at"). */
export async function ecdict(key: string): Promise<DictHit[]> {
  const out: DictHit[] = [];
  const own = await entry(key);
  if (own.row) out.push(toHit(key, own.row));
  const lem = own.lemma ?? (!own.row && !key.includes(" ") ? await guessLemma(key) : undefined);
  if (lem && lem !== key) {
    const l = await entry(lem);
    if (l.row) out.push(toHit(lem, l.row, lem));
  }
  if (!out.length && key.includes(" ")) {
    const ws = key.split(" ");
    const lemmas = await Promise.all(ws.map(async (w) => (await entry(w)).lemma ?? w));
    const alt = lemmas.join(" ");
    if (alt !== key) {
      const a = await entry(alt);
      if (a.row) out.push(toHit(alt, a.row, alt));
    }
  }
  return out;
}
async function guessLemma(w: string) {
  for (const g of guesses(w).slice(1)) if ((await entry(g)).row) return g;
  return undefined;
}

/* ---------- online sources (cached) ---------- */
const LS = "musk-atlas:meaning:v1";
const mem: Record<string, unknown> = (() => {
  try {
    return JSON.parse(localStorage.getItem(LS) || "{}");
  } catch {
    return {};
  }
})();
function remember(id: string, v: unknown) {
  mem[id] = v;
  try {
    const keys = Object.keys(mem);
    if (keys.length > 800) for (const k of keys.slice(0, keys.length - 800)) delete mem[k];
    localStorage.setItem(LS, JSON.stringify(mem));
  } catch {
    /* quota */
  }
}
async function timed(url: string, ms = 5000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal });
    return r;
  } finally {
    clearTimeout(t);
  }
}
const inflight = new Map<string, Promise<unknown>>();
/** Clears in-memory dictionary caches. Used by tests. */
export function resetDictForTests() {
  manifest = null;
  shardSet = null;
  shards.clear();
  for (const k of Object.keys(mem)) delete mem[k];
  inflight.clear();
}
function cached<T>(id: string, run: () => Promise<T | null>): Promise<T | null> {
  if (id in mem) return Promise.resolve(mem[id] as T);
  if (!inflight.has(id))
    inflight.set(
      id,
      run()
        .then((v) => {
          if (v != null) remember(id, v);
          return v;
        })
        .catch(() => null)
        .finally(() => inflight.delete(id)),
    );
  return inflight.get(id) as Promise<T | null>;
}

/** Machine translation en -> zh: MyMemory and Google gtx raced in parallel (8 s timeout each); first usable answer wins. */
export function translate(text: string) {
  return cached<string>(`mt:${text}`, async () => {
    const q = encodeURIComponent(text);
    const mymemory = async () => {
      const r = await timed(`https://api.mymemory.translated.net/get?q=${q}&langpair=en|zh-CN`, 8000);
      const j = (await r.json()) as { responseStatus?: number; responseData?: { translatedText?: string } };
      const t = j.responseData?.translatedText?.trim();
      if (t && j.responseStatus === 200 && !/MYMEMORY WARNING|QUERY LENGTH/i.test(t) && /[\u4e00-\u9fff]/.test(t)) return t;
      throw new Error("mymemory");
    };
    const gtx = async () => {
      const r = await timed(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${q}`, 8000);
      const j = (await r.json()) as [[string, string][]];
      const t = j?.[0]?.map((x) => x[0]).join("").trim();
      if (t) return t;
      throw new Error("gtx");
    };
    return new Promise<string | null>((res) => {
      let left = 2;
      const fail = () => --left === 0 && res(null);
      mymemory().then(res, fail);
      gtx().then(res, fail);
    });
  });
}

/** Literal zh -> en machine translation. Callers must label it as 机器直译 and never as idiomatic advice. */
export function translateToEn(text: string) {
  return cached<string>(`mt:zh:${text}`, async () => {
    const q = encodeURIComponent(text.slice(0, 200));
    const mymemory = async () => {
      const r = await timed(`https://api.mymemory.translated.net/get?q=${q}&langpair=zh-CN|en`, 8000);
      const j = (await r.json()) as { responseStatus?: number; responseData?: { translatedText?: string } };
      const t = j.responseData?.translatedText?.trim();
      if (t && j.responseStatus === 200 && !/MYMEMORY WARNING|QUERY LENGTH/i.test(t) && /[A-Za-z]/.test(t)) return t;
      throw new Error("mymemory");
    };
    const gtx = async () => {
      const r = await timed(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=zh-CN&tl=en&dt=t&q=${q}`, 8000);
      const j = (await r.json()) as [[string, string][]];
      const t = j?.[0]?.map((x) => x[0]).join("").trim();
      if (t && /[A-Za-z]/.test(t)) return t;
      throw new Error("gtx");
    };
    return new Promise<string | null>((res) => {
      let left = 2;
      const fail = () => --left === 0 && res(null);
      mymemory().then(res, fail);
      gtx().then(res, fail);
    });
  });
}

export interface Def {
  pos: string;
  text: string;
}
/** English definitions from dictionaryapi.dev (single words / two-word compounds). */
export function lookup(key: string) {
  return cached<{ ipa?: string; defs: Def[] }>(`dapi:${key}`, async () => {
    const r = await timed(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(key)}`);
    if (r.status === 404) return { defs: [] };
    if (!r.ok) return null;
    const data = (await r.json()) as { phonetic?: string; phonetics?: { text?: string }[]; meanings?: { partOfSpeech: string; definitions: { definition: string }[] }[] }[];
    const defs: Def[] = [];
    let ipa: string | undefined;
    for (const e of data) {
      ipa ??= e.phonetic || e.phonetics?.find((p) => p.text)?.text;
      for (const m of e.meanings ?? []) for (const d of m.definitions.slice(0, 2)) defs.push({ pos: m.partOfSpeech, text: d.definition });
    }
    return { ipa, defs: defs.slice(0, 4) };
  });
}

/* ---------- combined suggestions ---------- */
export type Source = "词典" | "词库" | "机器翻译" | "英英";
export interface Sense {
  text: string;
  src: Source;
  /** Headword the sense belongs to when it differs from the query (lemma). */
  of?: string;
}
export interface Meanings {
  senses: Sense[];
  ipa: string;
  loading: boolean;
  failed: boolean;
  lexId?: string;
}

export function useMeanings(key: string): Meanings {
  const atlas = useAtlas();
  const [st, setSt] = useState<{ dict?: DictHit[] | null; mt?: string | null; api?: { ipa?: string; defs: Def[] } | null; needMt: boolean }>({ needMt: false });
  useEffect(() => {
    let live = true;
    setSt({ needMt: false });
    const words = key.split(" ").length;
    ecdict(key)
      .catch(() => null)
      .then((d) => {
        if (!live) return;
        const needMt = !d?.length || words > 1;
        setSt((s) => ({ ...s, dict: d, needMt }));
        if (needMt) translate(key).then((mt) => live && setSt((s) => ({ ...s, mt })));
      });
    if (words <= 2) lookup(key).then((api) => live && setSt((s) => ({ ...s, api })));
    else setSt((s) => ({ ...s, api: { defs: [] } }));
    return () => {
      live = false;
    };
  }, [key]);

  const lexHit = !key.includes(" ") ? lexicon(atlas, key) : null;
  const senses: Sense[] = [];
  const seen = new Set<string>();
  const push = (s: Sense) => {
    const n = s.text.trim();
    if (n && !seen.has(n)) {
      seen.add(n);
      senses.push({ ...s, text: n });
    }
  };
  for (const h of st.dict ?? []) for (const z of h.zh.slice(0, 4)) push({ text: z, src: "词典", of: h.lemma });
  if (lexHit && !(st.dict ?? []).length) push({ text: lexHit.zh, src: "词库" });
  if (st.mt) push({ text: st.mt, src: "机器翻译" });
  const apiDefs = st.api?.defs ?? [];
  for (const d of apiDefs.slice(0, 3)) push({ text: `${d.pos}. ${d.text}`, src: "英英" });
  if (!apiDefs.length) for (const h of st.dict ?? []) for (const e of h.en.slice(0, 2)) push({ text: e, src: "英英", of: h.lemma });

  const pending = st.dict === undefined || (st.needMt && st.mt === undefined) || st.api === undefined;
  return {
    senses,
    ipa: st.dict?.[0]?.ipa || st.api?.ipa || "",
    loading: pending && !senses.length,
    failed: !pending && !senses.length,
    lexId: lexHit?.id,
  };
}

/** Browser text-to-speech (no recorded audio is shipped). */
export function speak(text: string) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    u.rate = 0.95;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch {
    /* no TTS */
  }
}
