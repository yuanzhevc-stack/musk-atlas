import { handleAccount } from "./account";
import { handleCaptions } from "./captions";
import { handleExpress } from "./express";
import { handleFullCache } from "./fullCache";

/**
 * musk-atlas-tts — tiny proxy for xAI text-to-speech (stock preset voice only; no cloning).
 * POST { text } -> audio/mpeg. Audio is cached in R2 at tts/<sha256>.mp3 so repeats are free.
 * POST /express { q, context? } -> one English expression for a Chinese paraphrase (same XAI_API_KEY, separate budget).
 * GET /captions?v=<videoId> -> { v, title, lang, kind, segs:[[ms, durMs, text]] } — public YouTube captions
 * (manual English first, then auto; the transcript panel when player clients are bot-checked).
 * No cookies. Study data for a signed-in account lives in R2 under acct/. The browser only keeps the session token.
 */
interface Env {
  BUCKET: R2Bucket;
  XAI_API_KEY: string;
  VOICE: string;
  DAILY_CHARS: string;
  /** Chat model for POST /express. Defaults in code when unset. */
  XAI_CHAT_MODEL?: string;
  /** New expression-model calls per UTC day. Cache hits are free. */
  EXPRESS_DAILY?: string;
  /** New full-video cache jobs per UTC day. The number enforced in code is 6. */
  FULL_DAILY?: string;
  /** Shared with the parent-run downloader. Not sent to the browser. */
  CACHE_JOB_SECRET?: string;
}

const ORIGINS = new Set([
  "https://yuanzhevc-stack.github.io",
  "http://localhost:5188",
  "http://127.0.0.1:5188",
  "http://localhost:5189",
  "http://127.0.0.1:5189",
]);
const MAX_CHARS = 600;

function asJobBucket(bucket: R2Bucket) {
  return {
    async get(key: string) {
      const obj = await bucket.get(key);
      if (!obj) return null;
      return { size: obj.size, text: () => obj.text() };
    },
    async head(key: string) {
      const obj = await bucket.head(key);
      return obj ? { size: obj.size } : null;
    },
    async put(key: string, value: string, opts?: { httpMetadata?: { contentType?: string; cacheControl?: string } }) {
      await bucket.put(key, value, opts);
    },
    async list(prefix: string) {
      const out: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const listed = await bucket.list({ prefix, limit: 100, cursor });
        for (const obj of listed.objects) out.push(obj.key);
        if (!listed.truncated) break;
        cursor = listed.cursor;
      }
      return out;
    },
    async createMultipart(key: string) {
      const opened = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: "video/mp4" } });
      return { uploadId: opened.uploadId };
    },
    async uploadPart(key: string, uploadId: string, partNumber: number, body: ArrayBuffer) {
      const part = await bucket.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, body);
      return { partNumber: part.partNumber, etag: part.etag };
    },
    async completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]) {
      await bucket.resumeMultipartUpload(key, uploadId).complete(parts);
    },
    async abortMultipart(key: string, uploadId: string) {
      await bucket.resumeMultipartUpload(key, uploadId).abort();
    },
  };
}

const cors = (origin: string) => ({
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
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
    const url = new URL(req.url);
    if (url.pathname === "/full/capability" || url.pathname === "/full/claim" || url.pathname === "/full/result" || url.pathname === "/full/progress" || url.pathname.startsWith("/full/upload/")) {
      return handleFullCache(req, asJobBucket(env.BUCKET), {}, { secret: env.CACHE_JOB_SECRET ?? "", now: Date.now() });
    }
    const origin = req.headers.get("Origin") ?? "";
    if (!ORIGINS.has(origin)) return new Response("forbidden", { status: 403 });
    const h = cors(origin);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    if (url.pathname.startsWith("/auth/") || url.pathname === "/library") return handleAccount(req, env.BUCKET, h, Date.now());
    if (url.pathname.startsWith("/full/")) return handleFullCache(req, asJobBucket(env.BUCKET), h, { secret: env.CACHE_JOB_SECRET ?? "", now: Date.now() });
    if (url.pathname === "/captions" && req.method === "GET") return handleCaptions(url, env, h);
    if (url.pathname === "/express") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: h });
      return handleExpress(req, env, h);
    }
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

