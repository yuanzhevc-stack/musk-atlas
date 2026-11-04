/**
 * musk-atlas-tts — tiny proxy for xAI text-to-speech (stock preset voice only; no cloning).
 * POST { text } -> audio/mpeg. Audio is cached in R2 at tts/<sha256>.mp3 so repeats are free.
 */
interface Env {
  BUCKET: R2Bucket;
  XAI_API_KEY: string;
  VOICE: string;
  DAILY_CHARS: string;
}

const ORIGINS = new Set(["https://yuanzhevc-stack.github.io", "http://localhost:5189"]);
const MAX_CHARS = 600;

const cors = (origin: string) => ({
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Expose-Headers": "X-TTS-Cache, X-TTS-Voice",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
});

async function sha256(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = req.headers.get("Origin") ?? "";
    if (!ORIGINS.has(origin)) return new Response("forbidden", { status: 403 });
    const h = cors(origin);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: h });

    let text = "";
    try {
      text = String(((await req.json()) as { text?: unknown }).text ?? "");
    } catch {
      return new Response("bad json", { status: 400, headers: h });
    }
    text = text.replace(/\s+/g, " ").trim();
    if (!text) return new Response("empty", { status: 400, headers: h });
    if (text.length > MAX_CHARS) return new Response(`text > ${MAX_CHARS} chars`, { status: 413, headers: h });

    const voice = env.VOICE || "rex";
    const key = `tts/${await sha256(`${voice}|en|1|${text}`)}.mp3`;
    const audioHeaders = { ...h, "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=31536000, immutable", "X-TTS-Voice": voice };

    const hit = await env.BUCKET.get(key);
    if (hit) return new Response(hit.body, { headers: { ...audioHeaders, "X-TTS-Cache": "hit" } });

    // Daily character budget (best effort, not atomic).
    const day = new Date().toISOString().slice(0, 10);
    const bkey = `tts/_budget/${day}.json`;
    const used = Number(((await (await env.BUCKET.get(bkey))?.json()) as { chars?: number } | undefined)?.chars ?? 0);
    if (used + text.length > Number(env.DAILY_CHARS || 200000)) return new Response("daily budget reached", { status: 429, headers: h });

    const r = await fetch("https://api.x.ai/v1/tts", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.XAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice_id: voice, language: "en", text_normalization: true, output_format: { codec: "mp3", sample_rate: 24000, bit_rate: 64000 } }),
    });
    if (!r.ok) return new Response(`upstream ${r.status}`, { status: 502, headers: h });
    const buf = await r.arrayBuffer();
    await Promise.all([
      env.BUCKET.put(key, buf, { httpMetadata: { contentType: "audio/mpeg" }, customMetadata: { voice, chars: String(text.length) } }),
      env.BUCKET.put(bkey, JSON.stringify({ chars: used + text.length })),
    ]);
    return new Response(buf, { headers: { ...audioHeaders, "X-TTS-Cache": "miss" } });
  },
};
