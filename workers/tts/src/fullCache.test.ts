import assert from "node:assert/strict";
import test from "node:test";
import {
  DAILY_NEW,
  MAX_ATTEMPTS,
  MIN_FULL_BYTES,
  acceptReady,
  bearerOk,
  claim,
  enqueue,
  retryManual,
  fullMediaUrl,
  handleFullCache,
  report,
  youtubeOnly,
  type JobBucket,
} from "./fullCache";

function bucket(): JobBucket & { store: Map<string, string>; sizes: Map<string, number> } {
  const store = new Map<string, string>();
  const sizes = new Map<string, number>();
  return {
    store,
    sizes,
    async get(key) {
      const value = store.get(key);
      if (value === undefined) return null;
      return { text: async () => value, size: value.length };
    },
    async head(key) {
      const size = sizes.get(key);
      return size == null ? null : { size };
    },
    async put(key, value) {
      store.set(key, value);
    },
    async list(prefix) {
      return [...store.keys()].filter((k) => k.startsWith(prefix));
    },
    async createMultipart(key) {
      const uploadId = `up-${key}`;
      sizes.set(`upload:${uploadId}`, 0);
      return { uploadId };
    },
    async uploadPart(_key, uploadId, partNumber, body) {
      const prev = sizes.get(`upload:${uploadId}`) ?? 0;
      sizes.set(`upload:${uploadId}`, prev + body.byteLength);
      sizes.set(`part:${uploadId}:${partNumber}`, body.byteLength);
      return { partNumber, etag: `etag-${partNumber}` };
    },
    async completeMultipart(key, uploadId, parts) {
      let total = 0;
      for (const part of parts) total += sizes.get(`part:${uploadId}:${part.partNumber}`) ?? 0;
      sizes.set(key, total);
    },
    async abortMultipart() {},
  };
}

const headers = { "Access-Control-Allow-Origin": "https://yuanzhevc-stack.github.io" };
const secret = "test-secret";
const id = "d5RKW3WSEb0";

test("only an 11-character youtube id is accepted", () => {
  assert.equal(youtubeOnly(id), id);
  assert.equal(youtubeOnly("https://www.youtube.com/watch?v=" + id), null);
  assert.equal(youtubeOnly("http://169.254.169.254/latest"), null);
  assert.equal(youtubeOnly("../full/x"), null);
  assert.equal(youtubeOnly("short"), null);
  assert.equal(youtubeOnly(id + "extra"), null);
});

test("enqueue dedups, caps the day, and does not retry a refusal", async () => {
  const b = bucket();
  const first = await enqueue(b, id, 1_000, "missing", "manual");
  assert.equal(first.status, 200);
  assert.equal(first.job.status, "queued");
  const again = await enqueue(b, id, 2_000, "missing", "manual");
  assert.equal(again.job.created, first.job.created);
  const day = new Date(1_000).toISOString().slice(0, 10);
  const budget = JSON.parse(b.store.get(`full/_budget/${day}.json`)!);
  assert.equal(budget.new, 1);
  await report(b, id, "refused", 3_000, { error: "Sign in to confirm you’re not a bot" });
  const kept = await enqueue(b, id, 4_000, "configured", "manual");
  assert.equal(kept.job.status, "refused");
  assert.equal(JSON.parse(b.store.get(`full/_budget/${day}.json`)!).new, 1);
});

test("a fresh id past the daily cap is rejected and does not become ready", async () => {
  const b = bucket();
  const day = new Date(10_000).toISOString().slice(0, 10);
  b.store.set(`full/_budget/${day}.json`, JSON.stringify({ new: DAILY_NEW }));
  const res = await enqueue(b, "cdZZpaB2kDM", 10_000, "configured", "manual");
  assert.equal(res.status, 429);
  assert.equal(res.job.error, "daily-cap");
  assert.equal(b.store.has("full/jobs/cdZZpaB2kDM.json"), false);
});

test("claim is secret-only and stops after two attempts", async () => {
  const b = bucket();
  await enqueue(b, id, 1_000, "configured", "manual");
  assert.equal(bearerOk("Bearer no", secret), false);
  assert.equal(bearerOk("Bearer " + secret, ""), false);
  const open = await handleFullCache(new Request("https://worker.test/full/claim", { method: "POST" }), b, headers, { secret, now: 2_000 });
  assert.equal(open.status, 401);
  const claimed = await claim(b, 2_000);
  assert.equal(claimed?.status, "running");
  assert.equal(claimed?.attempts, 1);
  await report(b, id, "failed", 3_000, { error: "network" });
  const second = await claim(b, 4_000);
  assert.equal(second?.attempts, 2);
  await report(b, id, "failed", 5_000, { error: "network" });
  assert.equal((await claim(b, 6_000)), null);
  const job = JSON.parse(b.store.get(`full/jobs/${id}.json`)!);
  assert.equal(job.status, "failed");
  assert.equal(job.attempts, MAX_ATTEMPTS);
});

