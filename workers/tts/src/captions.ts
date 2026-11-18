/**
 * Public YouTube captions for GET /captions.
 *
 * Player clients often answer LOGIN_REQUIRED ("Sign in to confirm you're not a bot")
 * from datacenter IPs and omit caption tracks even when the video has them.
 * That is a block. The watch page's transcript panel is a separate public call,
 * youtubei/v1/get_panel (panel id PAmodern_transcript_view). Its params are a
 * small protobuf of the video id: no cookies, no API key. It still returns
 * timed cues when the player clients are bot-checked.
 *
 * English is required. A panel in another language is no_english, an empty
 * panel on a video that exists is no_captions, and a failed panel after a
 * bot check is captions_blocked — never "this video has no captions".
 */
export interface CaptionObject {
  text(): Promise<string>;
}
export interface CaptionBucket {
  get(key: string): Promise<CaptionObject | null>;
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}
export interface CaptionEnv {
  BUCKET: CaptionBucket;
}

type Track = { baseUrl: string; languageCode: string; kind?: string };
type Seg = [number, number, string];

const WEB_CLIENT_VERSION = "2.20261116.00.00";
const PANEL_ID = "PAmodern_transcript_view";

const CLIENTS: { name: string; id: number; body: Record<string, unknown>; ua: string }[] = [
  // A bot check is often specific to one client. ANDROID and IOS still returned caption URLs from a datacenter VM on 2026-11-14; ANDROID_VR is the previous client, kept for IPs where the phone clients are refused.
  { name: "ANDROID", id: 3, ua: "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip", body: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30, osName: "Android", osVersion: "11" } },
  { name: "IOS", id: 5, ua: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)", body: { clientName: "IOS", clientVersion: "20.10.4", deviceMake: "Apple", deviceModel: "iPhone16,2", osName: "iPhone", osVersion: "18.3.2.22D82" } },
  { name: "ANDROID_VR", id: 28, ua: "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip", body: { clientName: "ANDROID_VR", clientVersion: "1.65.10", deviceMake: "Oculus", deviceModel: "Quest 3", androidSdkVersion: 32, osName: "Android", osVersion: "12L" } },
];

/** Field 149 of the transcript-panel params: video id + a one-byte flag. Matches the token embedded in the watch page. */
export function transcriptParams(videoId: string): string {
  const id = new TextEncoder().encode(videoId);
  const inner = new Uint8Array(2 + id.length + 2);
  inner[0] = 0x0a;
  inner[1] = id.length;
  inner.set(id, 2);
  inner[2 + id.length] = 0x18;
  inner[3 + id.length] = 0x01;
  const outer = new Uint8Array(3 + inner.length);
  outer[0] = 0xaa;
  outer[1] = 0x09;
  outer[2] = inner.length;
  outer.set(inner, 3);
  let bin = "";
  for (const b of outer) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function clockToMs(ts: string): number {
  const p = ts.split(":").map((n) => Number(n));
  if (!p.length || p.some((n) => !Number.isFinite(n))) return 0;
  if (p.length >= 3) return ((p[0] * 60 + p[1]) * 60 + p[2]) * 1000;
  if (p.length === 2) return (p[0] * 60 + p[1]) * 1000;
  return p[0] * 1000;
}

const EN_WORD = /\b(the|and|you|that|to|of|in|is|it|for|on|with|this|was|are|be|have|not|but|they|we|he|she|your|just|what|from|don't|it's|i'm|gonna|know|there|because|about|would|could|should|we're|you're|that's|have|here|so)\b/gi;
const ES_WORD = /\b(el|la|los|las|que|de|en|un|una|por|con|para|es|lo|su|del|al|si|yo|tú|te|mi|se|ya|hoy|contigo|más)\b/gi;
const NOISE_WORD = /^(music|applause|laughter|laughs|silence|singing)$/i;

/** en: readable English. other: another language. empty: no words to read (or only [Music] / ♪). */
export function classifyTranscript(text: string): "en" | "other" | "empty" {
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

export function kindFromText(texts: string[]): "manual" | "asr" {
  const n = texts.length || 1;
  const punct = texts.reduce((sum, t) => sum + (t.match(/[.!?]/g)?.length ?? 0), 0);
  return punct * 3 >= n ? "manual" : "asr";
}

export function segmentsFromPanel(json: unknown): { ms: number; text: string }[] {
  const out: { ms: number; text: string }[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const rec = node as Record<string, unknown>;
    const seg = rec.transcriptSegmentViewModel as { simpleText?: unknown; timestamp?: unknown } | undefined;
    if (seg && typeof seg.simpleText === "string") {
      const text = seg.simpleText.replace(/\s+/g, " ").trim();
      const ms = clockToMs(typeof seg.timestamp === "string" ? seg.timestamp : "");
      if (text) out.push({ ms, text });
    }
    for (const value of Object.values(rec)) {
      if (value && typeof value === "object") walk(value);
    }
  };
  walk(json);
  out.sort((a, b) => a.ms - b.ms);
  const deduped: { ms: number; text: string }[] = [];
  for (const seg of out) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.ms === seg.ms && prev.text === seg.text) continue;
    deduped.push(seg);
  }
  return deduped;
}

