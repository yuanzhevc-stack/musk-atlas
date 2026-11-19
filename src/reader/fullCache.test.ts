import assert from "node:assert/strict";
import test from "node:test";
import { adoptReady, cacheStatusLine, enqueueFullCache, fullMediaUrl, openingSource, readFullCache, rememberedReady, type CacheView } from "./fullCache";

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

test("a youtube visit keeps its player when the cache becomes ready", () => {
  assert.equal(adoptReady("online", "playing", true), "stay");
  assert.equal(adoptReady("online", "paused", true), "stay");
  assert.equal(adoptReady("online", "loading", true), "stay");
  assert.equal(adoptReady("local", "loading", false), "online");
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
  assert.deepEqual(JSON.parse(body), { v: id });
  assert.equal(view.verified, false);
  assert.equal(view.status, "refused");
  assert.match(cacheStatusLine(view, false), /拒绝了下载/);
  assert.equal(/选择文件|上传/.test(cacheStatusLine(view, false)), false);
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
});
