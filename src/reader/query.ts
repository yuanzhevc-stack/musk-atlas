/** Classify the shared quick-search box. Chinese is recognized automatically; there is no language toggle. */

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

export function normalizeSpaces(raw: string) {
  return raw.replace(/[\u2018\u2019\u02bc]/g, "'").replace(/\s+/g, " ").trim();
}

/** Lowercase English lookup key: case, apostrophes, and repeated spaces collapse. Punctuation around the words is dropped. */
export function englishKey(raw: string) {
  return normalizeSpaces(raw)
    .toLowerCase()
    .replace(/[^a-z0-9' .-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .trim();
}

export function hasCJK(raw: string) {
  return CJK.test(raw);
}

export type QueryKind = { kind: "empty" } | { kind: "zh"; q: string } | { kind: "en"; key: string };

export function classifyQuery(raw: string): QueryKind {
  const spaced = normalizeSpaces(raw);
  if (!spaced) return { kind: "empty" };
  if (hasCJK(spaced)) return { kind: "zh", q: spaced.slice(0, 120) };
  const key = englishKey(spaced);
  if (!key || !/[a-z]/.test(key) || key.length > 80) return { kind: "empty" };
  return { kind: "en", key };
}