test("ready requires the real object, not a sentence clip", async () => {
  const b = bucket();
  await enqueue(b, "cdZZpaB2kDM", 1_000, "configured", "manual");
  await claim(b, 2_000);
  assert.equal(acceptReady(135960, 135960, 6.28), "too-small");
  assert.equal(acceptReady(6_900_000, 6_900_000, 6), "too-short");
  const lie = await report(b, "cdZZpaB2kDM", "ready", 3_000, { bytes: 6_900_000, duration: 114 });
  assert.equal(lie.status, 409);
  assert.equal(lie.job.status === "ready", false);
  b.sizes.set("full/cdZZpaB2kDM.mp4", MIN_FULL_BYTES);
  const bad = await report(b, "cdZZpaB2kDM", "ready", 4_000, { bytes: MIN_FULL_BYTES, duration: 10 });
  assert.equal(bad.job.error, "too-short");
  const ok = await report(b, "cdZZpaB2kDM", "ready", 5_000, { bytes: MIN_FULL_BYTES, duration: 114 });
  assert.equal(ok.status, 200);
  assert.equal(ok.job.status, "ready");
  const rec = JSON.parse(b.store.get("full/ready/cdZZpaB2kDM.json")!);
  assert.equal(rec.verified, true);
  assert.equal(rec.url, fullMediaUrl("cdZZpaB2kDM"));
  assert.equal(rec.url.includes("/clips/"), false);
  const pub = await handleFullCache(new Request("https://worker.test/full/jobs?v=cdZZpaB2kDM"), b, headers, { secret, now: 6_000 });
  const body = await pub.json();
  assert.equal(body.status, "ready");
  assert.equal(body.url.includes("/clips/"), false);
});

test("a secret-backed upload can finish a full object and stays closed without the secret", async () => {
  const b = bucket();
  const closed = await handleFullCache(new Request("https://worker.test/full/upload/start", { method: "POST", body: JSON.stringify({ v: id }) }), b, headers, { secret: "", now: 1_000 });
  assert.equal(closed.status, 503);
  const opened = await handleFullCache(
    new Request("https://worker.test/full/upload/start", { method: "POST", headers: { Authorization: `Bearer ${secret}` }, body: JSON.stringify({ v: id }) }),
    b,
    headers,
    { secret, now: 1_000 },
  );
  assert.equal(opened.status, 200);
  const { uploadId } = await opened.json();
  const chunk = new Uint8Array(MIN_FULL_BYTES);
  const part = await handleFullCache(
    new Request(`https://worker.test/full/upload/part?v=${id}&uploadId=${uploadId}&part=1&last=1`, { method: "PUT", headers: { Authorization: `Bearer ${secret}` }, body: chunk }),
    b,
    headers,
    { secret, now: 2_000 },
  );
  assert.equal(part.status, 200);
  const done = await handleFullCache(
    new Request("https://worker.test/full/upload/complete", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ v: id, uploadId, parts: [{ partNumber: 1, etag: "etag-1" }], bytes: MIN_FULL_BYTES, duration: 114 }),
    }),
    b,
    headers,
    { secret, now: 3_000 },
  );
  assert.equal(done.status, 200);
  assert.equal((await done.json()).status, "ready");
  assert.equal(b.store.has(`full/ready/${id}.json`), true);
});

test("claim leaves an older unmarked job and takes the pasted link", async () => {
  const b = bucket();
  b.store.set(
    "full/jobs/bbbbbbbbbbb.json",
    JSON.stringify({ v: "bbbbbbbbbbb", status: "queued", attempts: 0, maxAttempts: 2, created: 1, updated: 1, runner: "configured" }),
  );
  await enqueue(b, id, 5_000, "configured", "manual");
  const claimed = await claim(b, 6_000);
  assert.equal(claimed?.v, id);
  assert.equal(claimed?.origin, "manual");
  const legacy = JSON.parse(b.store.get("full/jobs/bbbbbbbbbbb.json")!);
  assert.equal(legacy.status, "queued");
});

