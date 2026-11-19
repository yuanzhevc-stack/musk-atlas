/** Full-lesson cache jobs. The Worker records and checks jobs. It does not download YouTube.
 *  A machine the parent runs (scripts/musk/cache_full.py) claims a job, downloads with yt-dlp
 *  using no cookies and no proxy, uploads straight to R2, then reports size and duration.
 *  This Worker marks the lesson ready only after the R2 object is actually there and large
 *  enough to not be a sentence clip. */

export const YT_ID = /^[A-Za-z0-9_-]{11}$/;
export const MAX_ATTEMPTS = 2;
export const DAILY_NEW = 6;
export const MIN_FULL_BYTES = 2_000_000;
export const MIN_FULL_SECONDS = 20;
export const STALE_MS = 20 * 60 * 1000;
export const PUBLIC_BASE = "https://pub-ad0e50befa7b4387a7d73a8c8a796eb3.r2.dev";

export type JobStatus = "queued" | "running" | "ready" | "refused" | "failed";
export interface FullJob {
  v: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  created: number;
  updated: number;
  error?: string;
  bytes?: number;
  duration?: number;
  runner: "configured" | "missing";
}

export interface ReadyRecord {
  v: string;
  verified: true;
  bytes: number;
  duration: number;
  url: string;
}

