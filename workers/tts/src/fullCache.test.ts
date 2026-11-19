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
  const first = await enqueue(b, id, 1_000, "missing");
  assert.equal(first.status, 200);
  assert.equal(first.job.status, "queued");
  const again = await enqueue(b, id, 2_000, "missing");
  assert.equal(again.job.created, first.job.created);
  const day = new Date(1_000).toISOString().slice(0, 10);
  const budget = JSON.parse(b.store.get(`full/_budget/${day}.json`)!);
  assert.equal(budget.new, 1);
  await report(b, id, "refused", 3_000, { error: "Sign in to confirm you’re not a bot" });
  const kept = await enqueue(b, id, 4_000, "configured");
  assert.equal(kept.job.status, "refused");
  assert.equal(JSON.parse(b.store.get(`full/_budget/${day}.json`)!).new, 1);
});

test("a fresh id past the daily cap is rejected and does not become ready", async () => {
  const b = bucket();
  const day = new Date(10_000).toISOString().slice(0, 10);
  b.store.set(`full/_budget/${day}.json`, JSON.stringify({ new: DAILY_NEW }));
  const res = await enqueue(b, "cdZZpaB2kDM", 10_000, "configured");
  assert.equal(res.status, 429);
  assert.equal(res.job.error, "daily-cap");
  assert.equal(b.store.has("full/jobs/cdZZpaB2kDM.json"), false);
});

test("claim is secret-only and stops after two attempts", async () => {
  const b = bucket();
  await enqueue(b, id, 1_000, "configured");
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
  await enqueue(b, "cdZZpaB2kDM", 1_000, "configured");
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
