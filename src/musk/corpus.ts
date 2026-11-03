/** Sharded, on-demand Musk corpus (built by musk-corpus/shard_index.py into public/musk/index/).
 * manifest.json -> l/<prefix>.json (forms + postings per label) -> s/<chunk>.json (sentences, fetched only for shown hits). */
import { CLIP_BASE } from "../config";

export interface Video {
  title: string;
  channel: string;
  duration: number | null;
  date?: string | null;
  year?: string | null;
  /** First/last global sentence id of this video. */
  r: [number, number];
}
/** [lemma, start, end, charStart, charEnd] */
export type Tok = [string, number, number, number, number];
export type Label = "musk" | "uncertain" | "not_musk";
export interface Sentence {
  id: number;
  v: string;
  s: number;
  e: number;
  t: string;
  /** Voiceprint verification (ECAPA vs Musk centroid). */
  m: Label | null;
  /** Cosine similarity to the Musk voiceprint. */
  p: number | null;
  w: Tok[];
  /** Clip URL on CLIP_BASE, if the clip is uploaded. */
  c: string | null;
}
export interface Manifest {
  version: number;
  chunk: number;
  n: number;
  videos: Record<string, Video>;
  labels: Record<string, number>;
  clips: number;
  shards: string[];
}
interface Shard {
  f: Record<string, string>;
  p: Record<string, { m: number[]; u: number[]; n: number[] }>;
}
type Row = [string, number, number, string, Label | null, number | null, Tok[], number | null];
export interface Hit {
  id: string;
  sentence: Sentence;
  video: Video;
  start: number;
  end: number;
  /** Character range of the matched phrase in sentence.t */
  from: number;
  to: number;
}
export interface Candidates {
  lemmas: string[];
  m: number[];
  u: number[];
  n: number[];
}

const ROOT = `${import.meta.env.BASE_URL}musk/index/`;
const cache = new Map<string, Promise<unknown>>();
function get<T>(path: string, optional = false): Promise<T | null> {
  if (!cache.has(path)) {
    cache.set(
      path,
      fetch(ROOT + path).then((r) => {
        if (r.ok) return r.json();
        if (optional && r.status === 404) return null;
        throw new Error(`语料加载失败（${r.status}）`);
      }),
    );
  }
  return cache.get(path) as Promise<T | null>;
}

let manifest: Promise<Manifest> | null = null;
export function loadManifest() {
  manifest ??= fetch(`${ROOT}manifest.json`, { cache: "no-cache" }).then((r) => {
    if (!r.ok) throw new Error(`语料加载失败（${r.status}）`);
    return r.json() as Promise<Manifest>;
  });
  return manifest;
}

const prefOf = (w: string) => (/^[a-z]{2}/.test(w) ? w.slice(0, 2) : /^[a-z]/i.test(w) ? `${w[0]}_` : "__");
async function shardFor(w: string, man: Manifest): Promise<Shard | null> {
  const p = prefOf(w);
  if (!man.shards.includes(p)) return null;
  return get<Shard>(`l/${p}.json?v=${man.version}`, true);
}

/** Map a typed word to the corpus lemma; light suffix fallback for unseen forms. */
async function lemmaOf(w: string, man: Manifest): Promise<string> {
  const own = (await shardFor(w, man))?.f[w];
  if (own) return own;
  for (const [suf, rep] of [["ies", "y"], ["ing", ""], ["ed", ""], ["es", ""], ["s", ""], ["ing", "e"], ["ed", "e"]] as const) {
    if (w.endsWith(suf) && w.length > suf.length + 2) {
      const base = w.slice(0, -suf.length) + rep;
      const l = (await shardFor(base, man))?.f[base];
      if (l) return l;
    }
  }
  return w;
}

const WORD = /[a-z]+(?:'[a-z]+)?/g;
const intersect = (a: number[], b: Set<number>) => a.filter((x) => b.has(x));

/** Sentence ids containing every query lemma (phrase order is checked later in materialize). */
export async function candidates(query: string): Promise<Candidates | null> {
  const words = query.toLowerCase().replace(/\u2019/g, "'").match(WORD) ?? [];
  if (!words.length) return null;
  const man = await loadManifest();
  const lemmas = await Promise.all(words.map((w) => lemmaOf(w, man)));
  const posts = await Promise.all(lemmas.map(async (l) => (await shardFor(l.toLowerCase(), man))?.p[l] ?? { m: [], u: [], n: [] }));
  const out: Candidates = { lemmas, m: [], u: [], n: [] };
  for (const k of ["m", "u", "n"] as const) {
    let ids = posts[0][k];
    for (const p of posts.slice(1)) ids = intersect(ids, new Set(p[k]));
    out[k] = ids;
  }
  return out;
}

const toSentence = (r: Row, id: number): Sentence => ({
  id,
  v: r[0],
  s: r[1],
  e: r[2],
  t: r[3],
  m: r[4],
  p: r[5],
  w: r[6],
  c: r[7] == null ? null : `${CLIP_BASE}/clips/${r[0]}/${r[7]}.mp4`,
});
export async function sentence(id: number): Promise<Sentence> {
  const man = await loadManifest();
  const rows = (await get<Row[]>(`s/${Math.floor(id / man.chunk)}.json?v=${man.version}`))!;
  return toSentence(rows[id % man.chunk], id);
}

/** Load the sentences for `ids` and return the exact phrase hits in them. */
export async function materialize(lemmas: string[], ids: number[]): Promise<Hit[]> {
  const man = await loadManifest();
  const sents = await Promise.all(ids.map(sentence));
  const hits: Hit[] = [];
  for (const s of sents) {
    for (let i = 0; i + lemmas.length <= s.w.length; i++) {
      if (lemmas.every((l, j) => s.w[i + j][0] === l)) {
        const a = s.w[i];
        const b = s.w[i + lemmas.length - 1];
        hits.push({ id: `${s.id}:${i}`, sentence: s, video: man.videos[s.v], start: a[1], end: b[2], from: a[3], to: b[4] });
      }
    }
  }
  return hits;
}

/** The sentence of `videoId` that covers time `t` (used to replay saved phrases). */
export async function findSentence(videoId: string, t: number): Promise<Sentence | null> {
  const man = await loadManifest();
  const v = man.videos[videoId];
  if (!v || v.r[0] == null) return null;
  let lo = v.r[0];
  let hi = v.r[1];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((await sentence(mid)).s <= t + 0.01) lo = mid;
    else hi = mid - 1;
  }
  return sentence(lo);
}

export const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
