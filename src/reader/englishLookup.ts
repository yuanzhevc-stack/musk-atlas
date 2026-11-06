/** Exact English lookup for the quick-search box. One shard on demand; the full dictionary is never loaded. */
import type { DictHit } from "./dict";
import { ecdict, lookup, translate } from "./dict";
import { classifyQuery } from "./query";

export interface Sense {
  text: string;
  src: "词典" | "英英" | "机器翻译";
}

export interface LookupView {
  key: string;
  headword: string;
  formNote: string;
  ipa: string;
  senses: Sense[];
  /** Gloss stored on the personal corpus item. */
  meaning: string;
}

export type EnglishResult =
  | { kind: "empty" }
  | { kind: "hit"; via: "dict" | "online"; dictDown: boolean; view: LookupView }
  | { kind: "miss"; key: string; dictDown: boolean; onlineDown: boolean };

function inflectionOnly(zh: string[]) {
  const text = zh.join("").replace(/\s+/g, "");
  if (!text || text.length > 48) return false;
  return /的(过去式|过去分词|现在分词|第三人称|复数形式|比较级|最高级|动名词)/.test(text);
}

export function presentDict(key: string, hits: DictHit[]): LookupView {
  const own = hits.find((h) => !h.lemma);
  const lem = hits.find((h) => h.lemma);
  const head = own && inflectionOnly(own.zh) && lem ? lem : (own ?? lem ?? hits[0]);
  const zh = [...head.zh];
  const en = [...head.en];
  if (head === own && lem) {
    for (const line of lem.zh) if (line && !zh.includes(line) && !inflectionOnly([line])) zh.push(line);
    for (const line of lem.en) if (line && !en.includes(line)) en.push(line);
  }
  const senses: Sense[] = [
    ...zh.slice(0, 4).map((text) => ({ text, src: "词典" as const })),
    ...en.filter(Boolean).slice(0, 2).map((text) => ({ text, src: "英英" as const })),
  ];
  let formNote = "";
  if (head.key !== key) formNote = `「${key}」按原形「${head.key}」查到。`;
  else if (lem && lem.key !== key) formNote = `另见原形「${lem.key}」。`;
  const ipa = (head.ipa || own?.ipa || lem?.ipa || "").replace(/^\/|\/$/g, "");
  return { key, headword: head.key, formNote, ipa, senses, meaning: zh.slice(0, 3).join("；") };
}

export async function lookupEnglish(raw: string): Promise<EnglishResult> {
  const kind = classifyQuery(raw);
  if (kind.kind !== "en") return { kind: "empty" };
  const key = kind.key;
  let dictDown = false;
  let hits: DictHit[] | null = null;
  try {
    hits = await ecdict(key);
  } catch {
    dictDown = true;
  }
  if (hits?.length) {
    const view = presentDict(key, hits);
    if (view.senses.length) return { kind: "hit", via: "dict", dictDown: false, view };
  }
  const words = key.split(" ").length;
  const api = words <= 2 ? await lookup(key) : { ipa: undefined as string | undefined, defs: [] as { pos: string; text: string }[] };
  const mt = await translate(key);
  const senses: Sense[] = [];
  if (mt) senses.push({ text: mt, src: "机器翻译" });
  if (api?.defs?.length) for (const d of api.defs.slice(0, 3)) senses.push({ text: `${d.pos}. ${d.text}`, src: "英英" });
  if (senses.length) {
    return {
      kind: "hit",
      via: "online",
      dictDown,
      view: { key, headword: key, formNote: "", ipa: api?.ipa || "", senses, meaning: senses[0].text },
    };
  }
  const apiDown = words <= 2 && api === null;
  const mtDown = mt === null;
  return { kind: "miss", key, dictDown, onlineDown: words <= 2 ? apiDown && mtDown : mtDown };
}

/** Dictionary gloss for a model-suggested headword. Does not call machine translation. */
export async function dictGloss(raw: string): Promise<{ ipa: string; zh: string; down: boolean }> {
  const kind = classifyQuery(raw);
  const key = kind.kind === "en" ? kind.key : "";
  if (!key) return { ipa: "", zh: "", down: false };
  try {
    const hits = await ecdict(key);
    if (!hits.length) return { ipa: "", zh: "", down: false };
    const view = presentDict(key, hits);
    return { ipa: view.ipa, zh: view.senses.filter((s) => s.src === "词典").map((s) => s.text).join("；"), down: false };
  } catch {
    return { ipa: "", zh: "", down: true };
  }
}
