import assert from "node:assert/strict";
import { test } from "node:test";
import {
  captionFailure,
  classifyTranscript,
  clockToMs,
  handleCaptions,
  kindFromText,
  segmentsFromJson3,
  segmentsFromPanel,
  summarizePlayer,
  transcriptParams,
  type CaptionBucket,
} from "./captions";

function bucket(): CaptionBucket & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) {
      const value = store.get(key);
      if (value === undefined) return null;
      return { async text() { return value; } };
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

const headers = { "Access-Control-Allow-Origin": "https://yuanzhevc-stack.github.io" };
const video = "cdZZpaB2kDM";

function panelBody(segs: { timestamp: string; simpleText: string }[]) {
  return {
    content: {
      engagementPanelSectionListRenderer: {
        content: { contents: segs.map((s) => ({ transcriptSegmentViewModel: s })) },
      },
    },
  };
}

function playerBody(status: string, reason: string, tracks: { languageCode: string; kind?: string; baseUrl?: string }[] = [], title = "") {
  return {
    playabilityStatus: { status, reason },
    videoDetails: title ? { title, author: "TED" } : {},
    captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks.map((t) => ({ ...t, baseUrl: t.baseUrl ?? "https://www.youtube.com/api/timedtext?v=x" })) } },
  };
}

test("transcript params match the token embedded in the watch page", () => {
  assert.equal(transcriptParams("cdZZpaB2kDM"), "qgkPCgtjZFpacGFCMmtETRgB");
  assert.equal(transcriptParams("9bZkp7q19f0"), "qgkPCgs5YlprcDdxMTlmMBgB");
  assert.equal(clockToMs("0:02"), 2000);
  assert.equal(clockToMs("54:34"), (54 * 60 + 34) * 1000);
  assert.equal(clockToMs("1:02:03"), ((1 * 60 + 2) * 60 + 3) * 1000);
});

test("classifyTranscript separates English, other languages, and noise", () => {
  assert.equal(classifyTranscript("The reason we are here is that you have to see this from the start."), "en");
  assert.equal(classifyTranscript("hello so in just a few minutes we will be here on stage and you know that this is the talk"), "en");
  assert.equal(classifyTranscript("Si sabes que ya llevo un rato mirandote tengo que bailar contigo hoy y el camino."), "other");
  assert.equal(classifyTranscript("오반 강남 스타일 강남스타일 오빤 강남스타일"), "other");
  assert.equal(classifyTranscript("♪ ♪ [♪♪♪]"), "empty");
  assert.equal(classifyTranscript("[Music] [Music] [Music] [Applause]"), "empty");
  assert.equal(kindFromText(["Hello there.", "This is a full sentence!"]), "manual");
  assert.equal(kindFromText(["hello there", "we will see"]), "asr");
});

