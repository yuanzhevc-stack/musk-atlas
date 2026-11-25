// workers/tts/src/account.ts
var SESSION_MS = 30 * 24 * 60 * 60 * 1e3;
var MAX_LIBRARY_BYTES = 5e6;
var PBKDF2_ITERATIONS = 1e5;
var emptyLibrary = (now) => ({ rev: 0, savedAt: now, lessons: [], items: {}, notes: {}, progress: null });
function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
async function sha256(bytes) {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length < 5 || email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}
function passwordOf(value) {
  if (typeof value !== "string" || value.length < 8 || value.length > 72) return null;
  return value;
}
async function pbkdf2(password, saltHex) {
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function readJson(bucket, key) {
  const obj = await bucket.get(key);
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text());
  } catch {
    return null;
  }
}
function bearer(req) {
  const header = req.headers.get("Authorization") ?? "";
  const match = /^Bearer ([a-f0-9]{64})$/i.exec(header);
  return match ? match[1].toLowerCase() : null;
}
async function userForToken(bucket, token, now) {
  const key = `acct/session/${await sha256(token)}`;
  const row = await readJson(bucket, key);
  if (!row || row.exp < now || !row.user || !row.email) {
    if (row) await bucket.delete(key);
    return null;
  }
  return { id: row.user, email: row.email };
}
function libraryOf(raw, now) {
  if (!raw || typeof raw !== "object") return null;
  const body = raw;
  if (!Array.isArray(body.lessons) || body.lessons.length > 500) return null;
  if (!body.items || typeof body.items !== "object" || Array.isArray(body.items)) return null;
  const notes = {};
  if (body.notes && typeof body.notes === "object" && !Array.isArray(body.notes)) {
    for (const [k, v] of Object.entries(body.notes)) {
      if (typeof v === "string" && k.length <= 80) notes[k] = v.slice(0, 2e3);
      if (Object.keys(notes).length >= 5e3) break;
    }
  }
  return {
    rev: 0,
    savedAt: now,
    lessons: body.lessons,
    items: body.items,
    notes,
    progress: body.progress && typeof body.progress === "object" ? body.progress : null
  };
}
async function handleAccount(req, bucket, headers, now) {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/auth/me") {
    const token = bearer(req);
    if (!token) return json({ error: "unauthorized" }, 401, headers);
    const user = await userForToken(bucket, token, now);
    if (!user) return json({ error: "unauthorized" }, 401, headers);
    return json({ email: user.email }, 200, headers);
  }
  if (req.method === "POST" && url.pathname === "/auth/logout") {
    const token = bearer(req);
    if (token) await bucket.delete(`acct/session/${await sha256(token)}`);
    return json({ ok: true }, 200, headers);
  }
  if (req.method === "POST" && (url.pathname === "/auth/register" || url.pathname === "/auth/login")) {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "bad-json" }, 400, headers);
    }
    const email = normalizeEmail(body.email);
    const password = passwordOf(body.password);
    if (!email || !password) return json({ error: "bad-login" }, 400, headers);
    const userId = await sha256(email);
    const userKey = `acct/user/${userId}`;
    const existing = await readJson(bucket, userKey);
    if (url.pathname === "/auth/register") {
      if (existing) return json({ error: "exists" }, 409, headers);
      const salt = randomHex(16);
      await bucket.put(userKey, JSON.stringify({ email, salt, hash: await pbkdf2(password, salt), created: now }));
    } else {
      if (!existing || !await safeEqualAsync(await pbkdf2(password, existing.salt), existing.hash)) return json({ error: "unauthorized" }, 401, headers);
    }
    const token = randomHex(32);
    await bucket.put(`acct/session/${await sha256(token)}`, JSON.stringify({ user: userId, email, exp: now + SESSION_MS }));
    return json({ email, token }, 200, headers);
  }
  if (url.pathname === "/library") {
    const token = bearer(req);
    if (!token) return json({ error: "unauthorized" }, 401, headers);
    const user = await userForToken(bucket, token, now);
    if (!user) return json({ error: "unauthorized" }, 401, headers);
    const key = `acct/lib/${user.id}`;
    if (req.method === "GET") return json(await readJson(bucket, key) ?? emptyLibrary(now), 200, headers);
    if (req.method !== "PUT") return json({ error: "method" }, 405, headers);
    const text = await req.text();
    if (text.length > MAX_LIBRARY_BYTES) return json({ error: "too-large" }, 413, headers);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return json({ error: "bad-json" }, 400, headers);
    }
    const next = libraryOf(parsed, now);
    if (!next || typeof parsed.baseRev !== "number") return json({ error: "bad-library" }, 400, headers);
    const current = await readJson(bucket, key) ?? emptyLibrary(now);
    if (parsed.baseRev !== current.rev) return json(current, 409, headers);
    next.rev = current.rev + 1;
    next.savedAt = now;
    await bucket.put(key, JSON.stringify(next));
    return json(next, 200, headers);
  }
  return json({ error: "not-found" }, 404, headers);
}
async function safeEqualAsync(a, b) {
  return safeEqual(a, b);
}

