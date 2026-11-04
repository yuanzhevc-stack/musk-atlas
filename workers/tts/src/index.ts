/**
 * musk-atlas-tts — tiny proxy for xAI text-to-speech (stock preset voice only; no cloning).
 * POST { text } -> audio/mpeg. Audio is cached in R2 at tts/<sha256>.mp3 so repeats are free.
 * GET /captions?v=<videoId> -> { v, title, lang, kind, segs:[[ms, durMs, text]] } — public YouTube captions
 * (manual English first, then auto), no cookies or accounts. Cached in R2 at yt/<id>.json.
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
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
    const url = new URL(req.url);
    if (url.pathname === "/captions" && req.method === "GET") return captions(url, env, h);
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

/* ---------- YouTube captions ---------- */
type Track = { baseUrl: string; languageCode: string; kind?: string; name?: { simpleText?: string; runs?: { text: string }[] } };
const CLIENTS: { name: string; id: number; body: Record<string, unknown>; ua: string }[] = [
  { name: "ANDROID_VR", id: 28, ua: "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip", body: { clientName: "ANDROID_VR", clientVersion: "1.60.19", deviceMake: "Oculus", deviceModel: "Quest 3", androidSdkVersion: 32, osName: "Android", osVersion: "12L" } },
  { name: "IOS", id: 5, ua: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)", body: { clientName: "IOS", clientVersion: "20.10.4", deviceMake: "Apple", deviceModel: "iPhone16,2", osName: "iPhone", osVersion: "18.3.2.22D82" } },
  { name: "WEB", id: 1, ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", body: { clientName: "WEB", clientVersion: "2.20250312.04.00" } },
];

async function player(v: string) {
  const tried: string[] = [];
  for (const c of CLIENTS) {
    const r = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": c.ua, "X-YouTube-Client-Name": String(c.id), "X-YouTube-Client-Version": String(c.body.clientVersion), Origin: "https://www.youtube.com" },
      body: JSON.stringify({ videoId: v, context: { client: { ...c.body, hl: "en", gl: "US" } }, contentCheckOk: true, racyCheckOk: true }),
    }).catch(() => null);
    if (!r || !r.ok) {
      tried.push(`${c.name}:${r?.status ?? "net"}`);
      continue;
    }
    const j = (await r.json()) as {
      playabilityStatus?: { status?: string; reason?: string };
      videoDetails?: { title?: string; author?: string; lengthSeconds?: string };
      captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: Track[] } };
    };
    const tracks = j.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    tried.push(`${c.name}:${j.playabilityStatus?.status ?? "?"}:${tracks.length}`);
    if (tracks.length) return { client: c, title: j.videoDetails?.title ?? "", author: j.videoDetails?.author ?? "", tracks, tried };
  }
  return { client: null, title: "", author: "", tracks: [] as Track[], tried };
}

function pick(tracks: Track[]) {
  const en = (t: Track) => /^en\b/i.test(t.languageCode);
  return tracks.find((t) => en(t) && t.kind !== "asr") ?? tracks.find((t) => en(t) && t.kind === "asr") ?? null;
}

async function captions(url: URL, env: Env, h: Record<string, string>) {
  const v = url.searchParams.get("v") ?? "";
  if (!/^[A-Za-z0-9_-]{11}$/.test(v)) return new Response("bad video id", { status: 400, headers: h });
  const json = { ...h, "Content-Type": "application/json; charset=utf-8" };
  const key = `yt/${v}.json`;
  const hit = await env.BUCKET.get(key);
  if (hit) return new Response(hit.body, { headers: { ...json, "X-TTS-Cache": "hit" } });

  const p = await player(v);
  const tr = pick(p.tracks);
  if (!tr) return new Response(JSON.stringify({ error: p.tracks.length ? "no_english" : "no_captions", tried: p.tried }), { status: 404, headers: json });
  const cu = new URL(tr.baseUrl.startsWith("http") ? tr.baseUrl : `https://www.youtube.com${tr.baseUrl}`);
  cu.searchParams.set("fmt", "json3");
  const r = await fetch(cu.toString(), { headers: { "User-Agent": p.client!.ua } });
  const body = r.ok ? await r.text() : "";
  if (!body) return new Response(JSON.stringify({ error: "timedtext_blocked", status: r.status, tried: p.tried }), { status: 502, headers: json });
  const ev = (JSON.parse(body) as { events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string; tOffsetMs?: number }[] }[] }).events ?? [];
  const segs: [number, number, string][] = [];
  for (const e of ev) {
    if (!e.segs) continue;
    const text = e.segs.map((s) => s.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
    if (text) segs.push([e.tStartMs ?? 0, e.dDurationMs ?? 0, text]);
  }
  if (!segs.length) return new Response(JSON.stringify({ error: "empty_captions", tried: p.tried }), { status: 502, headers: json });
  const out = JSON.stringify({ v, title: p.title, author: p.author, lang: tr.languageCode, kind: tr.kind === "asr" ? "asr" : "manual", via: p.client!.name, segs });
  await env.BUCKET.put(key, out, { httpMetadata: { contentType: "application/json" } });
  return new Response(out, { headers: { ...json, "X-TTS-Cache": "miss" } });
}
