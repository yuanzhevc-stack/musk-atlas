/** Signed-in study library. The server copy is the one other devices read. */
import { useSyncExternalStore } from "react";
import { flush, onProgressCommit, replaceProgress, store } from "../store/store";
import { allNotes, onNotesCommit, replaceNotes } from "./lessonNotes";
import { onLibraryCommit, reader, replaceLibrary, type Item, type Lesson } from "./model";

const TTS_URL = "https://musk-atlas-tts.yuanzhevc.workers.dev";
const TOKEN_KEY = "musk-atlas:session";
const EMAIL_KEY = "musk-atlas:session-email";

export interface CloudLibrary {
  rev: number;
  savedAt?: number;
  lessons: Lesson[];
  items: Record<string, Item>;
  notes: Record<string, string>;
  progress: unknown;
}

type Session = { email: string; token: string } | null;
type Status = "off" | "syncing" | "saved" | "error";

type AccountView = { session: Session; status: Status; detail: string };
let session: Session = readSession();
let status: Status = session ? "syncing" : "off";
let detail = "";
let rev = 0;
let view: AccountView = { session, status, detail };
const listeners = new Set<() => void>();

function readSession(): Session {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const email = localStorage.getItem(EMAIL_KEY);
    if (!token || !email) return null;
    return { token, email };
  } catch {
    return null;
  }
}

function emit() {
  listeners.forEach((fn) => fn());
}