export function segmentsToCues(segs: { ms: number; text: string }[]): Seg[] {
  return segs.map((seg, i) => {
    const next = segs[i + 1]?.ms ?? seg.ms + 4000;
    const dur = next > seg.ms ? next - seg.ms : 4000;
    return [seg.ms, dur, seg.text];
  });
}

export function segmentsFromJson3(json: unknown): Seg[] {
  const events = (json as { events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string }[] }[] } | null)?.events ?? [];
  const segs: Seg[] = [];
  for (const event of events) {
    if (!event.segs) continue;
    const text = event.segs.map((s) => s.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
    if (text) segs.push([event.tStartMs ?? 0, event.dDurationMs ?? 0, text]);
  }
  return segs;
}

function englishTrack(tracks: Track[]): Track | null {
  const en = (t: Track) => /^en\b/i.test(t.languageCode);
  return tracks.find((t) => en(t) && t.kind !== "asr") ?? tracks.find((t) => en(t)) ?? null;
}

export type PlayerKind = "tracks" | "foreign" | "no_tracks" | "blocked" | "unavailable" | "age" | "none";

export function summarizePlayer(attempts: { status: string; reason: string; tracks: number; english: boolean; http: number }[]): PlayerKind {
  if (attempts.some((a) => a.english)) return "tracks";
  if (attempts.some((a) => a.tracks > 0)) return "foreign";
  if (!attempts.length) return "none";
  const reason = (a: { reason: string }) => a.reason.toLowerCase();
  if (attempts.some((a) => /age|inappropriate|confirm your age/.test(reason(a)))) return "age";
  if (attempts.some((a) => a.status === "OK")) return "no_tracks";
  if (attempts.some((a) => a.status === "ERROR" || /unavailable|private|removed|deleted/.test(reason(a)))) return "unavailable";
  if (attempts.some((a) => a.status === "LOGIN_REQUIRED" || a.status === "UNPLAYABLE" || a.http === 429 || a.http === 403)) return "blocked";
  return "blocked";
}

