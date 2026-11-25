/** Full-lesson cache jobs. The Worker records and checks jobs. It does not download YouTube.
 *  A machine the parent runs (scripts/musk/cache_full.py) claims a job, downloads with yt-dlp
 *  using no cookies and no proxy, uploads straight to R2, then reports size and duration.
 *  This Worker marks the lesson ready only after the R2 object is actually there and large
 *  enough to not be a sentence clip. */

export const YT_ID = /^[A-Za-z0-9_-]{11}$/;
export const MAX_ATTEMPTS = 2;
export const DAILY_NEW = 24;
/** Explicit retries of a terminal manual failure. Polling does not spend these. */
export const MAX_MANUAL_RETRIES = 2;
export const DAILY_RETRIES = 6;
export const MIN_FULL_BYTES = 2_000_000;
export const MIN_FULL_SECONDS = 20;
export const MIN_PART_BYTES = 5 * 1024 * 1024;
export const MAX_PART_BYTES = 80 * 1024 * 1024;
export const MAX_OBJECT_BYTES = 512 * 1024 * 1024;
export const STALE_MS = 20 * 60 * 1000;
export const PUBLIC_BASE = "https://pub-ad0e50befa7b4387a7d73a8c8a796eb3.r2.dev";
/** Public handshake. The downloader claims only after it sees this exact shape. */
export const CACHE_CAPABILITY = { scope: "manual-only", maxHeight: 720, preferFps: 30, policy: "lte-720" } as const;

export type JobStatus = "queued" | "running" | "ready" | "refused" | "failed";
export type JobOrigin = "manual" | "legacy";
export interface MediaFacts {
  width?: number;
  height?: number;
  fps?: number;
  vcodec?: string;
  acodec?: string;
}
export interface FullJob extends MediaFacts {
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
  /** Pasted-link jobs are the only ones a claim may take. Older queued files stay put. */
  origin?: JobOrigin;
  /** How many times a person explicitly requeued a terminal failure. */
  manualRetries?: number;
  history?: { at: number; status: string; error?: string; attempts: number }[];
  progress?: { phase: "download" | "upload"; received: number; total?: number };
}