function setStatus(next: Status, text = "") {
  status = next;
  detail = text;
  view = { session, status, detail };
  emit();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useAccount() {
  return useSyncExternalStore(subscribe, () => view);
}

async function call(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (session) headers.set("Authorization", `Bearer ${session.token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(`${TTS_URL}${path}`, { ...init, headers });
}

function snapshot(): Omit<CloudLibrary, "rev" | "savedAt"> {
  flush();
  const lib = reader.get();
  return { lessons: lib.lessons, items: lib.items, notes: allNotes(), progress: store.get().progress };
}

function mergeProgress(server: unknown, local: unknown): unknown {
  const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!isRec(server)) return local ?? null;
  if (!isRec(local)) return server;
  const sCards = isRec(server.cards) ? server.cards : {};
  const lCards = isRec(local.cards) ? local.cards : {};
  const cards: Record<string, unknown> = { ...sCards };
  for (const [id, card] of Object.entries(lCards)) {
    const prev = cards[id] as { reps?: number; seen?: number } | undefined;
    const next = card as { reps?: number; seen?: number };
    if (!prev || (next.reps ?? 0) > (prev.reps ?? 0) || ((next.reps ?? 0) === (prev.reps ?? 0) && (next.seen ?? 0) >= (prev.seen ?? 0))) cards[id] = card;
  }
  const sDays = isRec(server.days) ? server.days : {};
  const lDays = isRec(local.days) ? local.days : {};
  const days: Record<string, unknown> = { ...sDays };
  for (const [day, stat] of Object.entries(lDays)) {
    const prev = days[day] as { n?: number; r?: number; t?: number } | undefined;
    const next = stat as { n?: number; r?: number; t?: number };
    const score = (d?: { n?: number; r?: number; t?: number }) => (d?.n ?? 0) + (d?.r ?? 0) + (d?.t ?? 0);
    if (!prev || score(next) >= score(prev)) days[day] = stat;
  }
  const bookmarks = [...new Set([...(Array.isArray(server.bookmarks) ? server.bookmarks : []), ...(Array.isArray(local.bookmarks) ? local.bookmarks : [])])].slice(0, 20000);
  return { ...server, ...local, cards, days, bookmarks, version: 2 };
}

export function mergeCloud(server: CloudLibrary, local: Omit<CloudLibrary, "rev" | "savedAt">): Omit<CloudLibrary, "rev" | "savedAt"> {
  const lessons = new Map<string, Lesson>();
  for (const lesson of server.lessons ?? []) if (lesson?.id) lessons.set(lesson.id, lesson);
  for (const lesson of local.lessons ?? []) {
    if (!lesson?.id) continue;
    const prev = lessons.get(lesson.id);
    if (!prev || (lesson.opened ?? lesson.created ?? 0) >= (prev.opened ?? prev.created ?? 0)) lessons.set(lesson.id, lesson);
  }
  const items: Record<string, Item> = { ...(server.items ?? {}) };
  for (const [key, item] of Object.entries(local.items ?? {})) {
    const prev = items[key];
    if (!prev || (item?.updated ?? 0) >= (prev.updated ?? 0)) items[key] = item;
  }
  return {
    lessons: [...lessons.values()],
    items,
    notes: { ...(server.notes ?? {}), ...(local.notes ?? {}) },
    progress: mergeProgress(server.progress, local.progress),
  };
}

function apply(lib: CloudLibrary) {
  replaceLibrary({ lessons: lib.lessons ?? [], items: lib.items ?? {} });
  replaceNotes(lib.notes ?? {});
  if (lib.progress) replaceProgress(lib.progress);
  rev = lib.rev ?? 0;
}

function signature(lib: Omit<CloudLibrary, "rev" | "savedAt">) {
  const lessons = (lib.lessons ?? []).map((l) => `${l.id}:${l.opened ?? 0}:${l.text?.length ?? 0}`).sort().join("|");
  const items = Object.entries(lib.items ?? {}).map(([k, v]) => `${k}:${v?.updated ?? 0}`).sort().join("|");
  const notes = Object.keys(lib.notes ?? {}).sort().join("|");
  const cards = lib.progress && typeof lib.progress === "object" && lib.progress && "cards" in lib.progress ? Object.keys((lib.progress as { cards?: object }).cards ?? {}).length : 0;
  return `${lessons}#${items}#${notes}#${cards}`;
}

let sending = false;
let pending = false;
let timer = 0;

async function push() {
  if (!session) return;
  if (sending) {
    pending = true;
    return;
  }
  sending = true;
  setStatus("syncing");
  try {
    let res = await call("/library", { method: "PUT", body: JSON.stringify({ baseRev: rev, ...snapshot() }) });
    if (res.status === 401) {
      signOutLocal();
      return;
    }
    if (res.status === 409) {
      const server = (await res.json()) as CloudLibrary;
      const merged = mergeCloud(server, snapshot());
      apply({ ...server, ...merged, rev: server.rev });
      res = await call("/library", { method: "PUT", body: JSON.stringify({ baseRev: rev, ...snapshot() }) });
    }
    if (!res.ok) {
      setStatus("error", "没能存上，这台浏览器上的修改还在。");
      return;
    }
    const saved = (await res.json()) as CloudLibrary;
    rev = saved.rev ?? rev;
    setStatus("saved", session.email);
  } catch {
    setStatus("error", "账号服务没连上，这台浏览器上的修改还在。");
  } finally {
    sending = false;
    if (pending) {
      pending = false;
      void push();
    }
  }
}

function schedule() {
  if (!session) return;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void push(), 500);
}

let hooked = false;
function hook() {
  if (hooked) return;
  hooked = true;
  onLibraryCommit(() => schedule());
  onNotesCommit(() => schedule());
  onProgressCommit(() => schedule());
  window.addEventListener("pagehide", () => {
    if (session) void push();
  });
}

export async function bootCloud() {
  hook();
  if (!session) return;
  setStatus("syncing");
  try {
    const me = await call("/auth/me");
    if (me.status === 401) {
      signOutLocal();
      return;
    }
    if (!me.ok) {
      setStatus("error", "账号服务没连上。先用这台浏览器里的课。");
      return;
    }
    const libRes = await call("/library");
    if (!libRes.ok) {
      setStatus("error", "课表没读下来。先用这台浏览器里的课。");
      return;
    }
    const server = (await libRes.json()) as CloudLibrary;
    const local = snapshot();
    const merged = mergeCloud(server, local);
    apply({ ...server, ...merged, rev: server.rev ?? 0 });
    if (signature(merged) !== signature(server)) await push();
    else setStatus("saved", session.email);
  } catch {
    setStatus("error", "账号服务没连上。先用这台浏览器里的课。");
  }
}

function remember(email: string, token: string) {
  session = { email, token };
  view = { session, status, detail };
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(EMAIL_KEY, email);
  emit();
}

function signOutLocal() {
  session = null;
  rev = 0;
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EMAIL_KEY);
  } catch {
    /* already signed out in memory */
  }
  setStatus("off");
}

export async function signIn(email: string, password: string, mode: "login" | "register") {
  const res = await call(mode === "register" ? "/auth/register" : "/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (res.status === 409) throw new Error("这个邮箱已经注册了。");
  if (res.status === 400) throw new Error("邮箱要能收信，密码至少 8 位。");
  if (res.status === 401) throw new Error("邮箱或密码不对。");
  if (!res.ok) throw new Error("账号服务没连上。");
  const body = (await res.json()) as { email: string; token: string };
  remember(body.email, body.token);
  await bootCloud();
}

export async function signOut() {
  const current = session;
  signOutLocal();
  if (!current) return;
  await fetch(`${TTS_URL}/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${current.token}` } }).catch(() => null);
}