test("player and panel outcomes do not call a bot check 'no captions'", () => {
  assert.equal(summarizePlayer([{ status: "LOGIN_REQUIRED", reason: "Sign in to confirm you’re not a bot", tracks: 0, english: false, http: 200 }]), "blocked");
  assert.equal(summarizePlayer([{ status: "OK", reason: "", tracks: 0, english: false, http: 200 }]), "no_tracks");
  assert.equal(summarizePlayer([{ status: "OK", reason: "", tracks: 2, english: false, http: 200 }]), "foreign");
  assert.equal(summarizePlayer([{ status: "OK", reason: "", tracks: 2, english: true, http: 200 }]), "tracks");
  assert.deepEqual(captionFailure({ player: "blocked", timedtext: "skipped", panel: "en", video: "unknown" }), null);
  assert.deepEqual(captionFailure({ player: "blocked", timedtext: "skipped", panel: "other", video: "exists" }), { error: "no_english", status: 404 });
  assert.deepEqual(captionFailure({ player: "blocked", timedtext: "skipped", panel: "empty", video: "exists" }), { error: "no_captions", status: 404 });
  assert.deepEqual(captionFailure({ player: "blocked", timedtext: "skipped", panel: "empty", video: "missing" }), { error: "unavailable", status: 404 });
  assert.deepEqual(captionFailure({ player: "blocked", timedtext: "skipped", panel: "empty", video: "unknown" }), { error: "captions_blocked", status: 503 });
  assert.deepEqual(captionFailure({ player: "blocked", timedtext: "skipped", panel: "failed", video: "exists" }), { error: "captions_blocked", status: 503 });
  assert.deepEqual(captionFailure({ player: "no_tracks", timedtext: "skipped", panel: "empty", video: "unknown" }), { error: "no_captions", status: 404 });
  assert.deepEqual(captionFailure({ player: "foreign", timedtext: "skipped", panel: "skipped", video: "exists" }), { error: "no_english", status: 404 });
  assert.deepEqual(captionFailure({ player: "tracks", timedtext: "empty", panel: "failed", video: "exists" }), { error: "timedtext_blocked", status: 502 });
  assert.deepEqual(captionFailure({ player: "tracks", timedtext: "ok", panel: "skipped", video: "unknown" }), null);
  assert.deepEqual(captionFailure({ player: "age", timedtext: "skipped", panel: "empty", video: "exists" }), { error: "age_restricted", status: 403 });
  assert.deepEqual(captionFailure({ player: "unavailable", timedtext: "skipped", panel: "empty", video: "missing" }), { error: "unavailable", status: 404 });
});

test("json3 and panel parsers keep timed text", () => {
  const json3 = segmentsFromJson3({ events: [{ tStartMs: 2000, dDurationMs: 1500, segs: [{ utf8: "Hello " }, { utf8: "there" }] }, { tStartMs: 9000 }] });
  assert.deepEqual(json3, [[2000, 1500, "Hello there"]]);
  const panel = segmentsFromPanel(panelBody([
    { timestamp: "0:12", simpleText: "second line" },
    { timestamp: "0:02", simpleText: "hello there" },
    { timestamp: "0:02", simpleText: "hello there" },
  ]));
  assert.deepEqual(panel, [
    { ms: 2000, text: "hello there" },
    { ms: 12000, text: "second line" },
  ]);
});

test("a bot-checked player falls through to the public transcript panel", async () => {
  const store = bucket();
  let panelParams = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/player")) {
      return new Response(JSON.stringify(playerBody("LOGIN_REQUIRED", "Sign in to confirm you’re not a bot")), { status: 200 });
    }
    if (url.includes("/get_panel")) {
      panelParams = JSON.parse(String(init?.body)).params;
      return new Response(JSON.stringify(panelBody([
        { timestamp: "0:02", simpleText: "hello so in just a few minutes we will be here" },
        { timestamp: "0:12", simpleText: "and you know that this is the talk about the work" },
      ])), { status: 200 });
    }
    if (url.includes("oembed")) return new Response(JSON.stringify({ title: "A talk", author_name: "TED" }), { status: 200 });
    return new Response("nope", { status: 500 });
  };
  const res = await handleCaptions(new URL(`https://worker.test/captions?v=${video}`), { BUCKET: store }, headers, fetchImpl);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(panelParams, transcriptParams(video));
  assert.equal(body.title, "A talk");
  assert.equal(body.author, "TED");
  assert.equal(body.lang, "en");
  assert.equal(body.via, "panel");
  assert.equal(body.kind, "asr");
  assert.deepEqual(body.segs[0], [2000, 10000, "hello so in just a few minutes we will be here"]);
  assert.equal(res.headers.get("X-TTS-Cache"), "miss");
  assert.equal(store.store.has(`yt/${video}.json`), true);

  const again = await handleCaptions(new URL(`https://worker.test/captions?v=${video}`), { BUCKET: store }, headers, async () => {
    throw new Error("cache hit must not fetch");
  });
  assert.equal(again.status, 200);
  assert.equal(again.headers.get("X-TTS-Cache"), "hit");
  assert.equal((await again.json()).title, "A talk");
});