// workers/tts/src/captions.ts
var WEB_CLIENT_VERSION = "2.20261116.00.00";
var PANEL_ID = "PAmodern_transcript_view";
var CLIENTS = [
  // A bot check is often specific to one client. ANDROID and IOS still returned caption URLs from a datacenter VM on 2026-11-14; ANDROID_VR is the previous client, kept for IPs where the phone clients are refused.
  { name: "ANDROID", id: 3, ua: "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip", body: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30, osName: "Android", osVersion: "11" } },
  { name: "IOS", id: 5, ua: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)", body: { clientName: "IOS", clientVersion: "20.10.4", deviceMake: "Apple", deviceModel: "iPhone16,2", osName: "iPhone", osVersion: "18.3.2.22D82" } },
  { name: "ANDROID_VR", id: 28, ua: "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip", body: { clientName: "ANDROID_VR", clientVersion: "1.65.10", deviceMake: "Oculus", deviceModel: "Quest 3", androidSdkVersion: 32, osName: "Android", osVersion: "12L" } }
];
function transcriptParams(videoId) {
  const id = new TextEncoder().encode(videoId);
  const inner = new Uint8Array(2 + id.length + 2);
  inner[0] = 10;
  inner[1] = id.length;
  inner.set(id, 2);
  inner[2 + id.length] = 24;
  inner[3 + id.length] = 1;
  const outer = new Uint8Array(3 + inner.length);
  outer[0] = 170;
  outer[1] = 9;
  outer[2] = inner.length;
  outer.set(inner, 3);
  let bin = "";
  for (const b of outer) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function clockToMs(ts) {
  const p = ts.split(":").map((n) => Number(n));
  if (!p.length || p.some((n) => !Number.isFinite(n))) return 0;
  if (p.length >= 3) return ((p[0] * 60 + p[1]) * 60 + p[2]) * 1e3;
  if (p.length === 2) return (p[0] * 60 + p[1]) * 1e3;
  return p[0] * 1e3;
}
var EN_WORD = /\b(the|and|you|that|to|of|in|is|it|for|on|with|this|was|are|be|have|not|but|they|we|he|she|your|just|what|from|don't|it's|i'm|gonna|know|there|because|about|would|could|should|we're|you're|that's|have|here|so)\b/gi;
var ES_WORD = /\b(el|la|los|las|que|de|en|un|una|por|con|para|es|lo|su|del|al|si|yo|tú|te|mi|se|ya|hoy|contigo|más)\b/gi;
var NOISE_WORD = /^(music|applause|laughter|laughs|silence|singing)$/i;
function classifyTranscript(text) {
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
  const nonLatin = text.match(/[\u0370-\u03FF\u0400-\u04FF\u0590-\u08FF\u0900-\u097F\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g)?.length ?? 0;
  const words = (text.match(/[A-Za-z][A-Za-z']*/g) ?? []).filter((w) => !NOISE_WORD.test(w));
  if (nonLatin >= 8 && nonLatin > latin * 0.4) return "other";
  if (words.length < 6 && latin < 24) return "empty";
  const en = text.match(EN_WORD)?.length ?? 0;
  const es = text.match(ES_WORD)?.length ?? 0;
  if (es >= 4 && es > en) return "other";
  if (en >= 4 && en >= es) return "en";
  if (latin >= 40 && en >= 2 && nonLatin === 0) return "en";
  if (words.length >= 8 && en === 0) return "other";
  return en > 0 ? "en" : "empty";
}
function kindFromText(texts) {
  const n = texts.length || 1;
  const punct = texts.reduce((sum, t) => sum + (t.match(/[.!?]/g)?.length ?? 0), 0);
  return punct * 3 >= n ? "manual" : "asr";
}
function segmentsFromPanel(json4) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const rec = node;
    const seg = rec.transcriptSegmentViewModel;
    if (seg && typeof seg.simpleText === "string") {
      const text = seg.simpleText.replace(/\s+/g, " ").trim();
      const ms = clockToMs(typeof seg.timestamp === "string" ? seg.timestamp : "");
      if (text) out.push({ ms, text });
    }
    for (const value of Object.values(rec)) {
      if (value && typeof value === "object") walk(value);
    }
  };
  walk(json4);
  out.sort((a, b) => a.ms - b.ms);
  const deduped = [];
  for (const seg of out) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.ms === seg.ms && prev.text === seg.text) continue;
    deduped.push(seg);
  }
  return deduped;
}
function segmentsToCues(segs) {
  return segs.map((seg, i) => {
    const next = segs[i + 1]?.ms ?? seg.ms + 4e3;
    const dur = next > seg.ms ? next - seg.ms : 4e3;
    return [seg.ms, dur, seg.text];
  });
}
function segmentsFromJson3(json4) {
  const events = json4?.events ?? [];
  const segs = [];
  for (const event of events) {
    if (!event.segs) continue;
    const text = event.segs.map((s) => s.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
    if (text) segs.push([event.tStartMs ?? 0, event.dDurationMs ?? 0, text]);
  }
  return segs;
}
function englishTrack(tracks) {
  const en = (t) => /^en\b/i.test(t.languageCode);
  return tracks.find((t) => en(t) && t.kind !== "asr") ?? tracks.find((t) => en(t)) ?? null;
}
function summarizePlayer(attempts) {
  if (attempts.some((a) => a.english)) return "tracks";
  if (attempts.some((a) => a.tracks > 0)) return "foreign";
  if (!attempts.length) return "none";
  const reason = (a) => a.reason.toLowerCase();
  if (attempts.some((a) => /age|inappropriate|confirm your age/.test(reason(a)))) return "age";
  if (attempts.some((a) => a.status === "OK")) return "no_tracks";
  if (attempts.some((a) => a.status === "ERROR" || /unavailable|private|removed|deleted/.test(reason(a)))) return "unavailable";
  if (attempts.some((a) => a.status === "LOGIN_REQUIRED" || a.status === "UNPLAYABLE" || a.http === 429 || a.http === 403)) return "blocked";
  return "blocked";
}
function captionFailure(input) {
  if (input.player === "tracks" && input.timedtext === "ok") return null;
  if (input.panel === "en") return null;
  if (input.player === "foreign" || input.panel === "other") return { error: "no_english", status: 404 };
  if (input.player === "unavailable") return { error: "unavailable", status: 404 };
  if (input.player === "age") return { error: "age_restricted", status: 403 };
  if (input.player === "tracks" && input.timedtext === "empty") return { error: "timedtext_blocked", status: 502 };
  if (input.panel === "empty" && (input.player === "no_tracks" || input.video === "exists")) return { error: "no_captions", status: 404 };
  if (input.panel === "empty" && input.video === "missing") return { error: "unavailable", status: 404 };
  return { error: "captions_blocked", status: 503 };
}
async function playerOnce(videoId, client, fetchImpl) {
  const empty = { name: client.name, ua: client.ua, http: 0, status: "net", reason: "", title: "", author: "", tracks: [] };
  const res = await fetchImpl("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": client.ua,
      "X-YouTube-Client-Name": String(client.id),
      "X-YouTube-Client-Version": String(client.body.clientVersion),
      Origin: "https://www.youtube.com"
    },
    body: JSON.stringify({
      videoId,
      context: { client: { ...client.body, hl: "en", gl: "US" } },
      contentCheckOk: true,
      racyCheckOk: true
    })
  }).catch(() => null);
  if (!res) return empty;
  if (!res.ok) return { ...empty, http: res.status, status: String(res.status) };
  const json4 = await res.json().catch(() => null);
  const tracks = json4?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  return {
    name: client.name,
    ua: client.ua,
    http: res.status,
    status: json4?.playabilityStatus?.status ?? "?",
    reason: json4?.playabilityStatus?.reason ?? "",
    title: json4?.videoDetails?.title ?? "",
    author: json4?.videoDetails?.author ?? "",
    tracks
  };
}
async function fetchPanel(videoId, fetchImpl) {
  const res = await fetchImpl("https://www.youtube.com/youtubei/v1/get_panel?prettyPrint=false", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "X-YouTube-Client-Name": "1",
      "X-YouTube-Client-Version": WEB_CLIENT_VERSION,
      Origin: "https://www.youtube.com"
    },
    body: JSON.stringify({
      context: { client: { hl: "en", gl: "US", clientName: "WEB", clientVersion: WEB_CLIENT_VERSION } },
      panelId: PANEL_ID,
      params: transcriptParams(videoId)
    })
  }).catch(() => null);
  if (!res || !res.ok) return { status: res?.status ?? 0, segs: [] };
  const json4 = await res.json().catch(() => null);
  return { status: res.status, segs: segmentsFromPanel(json4) };
}
async function fetchOembed(videoId, fetchImpl) {
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`;
  const res = await fetchImpl(url, { headers: { "User-Agent": "Mozilla/5.0" } }).catch(() => null);
  if (!res) return "unknown";
  if (res.status === 400 || res.status === 401 || res.status === 404) return "missing";
  if (!res.ok) return "unknown";
  const json4 = await res.json().catch(() => null);
  if (!json4) return "unknown";
  return { title: String(json4.title ?? ""), author: String(json4.author_name ?? "") };
}
function jsonResponse(body, status, headers, cache) {
  const extra = cache ? { "X-TTS-Cache": cache } : {};
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8", ...extra }
  });
}
async function handleCaptions(url, env, headers, fetchImpl = fetch) {
  const videoId = url.searchParams.get("v") ?? "";
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return new Response("bad video id", { status: 400, headers });
  const key = `yt/${videoId}.json`;
  const hit = await env.BUCKET.get(key);
  if (hit) return jsonResponse(await hit.text(), 200, headers, "hit");
  const hits = [];
  for (const client of CLIENTS) {
    const hit2 = await playerOnce(videoId, client, fetchImpl);
    hits.push(hit2);
    if (hit2.tracks.length) break;
  }
  const attempts = hits.map((h) => ({
    status: h.status,
    reason: h.reason,
    tracks: h.tracks.length,
    english: englishTrack(h.tracks) !== null,
    http: h.http
  }));
  const tried = hits.map((h) => `${h.name}:${h.status}:${h.tracks.length}`);
  const withTracks = hits.find((h) => h.tracks.length);
  const track = withTracks ? englishTrack(withTracks.tracks) : null;
  let title = withTracks?.title ?? "";
  let author = withTracks?.author ?? "";
  let segs = [];
  let kind = "asr";
  let via = "";
  let timedtext = "skipped";
  if (track && withTracks) {
    const cueUrl = new URL(track.baseUrl.startsWith("http") ? track.baseUrl : `https://www.youtube.com${track.baseUrl}`);
    cueUrl.searchParams.set("fmt", "json3");
    const res = await fetchImpl(cueUrl.toString(), { headers: { "User-Agent": withTracks.ua } }).catch(() => null);
    const body = res?.ok ? await res.text() : "";
    if (body) {
      try {
        segs = segmentsFromJson3(JSON.parse(body));
      } catch {
        segs = [];
      }
    }
    timedtext = segs.length ? "ok" : "empty";
    if (segs.length) {
      kind = track.kind === "asr" ? "asr" : "manual";
      via = withTracks.name;
    }
  }
  let panel = "skipped";
  const player = summarizePlayer(attempts);
  if (!segs.length && player !== "foreign" && player !== "unavailable") {
    const got = await fetchPanel(videoId, fetchImpl);
    tried.push(got.status === 200 ? `PANEL:${got.segs.length}` : `PANEL:http:${got.status}`);
    if (got.status !== 200) panel = "failed";
    else {
      const text = got.segs.map((s) => s.text).join(" ");
      panel = got.segs.length ? classifyTranscript(text) : "empty";
      if (panel === "en") {
        segs = segmentsToCues(got.segs);
        kind = kindFromText(got.segs.map((s) => s.text));
        via = "panel";
      }
    }
  }
  if (!segs.length) {
    let video = "unknown";
    if (panel === "empty" && player !== "no_tracks") {
      const meta = await fetchOembed(videoId, fetchImpl);
      if (meta === "missing") video = "missing";
      else if (meta && meta !== "unknown") video = "exists";
    }
    const failure = captionFailure({ player, timedtext, panel, video }) ?? { error: "captions_blocked", status: 503 };
    return jsonResponse({ error: failure.error, tried }, failure.status, headers);
  }
  if (!title) {
    const meta = await fetchOembed(videoId, fetchImpl);
    if (meta && meta !== "missing" && meta !== "unknown") {
      title = meta.title;
      author = author || meta.author;
    }
  }
  const out = JSON.stringify({ v: videoId, title, author, lang: "en", kind, via, segs });
  await env.BUCKET.put(key, out, { httpMetadata: { contentType: "application/json" } });
  return jsonResponse(out, 200, headers, "miss");
}