export interface ReadyRecord extends MediaFacts {
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
export interface UploadedPart {
  partNumber: number;
  etag: string;
}
export interface JobBucket {
  get(key: string): Promise<JobObject | null>;
  head(key: string): Promise<{ size: number } | null>;
  put(key: string, value: string, opts?: { httpMetadata?: { contentType?: string; cacheControl?: string } }): Promise<void>;
  list(prefix: string): Promise<string[]>;
  createMultipart(key: string): Promise<{ uploadId: string }>;
  uploadPart(key: string, uploadId: string, partNumber: number, body: ArrayBuffer): Promise<UploadedPart>;
  completeMultipart(key: string, uploadId: string, parts: UploadedPart[]): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
}

export const jobKey = (v: string) => `full/jobs/${v}.json`;
export const readyKey = (v: string) => `full/ready/${v}.json`;
export const mediaKey = (v: string) => `full/${v}.mp4`;
export const fullMediaUrl = (v: string) => `${PUBLIC_BASE}/full/${v}.mp4`;
export const uploadKey = (v: string) => `full/uploads/${v}.json`;
const budgetKey = (day: string) => `full/_budget/${day}.json`;
const retryBudgetKey = (day: string) => `full/_retry/${day}.json`;

/** Drop credential-shaped text. The browser may show what remains. */
export function publicError(error: string | undefined): string | undefined {
  if (!error) return undefined;
  const clean = error
    .replace(/bearer\s+\S+/gi, "[redacted]")
    .replace(/(secret|token|authorization|api[_-]?key)\s*[=:]\s*\S+/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return clean || undefined;
}

export function partSizeOk(size: number, isLast: boolean): boolean {
  if (!Number.isFinite(size) || size <= 0 || size > MAX_PART_BYTES) return false;
  if (!isLast && size < MIN_PART_BYTES) return false;
  return true;
}

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

function fresh(v: string, now: number, runner: FullJob["runner"], origin: JobOrigin): FullJob {
  return { v, status: "queued", attempts: 0, maxAttempts: MAX_ATTEMPTS, created: now, updated: now, runner, origin };
}

const CODEC = /^[A-Za-z0-9_.]{2,20}$/;

/** Keep only numbers and codec names the runner measured. Never fill in 720p. */
export function mediaFacts(input: MediaFacts | undefined): MediaFacts {
  if (!input) return {};
  const out: MediaFacts = {};
  if (typeof input.width === "number" && input.width > 0 && input.width < 10000) out.width = Math.round(input.width);
  if (typeof input.height === "number" && input.height > 0 && input.height < 10000) out.height = Math.round(input.height);
  if (typeof input.fps === "number" && input.fps > 0 && input.fps < 240) out.fps = Math.round(input.fps * 1000) / 1000;
  if (typeof input.vcodec === "string" && CODEC.test(input.vcodec)) out.vcodec = input.vcodec;
  if (typeof input.acodec === "string" && CODEC.test(input.acodec)) out.acodec = input.acodec;
  return out;
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

export async function enqueue(bucket: JobBucket, v: string, now: number, runner: FullJob["runner"], origin: JobOrigin = "legacy"): Promise<{ status: number; job: FullJob }> {
  const ready = await bucket.get(readyKey(v));
  if (ready) {
    const job = (await readJob(bucket, v)) ?? fresh(v, now, runner, origin);
    return { status: 200, job: { ...job, status: "ready", runner, updated: now } };
  }
  const existing = await readJob(bucket, v);
  if (existing && origin === "manual" && existing.origin !== "manual" && (existing.status === "queued" || existing.status === "failed")) {
    existing.origin = "manual";
    existing.status = "queued";
    existing.updated = now;
    existing.runner = runner;
    existing.error = undefined;
    if (existing.attempts >= MAX_ATTEMPTS) existing.attempts = 0;
    await writeJob(bucket, existing);
    return { status: 200, job: existing };
  }
  if (existing && existing.status === "running" && now - existing.updated > STALE_MS) {
    existing.status = "queued";
    existing.origin = "manual";
    existing.updated = now;
    existing.runner = runner;
    existing.error = undefined;
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
    const job = fresh(v, now, runner, origin);
    job.status = "failed";
    job.error = "daily-cap";
    return { status: 429, job };
  }
  const job = existing ?? fresh(v, now, runner, origin);
  job.status = "queued";
  job.updated = now;
  job.runner = runner;
  job.origin = existing?.origin ?? origin;
  job.error = undefined;
  await writeJob(bucket, job);
  if (!existing) await bucket.put(cap.key, JSON.stringify({ new: cap.used + 1 }), { httpMetadata: { contentType: "application/json" } });
  return { status: 200, job };
}

/** A person asked to try a terminal manual failure again. Refusals, legacy jobs, and ordinary posts do not come here. */
export async function retryManual(bucket: JobBucket, v: string, now: number, runner: FullJob["runner"]): Promise<{ status: number; job: FullJob }> {
  const ready = await bucket.get(readyKey(v));
  if (ready) {
    const job = (await readJob(bucket, v)) ?? fresh(v, now, runner, "manual");
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
      used = Number((JSON.parse(await obj.text()) as { n?: number }).n ?? 0);
    } catch {
      used = 0;
    }
  }
  if (used >= DAILY_RETRIES) return { status: 429, job: { ...existing, runner, error: "daily-cap" } };
  const prior = { at: existing.updated, status: existing.status, error: publicError(existing.error), attempts: existing.attempts };
  existing.history = [...(existing.history ?? []), prior].slice(-6);
  existing.manualRetries = (existing.manualRetries ?? 0) + 1;
  existing.attempts = 0;
  existing.status = "queued";
  existing.error = undefined;
  existing.updated = now;
  existing.runner = runner;
  await writeJob(bucket, existing);
  await bucket.put(key, JSON.stringify({ n: used + 1 }), { httpMetadata: { contentType: "application/json" } });
  return { status: 200, job: existing };
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
  const manual = (j: FullJob) => j.origin === "manual";
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

export async function noteProgress(
  bucket: JobBucket,
  v: string,
  now: number,
  progress: { phase: "download" | "upload"; received: number; total?: number },
): Promise<FullJob | null> {
  const job = await readJob(bucket, v);
  if (!job || job.status !== "running") return null;
  job.progress = progress;
  job.updated = now;
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
  detail: { bytes?: number; duration?: number; error?: string } & MediaFacts,
): Promise<{ status: number; job: FullJob }> {
  const job = (await readJob(bucket, v)) ?? fresh(v, now, "configured", "manual");
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
    const rec: ReadyRecord = { v, verified: true, bytes: detail.bytes!, duration: detail.duration!, url: fullMediaUrl(v), ...facts };
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
    Object.assign(job, facts);
    job.error = undefined;
    await writeJob(bucket, job);
    return { status: 200, job };
  }
  job.error = publicError(detail.error ?? outcome);
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

  if (url.pathname === "/full/upload/start" || url.pathname === "/full/upload/part" || url.pathname === "/full/upload/complete" || url.pathname === "/full/claim" || url.pathname === "/full/result" || url.pathname === "/full/progress") {
    if (!opts.secret) return json({ error: "runner-not-configured" }, 503, headers);
    if (!authed) return json({ error: "unauthorized" }, 401, headers);
  }
  if (url.pathname === "/full/upload/start") {
    if (req.method !== "POST") return json({ error: "method" }, 405, headers);
    let body: { v?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "bad-json" }, 400, headers);
    }
    const v = youtubeOnly(body.v);
    if (!v) return json({ error: "bad-video" }, 400, headers);
    const existing = await bucket.get(uploadKey(v));
    if (existing) {
      try {
        const prev = JSON.parse(await existing.text()) as { uploadId?: string };
        if (prev.uploadId) await bucket.abortMultipart(mediaKey(v), prev.uploadId);
      } catch {
        /* a stale session should not block a new one */
      }
    }
    const opened = await bucket.createMultipart(mediaKey(v));
    await bucket.put(uploadKey(v), JSON.stringify({ uploadId: opened.uploadId, created: opts.now }), {
      httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
    });
    return json({ v, uploadId: opened.uploadId }, 200, headers);
  }
  if (url.pathname === "/full/upload/part") {
    if (req.method !== "PUT") return json({ error: "method" }, 405, headers);
    const v = youtubeOnly(url.searchParams.get("v"));
    const uploadId = url.searchParams.get("uploadId") ?? "";
    const partNumber = Number(url.searchParams.get("part"));
    const isLast = url.searchParams.get("last") === "1";
    if (!v || !uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 100) return json({ error: "bad-part" }, 400, headers);
    const session = await bucket.get(uploadKey(v));
    const saved = session ? (JSON.parse(await session.text()) as { uploadId?: string }) : {};
    if (saved.uploadId !== uploadId) return json({ error: "unknown-upload" }, 409, headers);
    const body = await req.arrayBuffer();
    if (!partSizeOk(body.byteLength, isLast)) return json({ error: "bad-part-size" }, 413, headers);
    const part = await bucket.uploadPart(mediaKey(v), uploadId, partNumber, body);
    return json(part, 200, headers);
  }
  if (url.pathname === "/full/upload/complete") {
    if (req.method !== "POST") return json({ error: "method" }, 405, headers);
    let body: { v?: unknown; uploadId?: unknown; parts?: unknown; bytes?: unknown; duration?: unknown; width?: unknown; height?: unknown; fps?: unknown; vcodec?: unknown; acodec?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "bad-json" }, 400, headers);
    }
    const v = youtubeOnly(body.v);
    const uploadId = typeof body.uploadId === "string" ? body.uploadId : "";
    const parts = Array.isArray(body.parts) ? body.parts.flatMap((p) => {
      if (!p || typeof p !== "object") return [];
      const row = p as { partNumber?: unknown; etag?: unknown };
      if (typeof row.partNumber !== "number" || typeof row.etag !== "string" || !row.etag) return [];
      return [{ partNumber: row.partNumber, etag: row.etag }];
    }) : [];
    if (!v || !uploadId || !parts.length) return json({ error: "bad-video" }, 400, headers);
    const bytes = typeof body.bytes === "number" ? body.bytes : NaN;
    if (bytes > MAX_OBJECT_BYTES) return json({ error: "too-large" }, 413, headers);
    const session = await bucket.get(uploadKey(v));
    const saved = session ? (JSON.parse(await session.text()) as { uploadId?: string }) : {};
    if (saved.uploadId !== uploadId) return json({ error: "unknown-upload" }, 409, headers);
    await bucket.completeMultipart(mediaKey(v), uploadId, parts);
    const result = await report(bucket, v, "ready", opts.now, {
      bytes,
      duration: typeof body.duration === "number" ? body.duration : undefined,
      width: typeof body.width === "number" ? body.width : undefined,
      height: typeof body.height === "number" ? body.height : undefined,
      fps: typeof body.fps === "number" ? body.fps : undefined,
      vcodec: typeof body.vcodec === "string" ? body.vcodec : undefined,
      acodec: typeof body.acodec === "string" ? body.acodec : undefined,
    });
    return json(result.job, result.status, headers);
  }
  if (url.pathname === "/full/capability" && req.method === "GET") {
    return json(CACHE_CAPABILITY, 200, headers);
  }
  if (url.pathname === "/full/claim") {
    if (req.method !== "POST") return json({ error: "method" }, 405, headers);
    if (req.headers.get("X-Cache-Script") !== "3") return json({ job: null }, 200, headers);
    const job = await claim(bucket, opts.now);
    return json({ job }, 200, headers);
  }
  if (url.pathname === "/full/result") {
    if (!opts.secret) return json({ error: "runner-not-configured" }, 503, headers);
    if (!authed) return json({ error: "unauthorized" }, 401, headers);
    if (req.method !== "POST") return json({ error: "method" }, 405, headers);
    let body: { v?: unknown; outcome?: unknown; bytes?: unknown; duration?: unknown; error?: unknown; width?: unknown; height?: unknown; fps?: unknown; vcodec?: unknown; acodec?: unknown };
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
      width: typeof body.width === "number" ? body.width : undefined,
      height: typeof body.height === "number" ? body.height : undefined,
      fps: typeof body.fps === "number" ? body.fps : undefined,
      vcodec: typeof body.vcodec === "string" ? body.vcodec : undefined,
      acodec: typeof body.acodec === "string" ? body.acodec : undefined,
    });
    return json(result.job, result.status, headers);
  }
  if (url.pathname === "/full/progress") {
    if (req.method !== "POST") return json({ error: "method" }, 405, headers);
    let body: { v?: unknown; phase?: unknown; received?: unknown; total?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "bad-json" }, 400, headers);
    }
    const v = youtubeOnly(body.v);
    const phase = body.phase === "upload" ? "upload" : body.phase === "download" ? "download" : null;
    const received = typeof body.received === "number" && body.received >= 0 ? Math.floor(body.received) : null;
    if (!v || !phase || received == null) return json({ error: "bad-video" }, 400, headers);
    const total = typeof body.total === "number" && body.total > 0 ? Math.floor(body.total) : undefined;
    const job = await noteProgress(bucket, v, opts.now, { phase, received, total });
    if (!job) return json({ error: "no-job" }, 404, headers);
    return json({ ...job, runner }, 200, headers);
  }
  if (url.pathname === "/full/jobs" && req.method === "GET") {
    const v = youtubeOnly(url.searchParams.get("v"));
    if (!v) return json({ error: "bad-video" }, 400, headers);
    const ready = await bucket.get(readyKey(v));
    if (ready) {
      try {
        const rec = JSON.parse(await ready.text()) as ReadyRecord;
        if (rec.verified && rec.v === v && !rec.url.includes("/clips/") && rec.bytes >= MIN_FULL_BYTES && rec.duration >= MIN_FULL_SECONDS) {
          return json({ ...(await readJob(bucket, v)), ...rec, v, status: "ready", url: fullMediaUrl(v), runner }, 200, headers);
        }
      } catch {
        /* ignore a broken record and fall through to the job */
      }
    }
    const job = await readJob(bucket, v);
    return json(job ? { ...job, runner } : { v, status: "unknown", runner }, 200, headers);
  }
  if (url.pathname === "/full/jobs" && req.method === "POST") {
    let body: { v?: unknown; url?: unknown; origin?: unknown; retry?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "bad-json" }, 400, headers);
    }
    if ("url" in body) return json({ error: "id-only" }, 400, headers);
    const v = youtubeOnly(body.v);
    if (!v) return json({ error: "bad-video" }, 400, headers);
    if (body.origin !== "manual") {
      const ready = await bucket.get(readyKey(v));
      const existing = await readJob(bucket, v);
      if (ready) return json({ ...(existing ?? { v }), v, status: "ready", runner }, 200, headers);
      return json(existing ? { ...existing, runner } : { v, status: "unknown", runner }, 200, headers);
    }
    const result = body.retry === true ? await retryManual(bucket, v, opts.now, runner) : await enqueue(bucket, v, opts.now, runner, "manual");
    return json(result.job, result.status, headers);
  }
  return json({ error: "not-found" }, 404, headers);
}