test("empty panel on a real video is no captions; another language is no English; a failed panel stays blocked", async () => {
  const cases: { name: string; panel: Response | null; oembed?: Response; error: string; status: number }[] = [
    { name: "empty", panel: new Response(JSON.stringify(panelBody([])), { status: 200 }), oembed: new Response(JSON.stringify({ title: "Big Buck Bunny", author_name: "Blender" }), { status: 200 }), error: "no_captions", status: 404 },
    { name: "korean", panel: new Response(JSON.stringify(panelBody([{ timestamp: "0:09", simpleText: "오반 강남 스타일 강남 스타일 오빤 강남스타일" }])), { status: 200 }), error: "no_english", status: 404 },
    { name: "down", panel: new Response("nope", { status: 500 }), error: "captions_blocked", status: 503 },
  ];
  for (const item of cases) {
    const store = bucket();
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/player")) return new Response(JSON.stringify(playerBody("LOGIN_REQUIRED", "Sign in to confirm you’re not a bot")), { status: 200 });
      if (url.includes("/get_panel")) return item.panel ?? new Response("", { status: 503 });
      if (url.includes("oembed")) return item.oembed ?? new Response("missing", { status: 404 });
      return new Response("nope", { status: 500 });
    };
    const res = await handleCaptions(new URL(`https://worker.test/captions?v=${video}`), { BUCKET: store }, headers, fetchImpl);
    const body = await res.json();
    assert.equal(body.error, item.error, item.name);
    assert.equal(res.status, item.status, item.name);
    assert.equal(store.store.size, 0, item.name);
    assert.equal(JSON.stringify(body).includes("没有字幕"), false);
  }
});

test("a playable player with English tracks uses timedtext and does not call the panel", async () => {
  let panel = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/player")) {
      return new Response(JSON.stringify(playerBody("OK", "", [{ languageCode: "en", baseUrl: "https://www.youtube.com/api/timedtext?v=x&fmt=srv3" }, { languageCode: "es", kind: "asr" }], "Talk")), { status: 200 });
    }
    if (url.includes("timedtext")) {
      assert.equal(new URL(url).searchParams.get("fmt"), "json3");
      return new Response(JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Hello there." }] }] }), { status: 200 });
    }
    if (url.includes("/get_panel")) panel += 1;
    return new Response("nope", { status: 500 });
  };
  const res = await handleCaptions(new URL(`https://worker.test/captions?v=${video}`), { BUCKET: bucket() }, headers, fetchImpl);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.kind, "manual");
  assert.equal(body.via, "ANDROID");
  assert.equal(body.title, "Talk");
  assert.deepEqual(body.segs, [[0, 1000, "Hello there."]]);
  assert.equal(panel, 0);
});

test("tracks in another language stay no_english even if a panel would return them", async () => {
  let panel = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/player")) return new Response(JSON.stringify(playerBody("OK", "", [{ languageCode: "ko" }])), { status: 200 });
    if (url.includes("/get_panel")) panel += 1;
    return new Response("nope", { status: 500 });
  };
  const res = await handleCaptions(new URL("https://worker.test/captions?v=9bZkp7q19f0"), { BUCKET: bucket() }, headers, fetchImpl);
  const body = await res.json();
  assert.equal(body.error, "no_english");
  assert.equal(res.status, 404);
  assert.equal(panel, 0);
});

test("a playable video with zero tracks and an empty panel has no captions", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/player")) return new Response(JSON.stringify(playerBody("OK", "")), { status: 200 });
    if (url.includes("/get_panel")) return new Response(JSON.stringify(panelBody([])), { status: 200 });
    return new Response("nope", { status: 500 });
  };
  const res = await handleCaptions(new URL("https://worker.test/captions?v=aqz-KE-bpKQ"), { BUCKET: bucket() }, headers, fetchImpl);
  const body = await res.json();
  assert.equal(body.error, "no_captions");
  assert.equal(res.status, 404);
});

test("bad video id is rejected before any fetch", async () => {
  let calls = 0;
  const res = await handleCaptions(new URL("https://worker.test/captions?v=short"), { BUCKET: bucket() }, headers, async () => {
    calls += 1;
    return new Response("nope");
  });
  assert.equal(res.status, 400);
  assert.equal(calls, 0);
});
