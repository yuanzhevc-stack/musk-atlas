/** Shared request/response contract for Chinese expression suggestions.
 *  The worker and the browser both use this so a bad model payload cannot become a fake entry. */

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const EN = /[A-Za-z]/;

export const EXPRESS_LIMITS = {
  q: 120,
  context: 80,
  expression: 80,
  usage: 80,
  exampleEn: 140,
  exampleZh: 80,
  alts: 3,
} as const;

export interface Bilingual {
  en: string;
  zh: string;
}

export interface Expression {
  expression: string;
  usage: string;
  example?: Bilingual;
}

export interface SuggestionBody {
  primary: Expression & { example: Bilingual };
  alternatives: Expression[];
}

export type ExpressInput =
  | { ok: true; q: string; context: string }
  | { ok: false; error: "bad_json" | "empty" | "too_long" | "context_too_long" | "not_chinese" };

export function normalizeField(value: unknown) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function validateExpressInput(body: unknown): ExpressInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "bad_json" };
  const rec = body as { q?: unknown; context?: unknown };
  const q = normalizeField(rec.q);
  const context = normalizeField(rec.context ?? "");
  if (!q) return { ok: false, error: "empty" };
  if (q.length > EXPRESS_LIMITS.q) return { ok: false, error: "too_long" };
  if (context.length > EXPRESS_LIMITS.context) return { ok: false, error: "context_too_long" };
  if (!CJK.test(q)) return { ok: false, error: "not_chinese" };
  return { ok: true, q, context };
}

function clip(value: unknown, max: number) {
  return normalizeField(value).slice(0, max);
}

/** Single words lose a leading capital. The pronoun I stays. */
export function tidyExpression(value: unknown) {
  const text = clip(value, EXPRESS_LIMITS.expression);
  if (!EN.test(text) || CJK.test(text)) return "";
  return text
    .split(" ")
    .map((word) => (word === "I" ? word : word.toLowerCase()))
    .join(" ");
}

function exampleOf(value: unknown): Bilingual | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as { en?: unknown; zh?: unknown };
  const en = clip(rec.en, EXPRESS_LIMITS.exampleEn);
  const zh = clip(rec.zh, EXPRESS_LIMITS.exampleZh);
  if (!EN.test(en) || CJK.test(en) || !CJK.test(zh)) return null;
  return { en, zh };
}

/** Accept a model string (optionally fenced) or an already-parsed object. Drops every unknown field. */
export function parseSuggestion(raw: unknown): SuggestionBody | null {
  let data = raw;
  if (typeof raw === "string") {
    const text = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    try {
      data = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== "object") return null;
  const primary = (data as { primary?: unknown }).primary;
  if (!primary || typeof primary !== "object") return null;
  const p = primary as { expression?: unknown; usage?: unknown; example?: unknown };
  const expression = tidyExpression(p.expression);
  const usage = clip(p.usage, EXPRESS_LIMITS.usage);
  const example = exampleOf(p.example);
  if (!expression || !CJK.test(usage) || !example) return null;
  const alternatives: Expression[] = [];
  const alts = (data as { alternatives?: unknown }).alternatives;
  if (Array.isArray(alts)) {
    for (const item of alts) {
      if (alternatives.length >= EXPRESS_LIMITS.alts || !item || typeof item !== "object") continue;
      const row = item as { expression?: unknown; usage?: unknown; example?: unknown };
      const altExpression = tidyExpression(row.expression);
      const altUsage = clip(row.usage, EXPRESS_LIMITS.usage);
      if (!altExpression || altExpression === expression || !CJK.test(altUsage)) continue;
      const altExample = exampleOf(row.example);
      alternatives.push(altExample ? { expression: altExpression, usage: altUsage, example: altExample } : { expression: altExpression, usage: altUsage });
    }
  }
  return { primary: { expression, usage, example }, alternatives };
}
