/** Local full-lesson video: match a file the user picked. Never a sentence clip, never an upload. */

const PREF_KEY = "musk-atlas:video-source:v1";
const DB_NAME = "musk-atlas-local-video";
const DB_STORE = "handles";

export type SourceChoice = "local" | "online";
export type PlaybackMode = "local" | "online" | "pick";

const VIDEO_EXT = /\.(mp4|webm|mkv|mov|m4v)$/i;

export function normTitle(name: string): string {
  return name
    .replace(/\.[A-Za-z0-9]{2,4}$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .trim();
}

function words(name: string): string[] {
  return normTitle(name)
    .split(" ")
    .filter((w) => w.length > 1 && !/^\d+$/.test(w));
}

/** "id" when the YouTube id is in the filename, "title" when the name is the lesson, otherwise none. */
export function matchVideoFile(fileName: string, videoId: string, title: string): "id" | "title" | "none" {
  const base = fileName.split(/[/\\]/).pop() ?? fileName;
  if (videoId && new RegExp(`(^|[^A-Za-z0-9_-])${videoId}([^A-Za-z0-9_-]|$)`).test(base)) return "id";
  const a = words(base);
  const b = words(title);
  if (a.length < 3 || b.length < 3) return "none";
  if (normTitle(base) === normTitle(title)) return "title";
  const setA = new Set(a);
  let shared = 0;
  for (const w of b) if (setA.has(w)) shared++;
  const denom = new Set([...a, ...b]).size;
  if (shared >= 4 && shared / denom >= 0.72) return "title";
  return "none";
}

/** A usable local file plays. An explicit online choice stays online. Otherwise ask for a file. */
export function resolvePlayback(explicit: SourceChoice | undefined, localReady: boolean): PlaybackMode {
  if (explicit === "online") return "online";
  if (localReady) return "local";
  return "pick";
}

type Pref = { version: 1; byVideo: Record<string, SourceChoice> };

function readPref(): Pref {
  try {
    const raw = JSON.parse(localStorage.getItem(PREF_KEY) || "null") as Pref | null;
    if (raw && raw.version === 1 && raw.byVideo && typeof raw.byVideo === "object") return raw;
  } catch {
    /* private mode */
  }
  return { version: 1, byVideo: {} };
}

export function readChoice(videoId: string): SourceChoice | undefined {
  const v = readPref().byVideo[videoId];
  return v === "local" || v === "online" ? v : undefined;
}

export function saveChoice(videoId: string, choice: SourceChoice) {
  if (!videoId) return;
  try {
    const pref = readPref();
    pref.byVideo[videoId] = choice;
    localStorage.setItem(PREF_KEY, JSON.stringify(pref));
  } catch {
    /* quota: the choice still applies this visit */
  }
}

/** Files chosen in this tab. Gone after refresh. Not written to localStorage. */
const sessionFiles = new Map<string, File>();

export function sessionFile(videoId: string): File | undefined {
  return sessionFiles.get(videoId);
}

export function rememberSessionFile(videoId: string, file: File) {
  if (videoId && file) sessionFiles.set(videoId, file);
}

type AccessHandle = {
  kind: "file" | "directory";
  name: string;
  queryPermission?: (o: { mode: "read" }) => Promise<PermissionState>;
  requestPermission?: (o: { mode: "read" }) => Promise<PermissionState>;
  getFile?: () => Promise<File>;
  entries?: () => AsyncIterable<[string, AccessHandle]>;
};

type PickerWindow = Window & {
  showOpenFilePicker?: (opts?: { multiple?: boolean; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle[]>;
  showDirectoryPicker?: (opts?: { mode?: "read" }) => Promise<FileSystemDirectoryHandle>;
};

const asAccess = (handle: object): AccessHandle => handle as AccessHandle;

export function supportsDirectoryPicker(): boolean {
  return typeof window !== "undefined" && typeof (window as PickerWindow).showDirectoryPicker === "function";
}

const PICK_TYPES = [{ description: "视频", accept: { "video/*": [".mp4", ".webm", ".mkv", ".mov", ".m4v"] } }];

/** Null when the browser has no picker or it failed. Empty when the user cancelled. */
export async function pickFileHandles(): Promise<FileSystemFileHandle[] | null> {
  const open = (window as PickerWindow).showOpenFilePicker;
  if (!open) return null;
  try {
    return await open({ multiple: true, types: PICK_TYPES });
  } catch (e) {
    if ((e as Error).name === "AbortError") return [];
    return null;
  }
}

export async function pickDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  const open = (window as PickerWindow).showDirectoryPicker;
  if (!open) return null;
  try {
    return await open({ mode: "read" });
  } catch (e) {
    if ((e as Error).name === "AbortError") return null;
    throw e;
  }
}

type AnyHandle = FileSystemFileHandle | FileSystemDirectoryHandle;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key: string): Promise<AnyHandle | undefined> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(key);
      req.onsuccess = () => resolve(req.result as AnyHandle | undefined);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined;
  }
}

