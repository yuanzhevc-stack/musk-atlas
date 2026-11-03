/** Static Musk corpus: sentences with word-level timestamps, searched by lemma. */
export interface Video {
  title: string;
  channel: string;
  duration: number | null;
  source: string;
  speaker: boolean;
}
/** [lemma, start, end, charStart, charEnd] */
export type Tok = [string, number, number, number, number];
export interface Sentence {
  v: string;
  s: number;
  e: number;
  t: string;
  k: "musk" | "host" | null;
  w: Tok[];
}
export interface Corpus {
  videos: Record<string, Video>;
  forms: Record<string, string>;
  sentences: Sentence[];
}
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

let pending: Promise<Corpus> | null = null;
export function loadCorpus() {
  pending ??= fetch(`${import.meta.env.BASE_URL}musk/corpus.json`).then((r) => {
    if (!r.ok) throw new Error(`语料加载失败（${r.status}）`);
    return r.json() as Promise<Corpus>;
  });
  return pending;
}

const WORD = /[a-z]+(?:'[a-z]+)?/g;

/** Map a typed word to the corpus lemma; light suffix fallback for unseen forms. */
export function lemmaOf(c: Corpus, w: string): string {
  if (c.forms[w]) return c.forms[w];
  for (const [suf, rep] of [["ies", "y"], ["ing", ""], ["ed", ""], ["es", ""], ["s", ""], ["ing", "e"], ["ed", "e"]] as const) {
    if (w.endsWith(suf) && w.length > suf.length + 2) {
      const base = w.slice(0, -suf.length) + rep;
      if (c.forms[base]) return c.forms[base];
    }
  }
  return w;
}

export function search(c: Corpus, query: string): Hit[] {
  const words = query.toLowerCase().replace(/\u2019/g, "'").match(WORD) ?? [];
  if (!words.length) return [];
  const lemmas = words.map((w) => lemmaOf(c, w));
  const hits: Hit[] = [];
  c.sentences.forEach((s, si) => {
    for (let i = 0; i + lemmas.length <= s.w.length; i++) {
      if (lemmas.every((l, j) => s.w[i + j][0] === l)) {
        const a = s.w[i];
        const b = s.w[i + lemmas.length - 1];
        hits.push({ id: `${si}:${i}`, sentence: s, video: c.videos[s.v], start: a[1], end: b[2], from: a[3], to: b[4] });
      }
    }
  });
  return hits;
}

export const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