// src/reader/expressContract.ts
var CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
var EN = /[A-Za-z]/;
var EXPRESS_LIMITS = {
  q: 120,
  context: 80,
  expression: 80,
  usage: 80,
  exampleEn: 140,
  exampleZh: 80,
  alts: 3
};
function normalizeField(value) {
  return String(value ?? "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
}
function validateExpressInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "bad_json" };
  const rec = body;
  const q = normalizeField(rec.q);
  const context = normalizeField(rec.context ?? "");
  if (!q) return { ok: false, error: "empty" };
  if (q.length > EXPRESS_LIMITS.q) return { ok: false, error: "too_long" };
  if (context.length > EXPRESS_LIMITS.context) return { ok: false, error: "context_too_long" };
  if (!CJK.test(q)) return { ok: false, error: "not_chinese" };
  return { ok: true, q, context };
}
function clip(value, max) {
  return normalizeField(value).slice(0, max);
}
function tidyExpression(value) {
  const text = clip(value, EXPRESS_LIMITS.expression);
  if (!EN.test(text) || CJK.test(text)) return "";
  return text.split(" ").map((word) => word === "I" ? word : word.toLowerCase()).join(" ");
}
function exampleOf(value) {
  if (!value || typeof value !== "object") return null;
  const rec = value;
  const en = clip(rec.en, EXPRESS_LIMITS.exampleEn);
  const zh = clip(rec.zh, EXPRESS_LIMITS.exampleZh);
  if (!EN.test(en) || CJK.test(en) || !CJK.test(zh)) return null;
  return { en, zh };
}
function parseSuggestion(raw) {
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
  const primary = data.primary;
  if (!primary || typeof primary !== "object") return null;
  const p = primary;
  const expression = tidyExpression(p.expression);
  const usage = clip(p.usage, EXPRESS_LIMITS.usage);
  const example = exampleOf(p.example);
  if (!expression || !CJK.test(usage) || !example) return null;
  const alternatives = [];
  const alts = data.alternatives;
  if (Array.isArray(alts)) {
    for (const item of alts) {
      if (alternatives.length >= EXPRESS_LIMITS.alts || !item || typeof item !== "object") continue;
      const row = item;
      const altExpression = tidyExpression(row.expression);
      const altUsage = clip(row.usage, EXPRESS_LIMITS.usage);
      if (!altExpression || altExpression === expression || !CJK.test(altUsage)) continue;
      const altExample = exampleOf(row.example);
      alternatives.push(altExample ? { expression: altExpression, usage: altUsage, example: altExample } : { expression: altExpression, usage: altUsage });
    }
  }
  return { primary: { expression, usage, example }, alternatives };
}

