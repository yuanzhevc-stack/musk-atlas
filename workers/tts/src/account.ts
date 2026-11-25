/** Accounts and the study library. The browser keeps only the session token. */

export interface AccountBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CloudLibrary {
  rev: number;
  savedAt: number;
  lessons: unknown[];
  items: Record<string, unknown>;
  notes: Record<string, string>;
  progress: unknown;
}

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_LIBRARY_BYTES = 5_000_000;
const PBKDF2_ITERATIONS = 100_000;

const emptyLibrary = (now: number): CloudLibrary => ({ rev: 0, savedAt: now, lessons: [], items: {}, notes: {}, progress: null });

function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function sha256(bytes: BufferSource | string): Promise<string> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes: number) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length < 5 || email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function passwordOf(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 8 || value.length > 72) return null;
  return value;
}

async function pbkdf2(password: string, saltHex: string): Promise<string> {
  const salt = new Uint8Array(saltHex.match(/../g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readJson<T>(bucket: AccountBucket, key: string): Promise<T | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text()) as T;
  } catch {
    return null;
  }
}

function bearer(req: Request): string | null {
  const header = req.headers.get("Authorization") ?? "";
  const match = /^Bearer ([a-f0-9]{64})$/i.exec(header);
  return match ? match[1].toLowerCase() : null;
}

async function userForToken(bucket: AccountBucket, token: string, now: number): Promise<{ id: string; email: string } | null> {
  const key = `acct/session/${await sha256(token)}`;
  const row = await readJson<{ user: string; email: string; exp: number }>(bucket, key);
  if (!row || row.exp < now || !row.user || !row.email) {
    if (row) await bucket.delete(key);
    return null;
  }
  return { id: row.user, email: row.email };
}

function libraryOf(raw: unknown, now: number): CloudLibrary | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Partial<CloudLibrary> & { baseRev?: unknown };
  if (!Array.isArray(body.lessons) || body.lessons.length > 500) return null;
  if (!body.items || typeof body.items !== "object" || Array.isArray(body.items)) return null;
  const notes: Record<string, string> = {};
  if (body.notes && typeof body.notes === "object" && !Array.isArray(body.notes)) {
    for (const [k, v] of Object.entries(body.notes)) {
      if (typeof v === "string" && k.length <= 80) notes[k] = v.slice(0, 2000);
      if (Object.keys(notes).length >= 5000) break;
    }
  }
  return {
    rev: 0,
    savedAt: now,
    lessons: body.lessons,
    items: body.items as Record<string, unknown>,
    notes,
    progress: body.progress && typeof body.progress === "object" ? body.progress : null,
  };
}

export async function handleAccount(req: Request, bucket: AccountBucket, headers: Record<string, string>, now: number): Promise<Response> {
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
    let body: { email?: unknown; password?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "bad-json" }, 400, headers);
    }
    const email = normalizeEmail(body.email);
    const password = passwordOf(body.password);
    if (!email || !password) return json({ error: "bad-login" }, 400, headers);
    const userId = await sha256(email);
    const userKey = `acct/user/${userId}`;
    const existing = await readJson<{ email: string; salt: string; hash: string }>(bucket, userKey);
    if (url.pathname === "/auth/register") {
      if (existing) return json({ error: "exists" }, 409, headers);
      const salt = randomHex(16);
      await bucket.put(userKey, JSON.stringify({ email, salt, hash: await pbkdf2(password, salt), created: now }));
    } else {
      if (!existing || !(await safeEqualAsync(await pbkdf2(password, existing.salt), existing.hash))) return json({ error: "unauthorized" }, 401, headers);
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
    if (req.method === "GET") return json((await readJson<CloudLibrary>(bucket, key)) ?? emptyLibrary(now), 200, headers);
    if (req.method !== "PUT") return json({ error: "method" }, 405, headers);
    const text = await req.text();
    if (text.length > MAX_LIBRARY_BYTES) return json({ error: "too-large" }, 413, headers);
    let parsed: { baseRev?: unknown };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      return json({ error: "bad-json" }, 400, headers);
    }
    const next = libraryOf(parsed, now);
    if (!next || typeof parsed.baseRev !== "number") return json({ error: "bad-library" }, 400, headers);
    const current = (await readJson<CloudLibrary>(bucket, key)) ?? emptyLibrary(now);
    if (parsed.baseRev !== current.rev) return json(current, 409, headers);
    next.rev = current.rev + 1;
    next.savedAt = now;
    await bucket.put(key, JSON.stringify(next));
    return json(next, 200, headers);
  }
  return json({ error: "not-found" }, 404, headers);
}

async function safeEqualAsync(a: string, b: string) {
  return safeEqual(a, b);
}
