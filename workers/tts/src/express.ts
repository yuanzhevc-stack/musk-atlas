/** POST /express — one natural English expression for a Chinese paraphrase.
 *  Uses the Worker’s existing XAI_API_KEY. Never log the key, the prompt, or the query.
 *  Bounded input, bounded output, a daily call cap, and a per-IP burst cap. */
import { parseSuggestion, validateExpressInput } from "../../../src/reader/expressContract";

export const EXPRESS_DEFAULT_MODEL = "grok-4.20-0309-non-reasoning";

const SYSTEM = `你帮中文使用者选一个自然的英文说法。只输出 JSON，不要 Markdown，不要解释。

格式：
{"primary":{"expression":"英文单词或短短语","usage":"一句简体中文：这种情境为什么用它，以及它不覆盖什么","example":{"en":"一句自然英文","zh":"对应简体中文"}},"alternatives":[{"expression":"另一种英文","usage":"一句简体中文，和首选差在哪里"}]}

规则：
- primary 只能有一个，选最贴合「中文」和「情境」的那个意思。
- 不要说它在所有场合都最地道，也不要说它是唯一正确译法。适用边界写进 usage。
- 别的说得通的意思放进 alternatives，最多 3 个。没有就给空数组。
- 例如「放手」可以是不再做一件事，也可以是松开手里的东西，这两种不能合成一个说法。
- 用户没写情境时，按最常见的日常意思选 primary，并在 usage 里点明不覆盖的另一种意思。
- expression 用英文。不要把整句中文逐字翻译成英文长句，除非用户是在问一整句话该怎么说。
- 不要编造任何人说过这句话，不要编造音标，不要输出例句以外的英文定义。
- usage 和 example.zh 必须是简体中文。`;

export interface BucketObject {
  json(): Promise<unknown>;
}
export interface ExpressBucket {
  get(key: string): Promise<BucketObject | null>;
  put(key: string, value: string): Promise<unknown>;
}
export interface ExpressEnv {
  BUCKET: ExpressBucket;
  XAI_API_KEY?: string;
  XAI_CHAT_MODEL?: string;
  EXPRESS_DAILY?: string;
}

const bursts = new Map<string, number[]>();

export function resetExpressForTests() {
  bursts.clear();
}

function allowBurst(ip: string) {
  const now = Date.now();
  if (bursts.size > 5000) bursts.clear();
  const recent = (bursts.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 12) {
    bursts.set(ip, recent);
    return false;
  }
  recent.push(now);
  bursts.set(ip, recent);
  return true;
}

function json(cors: Record<string, string>, status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" },
  });
}

async function sha256(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function contentOf(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const content = (payload as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) return String((part as { text?: unknown }).text ?? "");
      return "";
    })
    .join("");
}

function isTimeout(e: unknown) {
  return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
}

async function callModel(fetchImpl: typeof fetch, key: string, payload: Record<string, unknown>, timeoutMs: number) {
  const run = (body: unknown) =>
    fetchImpl("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  const first = await run(payload);
  if (first.status === 400 && "response_format" in payload) {
    const rest = { ...payload };
    delete rest.response_format;
    return run(rest);
  }
  return first;
}

export async function handleExpress(
  req: Request,
  env: ExpressEnv,
  cors: Record<string, string>,
  deps?: { fetchImpl?: typeof fetch; now?: () => Date; timeoutMs?: number },
): Promise<Response> {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const now = deps?.now ?? (() => new Date());
  const timeoutMs = deps?.timeoutMs ?? 12_000;
  const ip = req.headers.get("CF-Connecting-IP") || "local";
  if (!allowBurst(ip)) return json(cors, 429, { error: "rate" });

  let text = "";
  try {
    text = await req.text();
  } catch {
    return json(cors, 400, { error: "bad_json" });
  }
  if (text.length > 4096) return json(cors, 413, { error: "too_long" });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(cors, 400, { error: "bad_json" });
  }
  const input = validateExpressInput(body);
  if (!input.ok) {
    const status = input.error === "too_long" || input.error === "context_too_long" ? 413 : 400;
    return json(cors, status, { error: input.error });
  }
  if (!env.XAI_API_KEY) return json(cors, 503, { error: "unconfigured" });

  const model = (env.XAI_CHAT_MODEL || EXPRESS_DEFAULT_MODEL).trim() || EXPRESS_DEFAULT_MODEL;
  const cacheKey = `express/v1/${await sha256(`${model}\n${input.q}\n${input.context}`)}.json`;
  try {
    const hit = await env.BUCKET.get(cacheKey);
    if (hit) {
      const cached = parseSuggestion(await hit.json());
      if (cached) return json(cors, 200, { source: "xai", model, ...cached, cached: true });
    }
  } catch {
    /* unreadable cache: fall through and try the model */
  }

  const day = now().toISOString().slice(0, 10);
  const budgetKey = `express/_budget/${day}.json`;
  let used = 0;
  try {
    const row = (await (await env.BUCKET.get(budgetKey))?.json()) as { reqs?: number } | undefined;
    used = Number(row?.reqs ?? 0);
  } catch {
    return json(cors, 503, { error: "unavailable" });
  }
  const cap = Number(env.EXPRESS_DAILY || 200);
  if (!Number.isFinite(cap) || used >= cap) return json(cors, 429, { error: "rate" });
  try {
    await env.BUCKET.put(budgetKey, JSON.stringify({ reqs: used + 1 }));
  } catch {
    return json(cors, 503, { error: "unavailable" });
  }

  const payload: Record<string, unknown> = {
    model,
    temperature: 0.2,
    max_tokens: 400,
    stream: false,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `中文：${input.q}\n情境：${input.context || "（没有补充）"}` },
    ],
  };
  let upstream: Response;
  try {
    upstream = await callModel(fetchImpl, env.XAI_API_KEY, payload, timeoutMs);
  } catch (e) {
    if (isTimeout(e)) return json(cors, 504, { error: "timeout" });
    return json(cors, 502, { error: "upstream" });
  }
  if (upstream.status === 401 || upstream.status === 403) return json(cors, 503, { error: "unconfigured" });
  if (!upstream.ok) return json(cors, 502, { error: "upstream" });
  let completion: unknown;
  try {
    completion = await upstream.json();
  } catch {
    return json(cors, 502, { error: "bad_model" });
  }
  const parsed = parseSuggestion(contentOf(completion));
  if (!parsed) return json(cors, 502, { error: "bad_model" });
  const out = { source: "xai" as const, model, ...parsed, cached: false };
  try {
    await env.BUCKET.put(cacheKey, JSON.stringify(out));
  } catch {
    /* still return the answer */
  }
  return json(cors, 200, out);
}