// workers/tts/src/express.ts
var EXPRESS_DEFAULT_MODEL = "grok-4.20-0309-non-reasoning";
var SYSTEM = `\u4F60\u5E2E\u4E2D\u6587\u4F7F\u7528\u8005\u9009\u4E00\u4E2A\u81EA\u7136\u7684\u82F1\u6587\u8BF4\u6CD5\u3002\u53EA\u8F93\u51FA JSON\uFF0C\u4E0D\u8981 Markdown\uFF0C\u4E0D\u8981\u89E3\u91CA\u3002

\u683C\u5F0F\uFF1A
{"primary":{"expression":"\u82F1\u6587\u5355\u8BCD\u6216\u77ED\u77ED\u8BED","usage":"\u4E00\u53E5\u7B80\u4F53\u4E2D\u6587\uFF1A\u8FD9\u79CD\u60C5\u5883\u4E3A\u4EC0\u4E48\u7528\u5B83\uFF0C\u4EE5\u53CA\u5B83\u4E0D\u8986\u76D6\u4EC0\u4E48","example":{"en":"\u4E00\u53E5\u81EA\u7136\u82F1\u6587","zh":"\u5BF9\u5E94\u7B80\u4F53\u4E2D\u6587"}},"alternatives":[{"expression":"\u53E6\u4E00\u79CD\u82F1\u6587","usage":"\u4E00\u53E5\u7B80\u4F53\u4E2D\u6587\uFF0C\u548C\u9996\u9009\u5DEE\u5728\u54EA\u91CC"}]}

\u89C4\u5219\uFF1A
- primary \u53EA\u80FD\u6709\u4E00\u4E2A\uFF0C\u9009\u6700\u8D34\u5408\u300C\u4E2D\u6587\u300D\u548C\u300C\u60C5\u5883\u300D\u7684\u90A3\u4E2A\u610F\u601D\u3002
- \u4E0D\u8981\u8BF4\u5B83\u5728\u6240\u6709\u573A\u5408\u90FD\u6700\u5730\u9053\uFF0C\u4E5F\u4E0D\u8981\u8BF4\u5B83\u662F\u552F\u4E00\u6B63\u786E\u8BD1\u6CD5\u3002\u9002\u7528\u8FB9\u754C\u5199\u8FDB usage\u3002
- \u522B\u7684\u8BF4\u5F97\u901A\u7684\u610F\u601D\u653E\u8FDB alternatives\uFF0C\u6700\u591A 3 \u4E2A\u3002\u6CA1\u6709\u5C31\u7ED9\u7A7A\u6570\u7EC4\u3002
- \u4F8B\u5982\u300C\u653E\u624B\u300D\u53EF\u4EE5\u662F\u4E0D\u518D\u505A\u4E00\u4EF6\u4E8B\uFF0C\u4E5F\u53EF\u4EE5\u662F\u677E\u5F00\u624B\u91CC\u7684\u4E1C\u897F\uFF0C\u8FD9\u4E24\u79CD\u4E0D\u80FD\u5408\u6210\u4E00\u4E2A\u8BF4\u6CD5\u3002
- \u7528\u6237\u6CA1\u5199\u60C5\u5883\u65F6\uFF0C\u6309\u6700\u5E38\u89C1\u7684\u65E5\u5E38\u610F\u601D\u9009 primary\uFF0C\u5E76\u5728 usage \u91CC\u70B9\u660E\u4E0D\u8986\u76D6\u7684\u53E6\u4E00\u79CD\u610F\u601D\u3002
- expression \u7528\u82F1\u6587\u3002\u4E0D\u8981\u628A\u6574\u53E5\u4E2D\u6587\u9010\u5B57\u7FFB\u8BD1\u6210\u82F1\u6587\u957F\u53E5\uFF0C\u9664\u975E\u7528\u6237\u662F\u5728\u95EE\u4E00\u6574\u53E5\u8BDD\u8BE5\u600E\u4E48\u8BF4\u3002
- \u4E0D\u8981\u7F16\u9020\u4EFB\u4F55\u4EBA\u8BF4\u8FC7\u8FD9\u53E5\u8BDD\uFF0C\u4E0D\u8981\u7F16\u9020\u97F3\u6807\uFF0C\u4E0D\u8981\u8F93\u51FA\u4F8B\u53E5\u4EE5\u5916\u7684\u82F1\u6587\u5B9A\u4E49\u3002
- usage \u548C example.zh \u5FC5\u987B\u662F\u7B80\u4F53\u4E2D\u6587\u3002`;
var bursts = /* @__PURE__ */ new Map();
function allowBurst(ip) {
  const now = Date.now();
  if (bursts.size > 5e3) bursts.clear();
  const recent = (bursts.get(ip) ?? []).filter((t) => now - t < 6e4);
  if (recent.length >= 12) {
    bursts.set(ip, recent);
    return false;
  }
  recent.push(now);
  bursts.set(ip, recent);
  return true;
}
function json2(cors2, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors2, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" }
  });
}
async function sha2562(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function contentOf(payload) {
  if (!payload || typeof payload !== "object") return "";
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && "text" in part) return String(part.text ?? "");
    return "";
  }).join("");
}
function isTimeout(e) {
  return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
}
async function callModel(fetchImpl, key, payload, timeoutMs) {
  const run = (body) => fetchImpl("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const first = await run(payload);
  if (first.status === 400 && "response_format" in payload) {
    const rest = { ...payload };
    delete rest.response_format;
    return run(rest);
  }
  return first;
}
async function handleExpress(req, env, cors2, deps) {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const now = deps?.now ?? (() => /* @__PURE__ */ new Date());
  const timeoutMs = deps?.timeoutMs ?? 12e3;
  const ip = req.headers.get("CF-Connecting-IP") || "local";
  if (!allowBurst(ip)) return json2(cors2, 429, { error: "rate" });
  let text = "";
  try {
    text = await req.text();
  } catch {
    return json2(cors2, 400, { error: "bad_json" });
  }
  if (text.length > 4096) return json2(cors2, 413, { error: "too_long" });
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json2(cors2, 400, { error: "bad_json" });
  }
  const input = validateExpressInput(body);
  if (!input.ok) {
    const status = input.error === "too_long" || input.error === "context_too_long" ? 413 : 400;
    return json2(cors2, status, { error: input.error });
  }
  if (!env.XAI_API_KEY) return json2(cors2, 503, { error: "unconfigured" });
  const model = (env.XAI_CHAT_MODEL || EXPRESS_DEFAULT_MODEL).trim() || EXPRESS_DEFAULT_MODEL;
  const cacheKey = `express/v1/${await sha2562(`${model}
${input.q}
${input.context}`)}.json`;
  try {
    const hit = await env.BUCKET.get(cacheKey);
    if (hit) {
      const cached = parseSuggestion(await hit.json());
      if (cached) return json2(cors2, 200, { source: "xai", model, ...cached, cached: true });
    }
  } catch {
  }
  const day = now().toISOString().slice(0, 10);
  const budgetKey2 = `express/_budget/${day}.json`;
  let used = 0;
  try {
    const row = await (await env.BUCKET.get(budgetKey2))?.json();
    used = Number(row?.reqs ?? 0);
  } catch {
    return json2(cors2, 503, { error: "unavailable" });
  }
  const cap = Number(env.EXPRESS_DAILY || 200);
  if (!Number.isFinite(cap) || used >= cap) return json2(cors2, 429, { error: "rate" });
  try {
    await env.BUCKET.put(budgetKey2, JSON.stringify({ reqs: used + 1 }));
  } catch {
    return json2(cors2, 503, { error: "unavailable" });
  }
  const payload = {
    model,
    temperature: 0.2,
    max_tokens: 400,
    stream: false,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `\u4E2D\u6587\uFF1A${input.q}
\u60C5\u5883\uFF1A${input.context || "\uFF08\u6CA1\u6709\u8865\u5145\uFF09"}` }
    ]
  };
  let upstream;
  try {
    upstream = await callModel(fetchImpl, env.XAI_API_KEY, payload, timeoutMs);
  } catch (e) {
    if (isTimeout(e)) return json2(cors2, 504, { error: "timeout" });
    return json2(cors2, 502, { error: "upstream" });
  }
  if (upstream.status === 401 || upstream.status === 403) return json2(cors2, 503, { error: "unconfigured" });
  if (!upstream.ok) return json2(cors2, 502, { error: "upstream" });
  let completion;
  try {
    completion = await upstream.json();
  } catch {
    return json2(cors2, 502, { error: "bad_model" });
  }
  const parsed = parseSuggestion(contentOf(completion));
  if (!parsed) return json2(cors2, 502, { error: "bad_model" });
  const out = { source: "xai", model, ...parsed, cached: false };
  try {
    await env.BUCKET.put(cacheKey, JSON.stringify(out));
  } catch {
  }
  return json2(cors2, 200, out);
}