export function captionFailure(input: {
  player: PlayerKind;
  timedtext: "ok" | "empty" | "skipped";
  panel: "en" | "other" | "empty" | "failed" | "skipped";
  video: "exists" | "missing" | "unknown";
}): { error: string; status: number } | null {
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

type PlayerHit = {
  name: string;
  ua: string;
  http: number;
  status: string;
  reason: string;
  title: string;
  author: string;
  tracks: Track[];
};

async function playerOnce(videoId: string, client: (typeof CLIENTS)[number], fetchImpl: typeof fetch): Promise<PlayerHit> {
  const empty: PlayerHit = { name: client.name, ua: client.ua, http: 0, status: "net", reason: "", title: "", author: "", tracks: [] };
  const res = await fetchImpl("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": client.ua,
      "X-YouTube-Client-Name": String(client.id),
      "X-YouTube-Client-Version": String(client.body.clientVersion),
      Origin: "https://www.youtube.com",
    },
    body: JSON.stringify({
      videoId,
      context: { client: { ...client.body, hl: "en", gl: "US" } },
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  }).catch(() => null);
  if (!res) return empty;
  if (!res.ok) return { ...empty, http: res.status, status: String(res.status) };
  const json = (await res.json().catch(() => null)) as {
    playabilityStatus?: { status?: string; reason?: string };
    videoDetails?: { title?: string; author?: string };
    captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: Track[] } };
  } | null;
  const tracks = json?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  return {
    name: client.name,
    ua: client.ua,
    http: res.status,
    status: json?.playabilityStatus?.status ?? "?",
    reason: json?.playabilityStatus?.reason ?? "",
    title: json?.videoDetails?.title ?? "",
    author: json?.videoDetails?.author ?? "",
    tracks,
  };
}

async function fetchPanel(videoId: string, fetchImpl: typeof fetch): Promise<{ status: number; segs: { ms: number; text: string }[] }> {
  const res = await fetchImpl("https://www.youtube.com/youtubei/v1/get_panel?prettyPrint=false", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "X-YouTube-Client-Name": "1",
      "X-YouTube-Client-Version": WEB_CLIENT_VERSION,
      Origin: "https://www.youtube.com",
    },
    body: JSON.stringify({
      context: { client: { hl: "en", gl: "US", clientName: "WEB", clientVersion: WEB_CLIENT_VERSION } },
      panelId: PANEL_ID,
      params: transcriptParams(videoId),
    }),
  }).catch(() => null);
  if (!res || !res.ok) return { status: res?.status ?? 0, segs: [] };
  const json = await res.json().catch(() => null);
  return { status: res.status, segs: segmentsFromPanel(json) };
}

async function fetchOembed(videoId: string, fetchImpl: typeof fetch): Promise<{ title: string; author: string } | "missing" | "unknown"> {
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`;
  const res = await fetchImpl(url, { headers: { "User-Agent": "Mozilla/5.0" } }).catch(() => null);
  if (!res) return "unknown";
  if (res.status === 400 || res.status === 401 || res.status === 404) return "missing";
  if (!res.ok) return "unknown";
  const json = (await res.json().catch(() => null)) as { title?: unknown; author_name?: unknown } | null;
  if (!json) return "unknown";
  return { title: String(json.title ?? ""), author: String(json.author_name ?? "") };
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string>, cache?: "hit" | "miss") {
  const extra = cache ? { "X-TTS-Cache": cache } : {};
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8", ...extra },
  });
}

export async function handleCaptions(url: URL, env: CaptionEnv, headers: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const videoId = url.searchParams.get("v") ?? "";
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return new Response("bad video id", { status: 400, headers });
  const key = `yt/${videoId}.json`;
  const hit = await env.BUCKET.get(key);
  if (hit) return jsonResponse(await hit.text(), 200, headers, "hit");

  const hits: PlayerHit[] = [];
  for (const client of CLIENTS) {
    const hit = await playerOnce(videoId, client, fetchImpl);
    hits.push(hit);
    if (hit.tracks.length) break;
  }
  const attempts = hits.map((h) => ({
    status: h.status,
    reason: h.reason,
    tracks: h.tracks.length,
    english: englishTrack(h.tracks) !== null,
    http: h.http,
  }));
  const tried = hits.map((h) => `${h.name}:${h.status}:${h.tracks.length}`);
  const withTracks = hits.find((h) => h.tracks.length);
  const track = withTracks ? englishTrack(withTracks.tracks) : null;
  let title = withTracks?.title ?? "";
  let author = withTracks?.author ?? "";
  let segs: Seg[] = [];
  let kind: "manual" | "asr" = "asr";
  let via = "";
  let timedtext: "ok" | "empty" | "skipped" = "skipped";

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

  let panel: "en" | "other" | "empty" | "failed" | "skipped" = "skipped";
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
    let video: "exists" | "missing" | "unknown" = "unknown";
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
