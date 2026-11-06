/** Browser client for POST /express. Failures stay typed so the UI can say what happened.
 *  This module never turns a machine translation into an expression suggestion. */
import { parseSuggestion, type SuggestionBody } from "./expressContract";

export interface Suggestion extends SuggestionBody {
  source: "xai";
  model: string;
}

export type SuggestError = "unreachable" | "unconfigured" | "unavailable" | "rate" | "invalid" | "timeout" | "forbidden" | "too_long";

export type SuggestResult = { ok: true; data: Suggestion; cached: boolean } | { ok: false; error: SuggestError };

const LS = "musk-atlas:express:v1";
const memory = new Map<string, Suggestion>();

function expressUrl() {
  const env = import.meta.env as { VITE_EXPRESS_URL?: string } | undefined;
  const over = env?.VITE_EXPRESS_URL?.trim();
  return over || "https://musk-atlas-tts.yuanzhevc.workers.dev/express";
}

function cacheKey(q: string, context: string) {
  return `${q}\n${context}`;
}

function remember(key: string, value: Suggestion) {
  memory.set(key, value);
  try {
    const all = JSON.parse(localStorage.getItem(LS) || "{}") as Record<string, Suggestion>;
    all[key] = value;
    const keys = Object.keys(all);
    if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete all[k];
    localStorage.setItem(LS, JSON.stringify(all));
  } catch {
    /* private mode or quota */
  }
}

function recall(key: string): Suggestion | null {
  const hit = memory.get(key);
  if (hit) return hit;
  try {
    const all = JSON.parse(localStorage.getItem(LS) || "{}") as Record<string, unknown>;
    const parsed = parseSuggestion(all[key]);
    const row = all[key] as { source?: unknown; model?: unknown } | undefined;
    if (!parsed || row?.source !== "xai") return null;
    const data: Suggestion = { source: "xai", model: typeof row.model === "string" ? row.model : "", ...parsed };
    memory.set(key, data);
    return data;
  } catch {
    return null;
  }
}

export function resetSuggestForTests() {
  memory.clear();
}

function asError(status: number, body: { error?: unknown } | null): SuggestError {
  if (status === 403) return "forbidden";
  if (status === 404 || status === 405) return "unconfigured";
  if (status === 429) return "rate";
  if (status === 504) return "timeout";
  if (status === 503 && body?.error === "unconfigured") return "unconfigured";
  if (status === 503) return "unavailable";
  if ((status === 400 || status === 413) && !body) return "unconfigured";
  if (status === 413 || body?.error === "too_long" || body?.error === "context_too_long") return "too_long";
  return "invalid";
}

export async function suggestExpression(q: string, context = "", fetchImpl: typeof fetch = fetch): Promise<SuggestResult> {
  const key = cacheKey(q, context);
  const cached = recall(key);
  if (cached) return { ok: true, data: cached, cached: true };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 14000);
  try {
    const res = await fetchImpl(expressUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q, context }),
      signal: ctrl.signal,
    });
    const json = (res.headers.get("content-type") || "").includes("json");
    let body: { error?: unknown; source?: unknown; model?: unknown } | null = null;
    if (json) {
      try {
        body = (await res.json()) as { error?: unknown; source?: unknown; model?: unknown };
      } catch {
        body = null;
      }
    }
    if (!res.ok) return { ok: false, error: asError(res.status, body) };
    const parsed = parseSuggestion(body);
    if (!parsed || body?.source !== "xai") return { ok: false, error: "invalid" };
    const data: Suggestion = { source: "xai", model: typeof body.model === "string" ? body.model : "", ...parsed };
    remember(key, data);
    return { ok: true, data, cached: false };
  } catch (e) {
    if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) return { ok: false, error: "timeout" };
    return { ok: false, error: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