// workers/tts/src/fullCache.ts
var YT_ID = /^[A-Za-z0-9_-]{11}$/;
var MAX_ATTEMPTS = 2;
var DAILY_NEW = 6;
var MAX_MANUAL_RETRIES = 2;
var DAILY_RETRIES = 6;
var MIN_FULL_BYTES = 2e6;
var MIN_FULL_SECONDS = 20;
var MIN_PART_BYTES = 5 * 1024 * 1024;
var MAX_PART_BYTES = 80 * 1024 * 1024;
var MAX_OBJECT_BYTES = 512 * 1024 * 1024;
var STALE_MS = 20 * 60 * 1e3;
var PUBLIC_BASE = "https://pub-ad0e50befa7b4387a7d73a8c8a796eb3.r2.dev";
var CACHE_CAPABILITY = { scope: "manual-only", maxHeight: 720, preferFps: 30, policy: "lte-720" };
var jobKey = (v) => `full/jobs/${v}.json`;
var readyKey = (v) => `full/ready/${v}.json`;
var mediaKey = (v) => `full/${v}.mp4`;
var fullMediaUrl = (v) => `${PUBLIC_BASE}/full/${v}.mp4`;
var uploadKey = (v) => `full/uploads/${v}.json`;
var budgetKey = (day) => `full/_budget/${day}.json`;
var retryBudgetKey = (day) => `full/_retry/${day}.json`;
function publicError(error) {
  if (!error) return void 0;
  const clean = error.replace(/bearer\s+\S+/gi, "[redacted]").replace(/(secret|token|authorization|api[_-]?key)\s*[=:]\s*\S+/gi, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 180);
  return clean || void 0;
}
function partSizeOk(size, isLast) {
  if (!Number.isFinite(size) || size <= 0 || size > MAX_PART_BYTES) return false;
  if (!isLast && size < MIN_PART_BYTES) return false;
  return true;
}
function youtubeOnly(input) {
  if (typeof input !== "string") return null;
  const v = input.trim();
  if (!YT_ID.test(v)) return null;
  if (v.includes("/") || v.includes(".")) return null;
  return v;
}
function bearerOk(header, secret) {
  if (!secret || !header?.startsWith("Bearer ")) return false;
  const got = header.slice("Bearer ".length);
  if (got.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}
function fresh(v, now, runner, origin) {
  return { v, status: "queued", attempts: 0, maxAttempts: MAX_ATTEMPTS, created: now, updated: now, runner, origin };
}
var CODEC = /^[A-Za-z0-9_.]{2,20}$/;
function mediaFacts(input) {
  if (!input) return {};
  const out = {};
  if (typeof input.width === "number" && input.width > 0 && input.width < 1e4) out.width = Math.round(input.width);
  if (typeof input.height === "number" && input.height > 0 && input.height < 1e4) out.height = Math.round(input.height);
  if (typeof input.fps === "number" && input.fps > 0 && input.fps < 240) out.fps = Math.round(input.fps * 1e3) / 1e3;
  if (typeof input.vcodec === "string" && CODEC.test(input.vcodec)) out.vcodec = input.vcodec;
  if (typeof input.acodec === "string" && CODEC.test(input.acodec)) out.acodec = input.acodec;
  return out;
}
async function readJob(bucket, v) {
  const obj = await bucket.get(jobKey(v));
  if (!obj) return null;
  try {
    const job = JSON.parse(await obj.text());
    if (job?.v !== v || !job.status) return null;
    return job;
  } catch {
    return null;
  }
}
async function writeJob(bucket, job) {
  await bucket.put(jobKey(job.v), JSON.stringify(job), {
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" }
  });
}
async function budget(bucket, now) {
  const key = budgetKey(new Date(now).toISOString().slice(0, 10));
  const obj = await bucket.get(key);
  let used = 0;
  if (obj) {
    try {
      used = Number(JSON.parse(await obj.text()).new ?? 0);
    } catch {
      used = 0;
    }
  }
  return { key, used };
}
async function enqueue(bucket, v, now, runner, origin = "legacy") {
  const ready = await bucket.get(readyKey(v));
  if (ready) {
    const job2 = await readJob(bucket, v) ?? fresh(v, now, runner, origin);
    return { status: 200, job: { ...job2, status: "ready", runner, updated: now } };
  }
  const existing = await readJob(bucket, v);
  if (existing && origin === "manual" && existing.origin !== "manual" && (existing.status === "queued" || existing.status === "failed")) {
    existing.origin = "manual";
    existing.status = "queued";
    existing.updated = now;
    existing.runner = runner;
    existing.error = void 0;
    if (existing.attempts >= MAX_ATTEMPTS) existing.attempts = 0;
    await writeJob(bucket, existing);
    return { status: 200, job: existing };
  }
  if (existing && existing.status === "running" && now - existing.updated > STALE_MS) {
    existing.status = "queued";
    existing.origin = "manual";
    existing.updated = now;
    existing.runner = runner;
    existing.error = void 0;
    if (existing.attempts >= MAX_ATTEMPTS) existing.attempts = Math.max(0, MAX_ATTEMPTS - 1);
    await writeJob(bucket, existing);
    return { status: 200, job: existing };
  }
  if (existing && (existing.status === "queued" || existing.status === "running" || existing.status === "ready" || existing.status === "refused")) {
    return { status: 200, job: { ...existing, runner } };
  }
  if (existing && existing.status === "failed" && existing.attempts >= MAX_ATTEMPTS) {
    return { status: 200, job: { ...existing, runner } };
  }
  const cap = await budget(bucket, now);
  if (!existing && cap.used >= DAILY_NEW) {
    const job2 = fresh(v, now, runner, origin);
    job2.status = "failed";
    job2.error = "daily-cap";
    return { status: 429, job: job2 };
  }
  const job = existing ?? fresh(v, now, runner, origin);
  job.status = "queued";
  job.updated = now;
  job.runner = runner;
  job.origin = existing?.origin ?? origin;
  job.error = void 0;
  await writeJob(bucket, job);
  if (!existing) await bucket.put(cap.key, JSON.stringify({ new: cap.used + 1 }), { httpMetadata: { contentType: "application/json" } });
  return { status: 200, job };
}
async function retryManual(bucket, v, now, runner) {
  const ready = await bucket.get(readyKey(v));
  if (ready) {
    const job = await readJob(bucket, v) ?? fresh(v, now, runner, "manual");
    return { status: 200, job: { ...job, status: "ready", runner, updated: now } };
  }
  const existing = await readJob(bucket, v);
  if (!existing) return enqueue(bucket, v, now, runner, "manual");
  if (existing.origin !== "manual" || existing.status === "refused" || existing.status === "queued" || existing.status === "running" || existing.status === "ready") {
    return { status: 200, job: { ...existing, runner } };
  }
  if (existing.status !== "failed") return { status: 200, job: { ...existing, runner } };
  if ((existing.manualRetries ?? 0) >= MAX_MANUAL_RETRIES) {
    return { status: 429, job: { ...existing, runner, error: "retry-cap" } };
  }
  const day = new Date(now).toISOString().slice(0, 10);
  const key = retryBudgetKey(day);
  const obj = await bucket.get(key);
  let used = 0;
  if (obj) {
    try {
      used = Number(JSON.parse(await obj.text()).n ?? 0);
    } catch {
      used = 0;
    }
  }
  if (used >= DAILY_RETRIES) return { status: 429, job: { ...existing, runner, error: "daily-cap" } };
  const prior = { at: existing.updated, status: existing.status, error: publicError(existing.error), attempts: existing.attempts };
  existing.history = [...existing.history ?? [], prior].slice(-6);
  existing.manualRetries = (existing.manualRetries ?? 0) + 1;
  existing.attempts = 0;
  existing.status = "queued";
  existing.error = void 0;
  existing.updated = now;
  existing.runner = runner;
  await writeJob(bucket, existing);
  await bucket.put(key, JSON.stringify({ n: used + 1 }), { httpMetadata: { contentType: "application/json" } });
  return { status: 200, job: existing };
}
async function claim(bucket, now) {
  const keys = await bucket.list("full/jobs/");
  const jobs = [];
  for (const key of keys) {
    if (!key.endsWith(".json") || key.includes("/_")) continue;
    const v = key.slice("full/jobs/".length, -".json".length);
    if (!youtubeOnly(v)) continue;
    const job2 = await readJob(bucket, v);
    if (job2) jobs.push(job2);
  }
  jobs.sort((a, b) => a.created - b.created);
  const manual = (j) => j.origin === "manual";
  const queued = jobs.find((j) => manual(j) && j.status === "queued" && j.attempts < MAX_ATTEMPTS);
  const stale = jobs.find((j) => (j.origin === "manual" || j.origin == null) && j.status === "running" && now - j.updated > STALE_MS && j.attempts < MAX_ATTEMPTS);
  const job = queued ?? stale;
  if (!job) return null;
  if (!job.origin) job.origin = "manual";
  if (job.status === "queued") job.attempts += 1;
  job.status = "running";
  job.updated = now;
  job.runner = "configured";
  await writeJob(bucket, job);
  return job;
}
async function noteProgress(bucket, v, now, progress) {
  const job = await readJob(bucket, v);
  if (!job || job.status !== "running") return null;
  job.progress = progress;
  job.updated = now;
  await writeJob(bucket, job);
  return job;
}
function acceptReady(headBytes, reportedBytes, duration) {
  if (headBytes == null) return "missing-object";
  if (!Number.isFinite(reportedBytes) || reportedBytes !== headBytes) return "size-mismatch";
  if (headBytes < MIN_FULL_BYTES) return "too-small";
  if (!Number.isFinite(duration) || duration < MIN_FULL_SECONDS) return "too-short";
  return null;
}
async function report(bucket, v, outcome, now, detail) {
  const job = await readJob(bucket, v) ?? fresh(v, now, "configured", "manual");
  job.updated = now;
  job.runner = "configured";
  const facts = mediaFacts(detail);
  if (outcome === "ready") {
    const head = await bucket.head(mediaKey(v));
    const reason = acceptReady(head?.size ?? null, detail.bytes ?? NaN, detail.duration ?? NaN);
    if (reason) {
      job.status = job.attempts >= MAX_ATTEMPTS ? "failed" : "queued";
      job.error = reason;
      await writeJob(bucket, job);
      return { status: 409, job };
    }
    const rec = { v, verified: true, bytes: detail.bytes, duration: detail.duration, url: fullMediaUrl(v), ...facts };
    if (rec.url.includes("/clips/")) {
      job.status = "failed";
      job.error = "clip-url";
      await writeJob(bucket, job);
      return { status: 409, job };
    }
    await bucket.put(readyKey(v), JSON.stringify(rec), {
      httpMetadata: { contentType: "application/json", cacheControl: "public, max-age=60" }
    });
    job.status = "ready";
    job.bytes = rec.bytes;
    job.duration = rec.duration;
    Object.assign(job, facts);
    job.error = void 0;
    await writeJob(bucket, job);
    return { status: 200, job };
  }
  job.error = publicError(detail.error ?? outcome);
  if (outcome === "refused") job.status = "refused";
  else job.status = job.attempts >= MAX_ATTEMPTS ? "failed" : "queued";
  await writeJob(bucket, job);
  return { status: 200, job };
}
function json3(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
async function handleFullCache(req, bucket, headers, opts) {
  const url = new URL(req.url);
  const authed = bearerOk(req.headers.get("Authorization"), opts.secret);
  const runner = opts.secret ? "configured" : "missing";
  if (url.pathname === "/full/upload/start" || url.pathname === "/full/upload/part" || url.pathname === "/full/upload/complete" || url.pathname === "/full/claim" || url.pathname === "/full/result" || url.pathname === "/full/progress") {
    if (!opts.secret) return json3({ error: "runner-not-configured" }, 503, headers);
    if (!authed) return json3({ error: "unauthorized" }, 401, headers);
  }
  if (url.pathname === "/full/upload/start") {
    if (req.method !== "POST") return json3({ error: "method" }, 405, headers);
    let body;
    try {
      body = await req.json();
    } catch {
      return json3({ error: "bad-json" }, 400, headers);
    }
    const v = youtubeOnly(body.v);
    if (!v) return json3({ error: "bad-video" }, 400, headers);
    const existing = await bucket.get(uploadKey(v));
    if (existing) {
      try {
        const prev = JSON.parse(await existing.text());
        if (prev.uploadId) await bucket.abortMultipart(mediaKey(v), prev.uploadId);
      } catch {
      }
    }
    const opened = await bucket.createMultipart(mediaKey(v));
    await bucket.put(uploadKey(v), JSON.stringify({ uploadId: opened.uploadId, created: opts.now }), {
      httpMetadata: { contentType: "application/json", cacheControl: "no-store" }
    });
    return json3({ v, uploadId: opened.uploadId }, 200, headers);
  }
  if (url.pathname === "/full/upload/part") {
    if (req.method !== "PUT") return json3({ error: "method" }, 405, headers);
    const v = youtubeOnly(url.searchParams.get("v"));
    const uploadId = url.searchParams.get("uploadId") ?? "";
    const partNumber = Number(url.searchParams.get("part"));
    const isLast = url.searchParams.get("last") === "1";
    if (!v || !uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 100) return json3({ error: "bad-part" }, 400, headers);
    const session = await bucket.get(uploadKey(v));
    const saved = session ? JSON.parse(await session.text()) : {};
    if (saved.uploadId !== uploadId) return json3({ error: "unknown-upload" }, 409, headers);
    const body = await req.arrayBuffer();
    if (!partSizeOk(body.byteLength, isLast)) return json3({ error: "bad-part-size" }, 413, headers);
    const part = await bucket.uploadPart(mediaKey(v), uploadId, partNumber, body);
    return json3(part, 200, headers);
  }
  if (url.pathname === "/full/upload/complete") {
    if (req.method !== "POST") return json3({ error: "method" }, 405, headers);
    let body;
    try {
      body = await req.json();
    } catch {
      return json3({ error: "bad-json" }, 400, headers);
    }
    const v = youtubeOnly(body.v);
    const uploadId = typeof body.uploadId === "string" ? body.uploadId : "";
    const parts = Array.isArray(body.parts) ? body.parts.flatMap((p) => {
      if (!p || typeof p !== "object") return [];
      const row = p;
      if (typeof row.partNumber !== "number" || typeof row.etag !== "string" || !row.etag) return [];
      return [{ partNumber: row.partNumber, etag: row.etag }];
    }) : [];
    if (!v || !uploadId || !parts.length) return json3({ error: "bad-video" }, 400, headers);
    const bytes = typeof body.bytes === "number" ? body.bytes : NaN;
    if (bytes > MAX_OBJECT_BYTES) return json3({ error: "too-large" }, 413, headers);
    const session = await bucket.get(uploadKey(v));
    const saved = session ? JSON.parse(await session.text()) : {};
    if (saved.uploadId !== uploadId) return json3({ error: "unknown-upload" }, 409, headers);
    await bucket.completeMultipart(mediaKey(v), uploadId, parts);
    const result = await report(bucket, v, "ready", opts.now, {
      bytes,
      duration: typeof body.duration === "number" ? body.duration : void 0,
      width: typeof body.width === "number" ? body.width : void 0,
      height: typeof body.height === "number" ? body.height : void 0,
      fps: typeof body.fps === "number" ? body.fps : void 0,
      vcodec: typeof body.vcodec === "string" ? body.vcodec : void 0,
      acodec: typeof body.acodec === "string" ? body.acodec : void 0
    });
    return json3(result.job, result.status, headers);
  }
  if (url.pathname === "/full/capability" && req.method === "GET") {
    return json3(CACHE_CAPABILITY, 200, headers);
  }
  if (url.pathname === "/full/claim") {
    if (req.method !== "POST") return json3({ error: "method" }, 405, headers);
    const job = await claim(bucket, opts.now);
    return json3({ job }, 200, headers);
  }
  if (url.pathname === "/full/result") {
    if (!opts.secret) return json3({ error: "runner-not-configured" }, 503, headers);
    if (!authed) return json3({ error: "unauthorized" }, 401, headers);
    if (req.method !== "POST") return json3({ error: "method" }, 405, headers);
    let body;
    try {
      body = await req.json();
    } catch {
      return json3({ error: "bad-json" }, 400, headers);
    }
    const v = youtubeOnly(body.v);
    const outcome = body.outcome === "ready" || body.outcome === "refused" || body.outcome === "failed" ? body.outcome : null;
    if (!v || !outcome) return json3({ error: "bad-video" }, 400, headers);
    const result = await report(bucket, v, outcome, opts.now, {
      bytes: typeof body.bytes === "number" ? body.bytes : void 0,
      duration: typeof body.duration === "number" ? body.duration : void 0,
      error: typeof body.error === "string" ? body.error : void 0,
      width: typeof body.width === "number" ? body.width : void 0,
      height: typeof body.height === "number" ? body.height : void 0,
      fps: typeof body.fps === "number" ? body.fps : void 0,
      vcodec: typeof body.vcodec === "string" ? body.vcodec : void 0,
      acodec: typeof body.acodec === "string" ? body.acodec : void 0
    });
    return json3(result.job, result.status, headers);
  }
  if (url.pathname === "/full/progress") {
    if (req.method !== "POST") return json3({ error: "method" }, 405, headers);
    let body;
    try {
      body = await req.json();
    } catch {
      return json3({ error: "bad-json" }, 400, headers);
    }
    const v = youtubeOnly(body.v);
    const phase = body.phase === "upload" ? "upload" : body.phase === "download" ? "download" : null;
    const received = typeof body.received === "number" && body.received >= 0 ? Math.floor(body.received) : null;
    if (!v || !phase || received == null) return json3({ error: "bad-video" }, 400, headers);
    const total = typeof body.total === "number" && body.total > 0 ? Math.floor(body.total) : void 0;
    const job = await noteProgress(bucket, v, opts.now, { phase, received, total });
    if (!job) return json3({ error: "no-job" }, 404, headers);
    return json3({ ...job, runner }, 200, headers);
  }
  if (url.pathname === "/full/jobs" && req.method === "GET") {
    const v = youtubeOnly(url.searchParams.get("v"));
    if (!v) return json3({ error: "bad-video" }, 400, headers);
    const ready = await bucket.get(readyKey(v));
    if (ready) {
      try {
        const rec = JSON.parse(await ready.text());
        if (rec.verified && rec.v === v && !rec.url.includes("/clips/") && rec.bytes >= MIN_FULL_BYTES && rec.duration >= MIN_FULL_SECONDS) {
          return json3({ ...await readJob(bucket, v), ...rec, v, status: "ready", url: fullMediaUrl(v), runner }, 200, headers);
        }
      } catch {
      }
    }
    const job = await readJob(bucket, v);
    return json3(job ? { ...job, runner } : { v, status: "unknown", runner }, 200, headers);
  }
  if (url.pathname === "/full/jobs" && req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return json3({ error: "bad-json" }, 400, headers);
    }
    if ("url" in body) return json3({ error: "id-only" }, 400, headers);
    const v = youtubeOnly(body.v);
    if (!v) return json3({ error: "bad-video" }, 400, headers);
    if (body.origin !== "manual") {
      const ready = await bucket.get(readyKey(v));
      const existing = await readJob(bucket, v);
      if (ready) return json3({ ...existing ?? { v }, v, status: "ready", runner }, 200, headers);
      return json3(existing ? { ...existing, runner } : { v, status: "unknown", runner }, 200, headers);
    }
    const result = body.retry === true ? await retryManual(bucket, v, opts.now, runner) : await enqueue(bucket, v, opts.now, runner, "manual");
    return json3(result.job, result.status, headers);
  }
  return json3({ error: "not-found" }, 404, headers);
}

// workers/tts/src/index.ts
var ORIGINS = /* @__PURE__ */ new Set([
  "https://yuanzhevc-stack.github.io",
  "http://localhost:5188",
  "http://127.0.0.1:5188",
  "http://localhost:5189",
  "http://127.0.0.1:5189"
]);
var MAX_CHARS = 600;
function asJobBucket(bucket) {
  return {
    async get(key) {
      const obj = await bucket.get(key);
      if (!obj) return null;
      return { size: obj.size, text: () => obj.text() };
    },
    async head(key) {
      const obj = await bucket.head(key);
      return obj ? { size: obj.size } : null;
    },
    async put(key, value, opts) {
      await bucket.put(key, value, opts);
    },
    async list(prefix) {
      const out = [];
      let cursor;
      for (let page = 0; page < 5; page++) {
        const listed = await bucket.list({ prefix, limit: 100, cursor });
        for (const obj of listed.objects) out.push(obj.key);
        if (!listed.truncated) break;
        cursor = listed.cursor;
      }
      return out;
    },
    async createMultipart(key) {
      const opened = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: "video/mp4" } });
      return { uploadId: opened.uploadId };
    },
    async uploadPart(key, uploadId, partNumber, body) {
      const part = await bucket.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, body);
      return { partNumber: part.partNumber, etag: part.etag };
    },
    async completeMultipart(key, uploadId, parts) {
      await bucket.resumeMultipartUpload(key, uploadId).complete(parts);
    },
    async abortMultipart(key, uploadId) {
      await bucket.resumeMultipartUpload(key, uploadId).abort();
    }
  };
}
var cors = (origin) => ({
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Expose-Headers": "X-TTS-Cache, X-TTS-Voice",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin"
});
async function sha2563(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
var index_default = {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/full/capability" || url.pathname === "/full/claim" || url.pathname === "/full/result" || url.pathname.startsWith("/full/upload/")) {
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
      text = String((await req.json()).text ?? "");
    } catch {
      return new Response("bad json", { status: 400, headers: h });
    }
    text = text.replace(/\s+/g, " ").trim();
    if (!text) return new Response("empty", { status: 400, headers: h });
    if (text.length > MAX_CHARS) return new Response(`text > ${MAX_CHARS} chars`, { status: 413, headers: h });
    const voice = env.VOICE || "rex";
    const key = `tts/${await sha2563(`${voice}|en|1|${text}`)}.mp3`;
    const audioHeaders = { ...h, "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=31536000, immutable", "X-TTS-Voice": voice };
    const hit = await env.BUCKET.get(key);
    if (hit) return new Response(hit.body, { headers: { ...audioHeaders, "X-TTS-Cache": "hit" } });
    const day = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    const bkey = `tts/_budget/${day}.json`;
    const used = Number((await (await env.BUCKET.get(bkey))?.json())?.chars ?? 0);
    if (used + text.length > Number(env.DAILY_CHARS || 2e5)) return new Response("daily budget reached", { status: 429, headers: h });
    const r = await fetch("https://api.x.ai/v1/tts", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.XAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice_id: voice, language: "en", text_normalization: true, output_format: { codec: "mp3", sample_rate: 24e3, bit_rate: 64e3 } })
    });
    if (!r.ok) return new Response(`upstream ${r.status}`, { status: 502, headers: h });
    const buf = await r.arrayBuffer();
    await Promise.all([
      env.BUCKET.put(key, buf, { httpMetadata: { contentType: "audio/mpeg" }, customMetadata: { voice, chars: String(text.length) } }),
      env.BUCKET.put(bkey, JSON.stringify({ chars: used + text.length }))
    ]);
    return new Response(buf, { headers: { ...audioHeaders, "X-TTS-Cache": "miss" } });
  }
};
export {
  index_default as default
};