export interface JobObject {
  text(): Promise<string>;
  size?: number;
}
export interface JobBucket {
  get(key: string): Promise<JobObject | null>;
  head(key: string): Promise<{ size: number } | null>;
  put(key: string, value: string, opts?: { httpMetadata?: { contentType?: string; cacheControl?: string } }): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export const jobKey = (v: string) => `full/jobs/${v}.json`;
export const readyKey = (v: string) => `full/ready/${v}.json`;
export const mediaKey = (v: string) => `full/${v}.mp4`;
export const fullMediaUrl = (v: string) => `${PUBLIC_BASE}/full/${v}.mp4`;
const budgetKey = (day: string) => `full/_budget/${day}.json`;

export function youtubeOnly(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const v = input.trim();
  if (!YT_ID.test(v)) return null;
  if (v.includes("/") || v.includes(".")) return null;
  return v;
}

export function bearerOk(header: string | null, secret: string): boolean {
  if (!secret || !header?.startsWith("Bearer ")) return false;
  const got = header.slice("Bearer ".length);
  if (got.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

function fresh(v: string, now: number, runner: FullJob["runner"]): FullJob {
  return { v, status: "queued", attempts: 0, maxAttempts: MAX_ATTEMPTS, created: now, updated: now, runner };
}

async function readJob(bucket: JobBucket, v: string): Promise<FullJob | null> {
  const obj = await bucket.get(jobKey(v));
  if (!obj) return null;
  try {
    const job = JSON.parse(await obj.text()) as FullJob;
    if (job?.v !== v || !job.status) return null;
    return job;
  } catch {
    return null;
  }
}

async function writeJob(bucket: JobBucket, job: FullJob) {
  await bucket.put(jobKey(job.v), JSON.stringify(job), {
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
  });
}

async function budget(bucket: JobBucket, now: number): Promise<{ key: string; used: number }> {
  const key = budgetKey(new Date(now).toISOString().slice(0, 10));
  const obj = await bucket.get(key);
  let used = 0;
  if (obj) {
    try {
      used = Number((JSON.parse(await obj.text()) as { new?: number }).new ?? 0);
    } catch {
      used = 0;
    }
  }
  return { key, used };
}

export async function enqueue(bucket: JobBucket, v: string, now: number, runner: FullJob["runner"]): Promise<{ status: number; job: FullJob }> {
  const ready = await bucket.get(readyKey(v));
  if (ready) {
    const job = (await readJob(bucket, v)) ?? fresh(v, now, runner);
    return { status: 200, job: { ...job, status: "ready", runner, updated: now } };
  }
  const existing = await readJob(bucket, v);
  if (existing && (existing.status === "queued" || existing.status === "running" || existing.status === "ready" || existing.status === "refused")) {
    return { status: 200, job: { ...existing, runner } };
  }
  if (existing && existing.status === "failed" && existing.attempts >= MAX_ATTEMPTS) {
    return { status: 200, job: { ...existing, runner } };
  }
  const cap = await budget(bucket, now);
  if (!existing && cap.used >= DAILY_NEW) {
    const job = fresh(v, now, runner);
    job.status = "failed";
    job.error = "daily-cap";
    return { status: 429, job };
  }
  const job = existing ?? fresh(v, now, runner);
  job.status = "queued";
  job.updated = now;
  job.runner = runner;
  job.error = undefined;
  await writeJob(bucket, job);
  if (!existing) await bucket.put(cap.key, JSON.stringify({ new: cap.used + 1 }), { httpMetadata: { contentType: "application/json" } });
  return { status: 200, job };
}

export async function claim(bucket: JobBucket, now: number): Promise<FullJob | null> {
  const keys = await bucket.list("full/jobs/");
  const jobs: FullJob[] = [];
  for (const key of keys) {
    if (!key.endsWith(".json") || key.includes("/_")) continue;
    const v = key.slice("full/jobs/".length, -".json".length);
    if (!youtubeOnly(v)) continue;
    const job = await readJob(bucket, v);
    if (job) jobs.push(job);
  }
  jobs.sort((a, b) => a.created - b.created);
  const queued = jobs.find((j) => j.status === "queued" && j.attempts < MAX_ATTEMPTS);
  const stale = jobs.find((j) => j.status === "running" && now - j.updated > STALE_MS && j.attempts < MAX_ATTEMPTS);
  const job = queued ?? stale;
  if (!job) return null;
  if (job.status === "queued") job.attempts += 1;
  job.status = "running";
  job.updated = now;
  job.runner = "configured";
  await writeJob(bucket, job);
  return job;
}

export function acceptReady(headBytes: number | null, reportedBytes: number, duration: number): string | null {
  if (headBytes == null) return "missing-object";
  if (!Number.isFinite(reportedBytes) || reportedBytes !== headBytes) return "size-mismatch";
  if (headBytes < MIN_FULL_BYTES) return "too-small";
  if (!Number.isFinite(duration) || duration < MIN_FULL_SECONDS) return "too-short";
  return null;
}

export async function report(
  bucket: JobBucket,
  v: string,
  outcome: "ready" | "refused" | "failed",
  now: number,
  detail: { bytes?: number; duration?: number; error?: string },
): Promise<{ status: number; job: FullJob }> {
  const job = (await readJob(bucket, v)) ?? fresh(v, now, "configured");
  job.updated = now;
  job.runner = "configured";
  if (outcome === "ready") {
    const head = await bucket.head(mediaKey(v));
    const reason = acceptReady(head?.size ?? null, detail.bytes ?? NaN, detail.duration ?? NaN);
    if (reason) {
      job.status = job.attempts >= MAX_ATTEMPTS ? "failed" : "queued";
      job.error = reason;
      await writeJob(bucket, job);
      return { status: 409, job };
    }
    const rec: ReadyRecord = { v, verified: true, bytes: detail.bytes!, duration: detail.duration!, url: fullMediaUrl(v) };
    if (rec.url.includes("/clips/")) {
      job.status = "failed";
      job.error = "clip-url";
      await writeJob(bucket, job);
      return { status: 409, job };
    }
    await bucket.put(readyKey(v), JSON.stringify(rec), {
      httpMetadata: { contentType: "application/json", cacheControl: "public, max-age=60" },
    });
    job.status = "ready";
    job.bytes = rec.bytes;
    job.duration = rec.duration;
    job.error = undefined;
    await writeJob(bucket, job);
    return { status: 200, job };
  }
  job.error = (detail.error ?? outcome).slice(0, 180);
  if (outcome === "refused") job.status = "refused";
  else job.status = job.attempts >= MAX_ATTEMPTS ? "failed" : "queued";
  await writeJob(bucket, job);
  return { status: 200, job };
}

function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export async function handleFullCache(req: Request, bucket: JobBucket, headers: Record<string, string>, opts: { secret: string; now: number }): Promise<Response> {
  const url = new URL(req.url);
  const authed = bearerOk(req.headers.get("Authorization"), opts.secret);
  const runner: FullJob["runner"] = opts.secret ? "configured" : "missing";

  if (url.pathname === "/full/claim") {
    if (!opts.secret) return json({ error: "runner-not-configured" }, 503, headers);
    if (!authed) return json({ error: "unauthorized" }, 401, headers);
    if (req.method !== "POST") return json({ error: "method" }, 405, headers);
    const job = await claim(bucket, opts.now);
    return json({ job }, 200, headers);
  }
  if (url.pathname === "/full/result") {
    if (!opts.secret) return json({ error: "runner-not-configured" }, 503, headers);
    if (!authed) return json({ error: "unauthorized" }, 401, headers);
    if (req.method !== "POST") return json({ error: "method" }, 405, headers);
    let body: { v?: unknown; outcome?: unknown; bytes?: unknown; duration?: unknown; error?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "bad-json" }, 400, headers);
    }
    const v = youtubeOnly(body.v);
    const outcome = body.outcome === "ready" || body.outcome === "refused" || body.outcome === "failed" ? body.outcome : null;
    if (!v || !outcome) return json({ error: "bad-video" }, 400, headers);
    const result = await report(bucket, v, outcome, opts.now, {
      bytes: typeof body.bytes === "number" ? body.bytes : undefined,
      duration: typeof body.duration === "number" ? body.duration : undefined,
      error: typeof body.error === "string" ? body.error : undefined,
    });
    return json(result.job, result.status, headers);
  }
  if (url.pathname === "/full/jobs" && req.method === "GET") {
    const v = youtubeOnly(url.searchParams.get("v"));
    if (!v) return json({ error: "bad-video" }, 400, headers);
    const ready = await bucket.get(readyKey(v));
    if (ready) {
      try {
        const rec = JSON.parse(await ready.text()) as ReadyRecord;
        if (rec.verified && rec.v === v && !rec.url.includes("/clips/") && rec.bytes >= MIN_FULL_BYTES && rec.duration >= MIN_FULL_SECONDS) {
          return json({ ...(await readJob(bucket, v)), v, status: "ready", bytes: rec.bytes, duration: rec.duration, url: fullMediaUrl(v), runner }, 200, headers);
        }
      } catch {
        /* ignore a broken record and fall through to the job */
      }
    }
    const job = await readJob(bucket, v);
    return json(job ? { ...job, runner } : { v, status: "unknown", runner }, 200, headers);
  }
  if (url.pathname === "/full/jobs" && req.method === "POST") {
    let body: { v?: unknown; url?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "bad-json" }, 400, headers);
    }
    if ("url" in body) return json({ error: "id-only" }, 400, headers);
    const v = youtubeOnly(body.v);
    if (!v) return json({ error: "bad-video" }, 400, headers);
    const result = await enqueue(bucket, v, opts.now, runner);
    return json(result.job, result.status, headers);
  }
  return json({ error: "not-found" }, 404, headers);
}