test("a post without the manual mark does not create a job", async () => {
  const b = bucket();
  const res = await handleFullCache(
    new Request("https://worker.test/full/jobs", { method: "POST", body: JSON.stringify({ v: id }) }),
    b,
    headers,
    { secret: "", now: 1_000 },
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "unknown");
  assert.equal(b.store.has(`full/jobs/${id}.json`), false);
  const manual = await handleFullCache(
    new Request("https://worker.test/full/jobs", { method: "POST", body: JSON.stringify({ v: id, origin: "manual" }) }),
    b,
    headers,
    { secret: "", now: 2_000 },
  );
  assert.equal((await manual.json()).origin, "manual");
});

test("a ready report keeps the measured picture and does not invent 720p", async () => {
  const b = bucket();
  await enqueue(b, id, 1_000, "configured", "manual");
  await claim(b, 2_000);
  b.sizes.set(`full/${id}.mp4`, MIN_FULL_BYTES);
  const ok = await report(b, id, "ready", 3_000, { bytes: MIN_FULL_BYTES, duration: 114, height: 1080, fps: 30, vcodec: "h264", acodec: "aac" });
  assert.equal(ok.job.height, 1080);
  assert.equal(ok.job.fps, 30);
  assert.equal(ok.job.vcodec, "h264");
  const rec = JSON.parse(b.store.get(`full/ready/${id}.json`)!);
  assert.equal(rec.height, 1080);
  assert.equal(rec.height === 720, false);
});

test("a normal post leaves a terminal manual failure alone and an explicit retry requeues it once", async () => {
  const b = bucket();
  const id = "ZXsQAXx_ao0";
  await enqueue(b, id, 1_000, "configured", "manual");
  await claim(b, 2_000);
  await report(b, id, "failed", 3_000, { error: "HTTP Error 403" });
  await claim(b, 4_000);
  await report(b, id, "failed", 5_000, { error: "ejs-missing" });
  const stuck = JSON.parse(b.store.get(`full/jobs/${id}.json`)!);
  assert.equal(stuck.status, "failed");
  assert.equal(stuck.attempts, 2);
  const polled = await handleFullCache(
    new Request("https://worker.test/full/jobs", { method: "POST", body: JSON.stringify({ v: id, origin: "manual" }) }),
    b,
    headers,
    { secret: "", now: 6_000 },
  );
  const polledJob = await polled.json();
  assert.equal(polled.status, 200);
  assert.equal(polledJob.status, "failed");
  assert.equal(polledJob.attempts, 2);
  const again = await enqueue(b, id, 7_000, "configured", "manual");
  assert.equal(again.job.status, "failed");
  assert.equal(again.job.attempts, 2);
  const retried = await handleFullCache(
    new Request("https://worker.test/full/jobs", { method: "POST", body: JSON.stringify({ v: id, origin: "manual", retry: true }) }),
    b,
    headers,
    { secret: "", now: 8_000 },
  );
  const queued = await retried.json();
  assert.equal(retried.status, 200);
  assert.equal(queued.status, "queued");
  assert.equal(queued.attempts, 0);
  assert.equal(queued.manualRetries, 1);
  assert.equal(queued.history[0].error, "ejs-missing");
  assert.equal(queued.history[0].attempts, 2);
  const legacy = "bbbbbbbbbbb";
  b.store.set(`full/jobs/${legacy}.json`, JSON.stringify({ v: legacy, status: "failed", attempts: 2, maxAttempts: 2, created: 1, updated: 1, runner: "configured", error: "old" }));
  const legacyRetry = await retryManual(b, legacy, 9_000, "configured");
  assert.equal(legacyRetry.job.status, "failed");
  assert.equal(legacyRetry.job.origin, undefined);
  b.store.set(`full/jobs/${id}.json`, JSON.stringify({ ...queued, status: "refused", error: "youtube-refused" }));
  const refused = await retryManual(b, id, 10_000, "configured");
  assert.equal(refused.job.status, "refused");
  assert.equal(refused.job.attempts, 0);
});

test("capability announces manual-only and a 720 cap", async () => {
  const b = bucket();
  const res = await handleFullCache(new Request("https://worker.test/full/capability"), b, headers, { secret: "", now: 1_000 });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { scope: "manual-only", maxHeight: 720, preferFps: 30, policy: "lte-720" });
});

test("the public enqueue route rejects an arbitrary url", async () => {
  const b = bucket();
  const res = await handleFullCache(
    new Request("https://worker.test/full/jobs", { method: "POST", body: JSON.stringify({ v: id, url: "http://127.0.0.1/secret" }) }),
    b,
    headers,
    { secret: "", now: 1_000 },
  );
  assert.equal(res.status, 400);
  assert.equal(b.store.size, 0);
});
