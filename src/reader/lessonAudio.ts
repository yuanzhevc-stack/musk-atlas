/** Local microphone clips for one sentence. Nothing here is uploaded. */

const DB = "musk-atlas-lesson-audio";
const STORE = "clips";

export function recorderSupport(): "ready" | "unsupported" {
  if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) return "unsupported";
  return "ready";
}

export function recordingError(error: unknown): "denied" | "unsupported" {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied";
  return "unsupported";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const urls = new Map<string, string>();
const keyOf = (lessonId: string, sid: number) => `${lessonId}:${sid}`;

export function clipUrl(lessonId: string, sid: number): string | null {
  return urls.get(keyOf(lessonId, sid)) ?? null;
}

export async function saveClip(lessonId: string, sid: number, blob: Blob): Promise<string> {
  const id = keyOf(lessonId, sid);
  const url = URL.createObjectURL(blob);
  const prev = urls.get(id);
  if (prev) URL.revokeObjectURL(prev);
  urls.set(id, url);
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(blob, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* the clip still plays for this visit */
  }
  return url;
}

export async function loadClip(lessonId: string, sid: number): Promise<string | null> {
  const id = keyOf(lessonId, sid);
  const cached = urls.get(id);
  if (cached) return cached;
  try {
    const db = await openDb();
    const blob = await new Promise<Blob | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve((req.result as Blob | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    urls.set(id, url);
    return url;
  } catch {
    return null;
  }
}
