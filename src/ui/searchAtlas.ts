import type { Atlas, WordRef } from "../atlas/types";

/** Lesson-list search only. A miss here is not a dictionary miss. */
export function searchAtlas(atlas: Atlas, raw: string, limit = 40): WordRef[] {
  const q = raw.trim().toLowerCase();
  if (!q) return [];
  const zh = /[一-鿿]/.test(q);
  const hits: [number, WordRef][] = [];
  for (const w of atlas.words) {
    let score = 0;
    if (zh) {
      const i = w.zh.indexOf(q);
      if (i >= 0) score = 60 - Math.min(40, i) - w.zh.length * 0.2;
    } else {
      const word = w.word.toLowerCase();
      if (word === q) score = 1000;
      else if (word.startsWith(q)) score = 500 - word.length;
      else if (word.includes(q)) score = 200 - word.indexOf(q) - word.length;
    }
    if (score > 0) hits.push([score, w]);
  }
  hits.sort((a, b) => b[0] - a[0] || a[1].order - b[1].order);
  return hits.slice(0, limit).map((h) => h[1]);
}
