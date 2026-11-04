/** Meanings for the reader panel: local Word Atlas lexicon (Chinese gloss) + dictionaryapi.dev (free, English), both optional. */
import type { Atlas } from "../atlas/types";

let lex: Map<string, { zh: string; id: string }> | null = null;
let lexOf: Atlas | null = null;
const forms = (w: string) => {
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
  for (const f of forms(key)) {
    const hit = lex!.get(f);
    if (hit) return { ...hit, word: f };
  }
  return null;
}

export interface Def {
  pos: string;
  text: string;
}
const cache = new Map<string, Promise<{ ipa?: string; defs: Def[] } | null>>();
export function lookup(key: string) {
  if (!cache.has(key)) {
    cache.set(
      key,
      fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(key)}`)
        .then(async (r) => {
          if (!r.ok) return r.status === 404 ? { defs: [] } : null;
          const data = (await r.json()) as { phonetic?: string; phonetics?: { text?: string }[]; meanings?: { partOfSpeech: string; definitions: { definition: string }[] }[] }[];
          const defs: Def[] = [];
          let ipa: string | undefined;
          for (const e of data) {
            ipa ??= e.phonetic || e.phonetics?.find((p) => p.text)?.text;
            for (const m of e.meanings ?? []) for (const d of m.definitions.slice(0, 2)) defs.push({ pos: m.partOfSpeech, text: d.definition });
          }
          return { ipa, defs: defs.slice(0, 5) };
        })
        .catch(() => {
          cache.delete(key);
          return null;
        }),
    );
  }
  return cache.get(key)!;
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
