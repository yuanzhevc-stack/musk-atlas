import assert from "node:assert/strict";
import test from "node:test";
import { adoptReady, cacheStatusLine, downloadPercent, enqueueFullCache, fullMediaUrl, openingSource, publicError, readFullCache, rememberedReady, retryFullCache, type CacheView } from "./fullCache";

const mem = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size;
    },
  },
  configurable: true,
});

const id = "d5RKW3WSEb0";

test("opening a lesson uses a verified full file and never a sentence clip", () => {
  mem.clear();
  localStorage.setItem("musk-atlas:reader:v1", "{\"items\":{\"oldword\":{\"meaning\":\"旧词保留\"}}}");
  assert.equal(openingSource(id), "online");
  assert.equal(openingSource("cdZZpaB2kDM"), "online");
  localStorage.setItem(
    "musk-atlas:full-ready:v1",
    JSON.stringify({ version: 1, byVideo: { [id]: { url: fullMediaUrl(id), bytes: 8_000_000, duration: 600 }, cdZZpaB2kDM: { url: "https://pub-ad0e50befa7b4387a7d73a8c8a796eb3.r2.dev/clips/cdZZpaB2kDM/140239.mp4", bytes: 8_000_000, duration: 600 } } }),
  );
  assert.equal(openingSource(id), "local");
  assert.equal(rememberedReady("cdZZpaB2kDM"), null);
  assert.equal(openingSource("cdZZpaB2kDM"), "online");
  assert.equal(JSON.parse(localStorage.getItem("musk-atlas:reader:v1")!).items.oldword.meaning, "旧词保留");
});

test("a replaced video stays local and forgets the previous file address", () => {
  mem.clear();
  const v = "kmyvBlKYfic";
  const previous = fullMediaUrl(v).split("?")[0];
  localStorage.setItem(
    "musk-atlas:full-ready:v1",
    JSON.stringify({ version: 1, byVideo: { [v]: { url: previous, bytes: 51_785_307, duration: 642 } } }),
  );
  const rec = rememberedReady(v);
  assert.notEqual(fullMediaUrl(v), previous);
  assert.equal(rec?.url, fullMediaUrl(v));
  assert.equal(openingSource(v), "local");
});

test("a verified cache uses the stored file on this visit", () => {
  assert.equal(adoptReady("online", "playing", true), "local");
  assert.equal(adoptReady("online", "paused", true), "local");
  assert.equal(adoptReady("online", "loading", true), "local");
  assert.equal(adoptReady("local", "loading", false), "online");
  assert.equal(adoptReady("local", "loading", false, true), "local");
  assert.equal(adoptReady("local", "playing", false), "stay");
});

test("enqueue sends only the video id and keeps a refusal", async () => {
  mem.clear();
  let body = "";
  const view = await enqueueFullCache(id, async (url, init) => {
    body = String(init?.body ?? "");
    assert.equal(String(url).endsWith("/full/jobs"), true);
    return new Response(JSON.stringify({ v: id, status: "refused", runner: "configured", error: "Sign in to confirm you’re not a bot" }), { status: 200 });
  });
  assert.deepEqual(JSON.parse(body), { v: id, origin: "manual" });
  assert.equal(view.verified, false);
  assert.equal(view.status, "refused");
  assert.match(cacheStatusLine(view, false), /拒绝了下载/);
  const measured = cacheStatusLine({ ...view, status: "ready", verified: true, bytes: 8_000_000, duration: 600, height: 1080, fps: 30, vcodec: "h264", acodec: "aac" }, false);
  assert.match(measured, /1080p/);
  assert.equal(measured.includes("没有 720p"), false);
  assert.equal(measured.includes("实际 720p"), false);
  assert.equal(/选择文件|上传/.test(cacheStatusLine(view, false)), false);
  assert.match(cacheStatusLine({ ...view, status: "failed", error: "ejs-missing" }, false), /yt-dlp-ejs/);
  assert.equal(cacheStatusLine({ ...view, status: "running" }, false), "下载停着，没有进度。先用在线。");
  assert.equal(cacheStatusLine({ ...view, status: "running", progress: { phase: "download", received: 42, total: 100 } }, false), "正在下载 42%。先用在线。");
  assert.equal(downloadPercent({ phase: "upload", received: 8, total: 10 }), 80);
  assert.equal(publicError("boom bearer SECRETVALUE token=abc"), "boom");
  assert.equal(cacheStatusLine({ ...view, status: "failed", error: "bearer SECRETVALUE http-403" }, false).includes("SECRETVALUE"), false);
  let retryBody = "";
  await retryFullCache(id, async (_url, init) => {
    retryBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ v: id, status: "queued", runner: "configured", attempts: 0, manualRetries: 1 }), { status: 200 });
  });
  assert.deepEqual(JSON.parse(retryBody), { v: id, origin: "manual", retry: true });
});

test("a public ready record is accepted only when it is a full file", async () => {
  mem.clear();
  const clip = await readFullCache("cdZZpaB2kDM", async () => {
    throw new Error("worker down");
  });
  assert.equal(clip.runner, "unreachable");
  const ready: CacheView = await readFullCache(id, async (url) => {
    if (String(url).includes("/full/jobs")) return new Response("no", { status: 503 });
    return new Response(JSON.stringify({ v: id, verified: true, bytes: 8_000_000, duration: 600, url: fullMediaUrl(id) }));
  });
  assert.equal(ready.verified, true);
  assert.equal(ready.url, fullMediaUrl(id));
  assert.equal(openingSource(id), "local");
  mem.clear();
  const running = await readFullCache(id, async (url, init) => {
    const href = String(url);
    if (href.includes("/full/jobs")) return new Response(JSON.stringify({ v: id, status: "running", runner: "configured" }), { status: 200 });
    if (href.endsWith(".json")) return new Response("no", { status: 404 });
    assert.equal(init?.method, "HEAD");
    return new Response(null, { status: 200, headers: { "content-length": "8000000" } });
  });
  assert.equal(running.verified, true);
  assert.equal(running.status, "ready");
  assert.equal(openingSource(id), "local");
  assert.match(cacheStatusLine(running, true), /已缓存的整段/);
});