async function idbSet(key: string, value: AnyHandle): Promise<boolean> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const req = db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    return true;
  } catch {
    return false;
  }
}

async function permission(handle: AnyHandle): Promise<"granted" | "prompt" | "denied"> {
  try {
    const q = await asAccess(handle).queryPermission?.({ mode: "read" });
    if (q === "granted" || q === "prompt" || q === "denied") return q;
  } catch {
    /* older browser */
  }
  return "prompt";
}

export async function requestHandlePermission(handle: AnyHandle): Promise<boolean> {
  try {
    const r = await asAccess(handle).requestPermission?.({ mode: "read" });
    return r === "granted" || (await permission(handle)) === "granted";
  } catch {
    return false;
  }
}

async function fileFromHandle(handle: FileSystemFileHandle): Promise<File | null> {
  try {
    return await (asAccess(handle).getFile?.() ?? handle.getFile());
  } catch {
    return null;
  }
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function idInName(name: string): string | undefined {
  const m = name.match(/(?:^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{11})(?=[^A-Za-z0-9_-]|$)/);
  const id = m?.[1];
  return id && VIDEO_ID.test(id) ? id : undefined;
}

async function listVideoFiles(dir: FileSystemDirectoryHandle, depth = 0): Promise<FileSystemFileHandle[]> {
  const out: FileSystemFileHandle[] = [];
  const entries = asAccess(dir).entries;
  if (!entries) return out;
  try {
    for await (const [, handle] of entries.call(dir)) {
      if (handle.kind === "file" && VIDEO_EXT.test(handle.name)) out.push(handle as FileSystemFileHandle);
      else if (handle.kind === "directory" && depth < 1) out.push(...(await listVideoFiles(handle as FileSystemDirectoryHandle, depth + 1)));
    }
  } catch {
    /* permission dropped mid-scan */
  }
  return out;
}

export type LocalLookup =
  | { status: "ready"; file: File; remembered: boolean }
  | { status: "need-permission"; handle: AnyHandle }
  | { status: "need-file" };

/** Resolve a file the user already allowed. Does not open a picker and does not read the Downloads folder. */
export async function lookupLocalFile(videoId: string, title: string): Promise<LocalLookup> {
  const session = sessionFiles.get(videoId);
  if (session) return { status: "ready", file: session, remembered: false };
  const named = (await idbGet(`file:${videoId}`)) as FileSystemFileHandle | undefined;
  if (named?.kind === "file") {
    const perm = await permission(named);
    if (perm !== "granted") return { status: "need-permission", handle: named };
    const file = await fileFromHandle(named);
    if (file) return { status: "ready", file, remembered: true };
  }
  const dir = (await idbGet("dir")) as FileSystemDirectoryHandle | undefined;
  if (dir?.kind === "directory") {
    const perm = await permission(dir);
    if (perm !== "granted") return { status: "need-permission", handle: dir };
    const files = await listVideoFiles(dir);
    let best: FileSystemFileHandle | null = null;
    for (const handle of files) {
      const kind = matchVideoFile(handle.name, videoId, title);
      if (kind === "id") {
        best = handle;
        break;
      }
      if (kind === "title" && !best) best = handle;
      const id = idInName(handle.name);
      if (id) void idbSet(`file:${id}`, handle);
    }
    if (best) {
      await idbSet(`file:${videoId}`, best);
      const file = await fileFromHandle(best);
      if (file) return { status: "ready", file, remembered: true };
    }
  }
  return { status: "need-file" };
}

export async function storeFileHandle(videoId: string, handle: FileSystemFileHandle): Promise<boolean> {
  return idbSet(`file:${videoId}`, handle);
}

export async function storeDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<boolean> {
  return idbSet("dir", handle);
}

export function explicitFiles(videoId: string, title: string, files: File[]): { file: File | null; loose: boolean; unmatched: boolean } {
  const list = files.filter((f) => VIDEO_EXT.test(f.name) || f.type.startsWith("video/"));
  if (!list.length) return { file: null, loose: false, unmatched: true };
  if (list.length === 1) {
    const kind = matchVideoFile(list[0].name, videoId, title);
    rememberSessionFile(videoId, list[0]);
    return { file: list[0], loose: kind === "none", unmatched: false };
  }
  const hit = list.find((f) => matchVideoFile(f.name, videoId, title) !== "none");
  if (!hit) return { file: null, loose: false, unmatched: true };
  rememberSessionFile(videoId, hit);
  for (const f of list) {
    const id = idInName(f.name);
    if (id && id !== videoId) rememberSessionFile(id, f);
  }
  return { file: hit, loose: false, unmatched: false };
}
