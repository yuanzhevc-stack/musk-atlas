/** Keep a full lesson on this browser so the next open starts from disk, not from a fresh download. */
const CACHE = "musk-atlas-full-media-v1";
const MIN_BYTES = 2_000_000;

const queued: string[] = [];
const inflight = new Set<string>();
let pumping = false;

export function retainMedia(src: string) {
  if (!src || inflight.has(src) || queued.includes(src)) return;
  queued.push(src);
  void pump();
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queued.length) {
      const src = queued.shift();
      if (!src || inflight.has(src)) continue;
      inflight.add(src);
      try {
        await storeOne(src);
      } finally {
        inflight.delete(src);
      }
    }
  } finally {
    pumping = false;
    if (queued.length) void pump();
  }
}

async function storeOne(src: string) {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open(CACHE);
    if (await cache.match(src)) return;
    const res = await fetch(src, { priority: "low" } as RequestInit);
    if (!res.ok || !res.body) return;
    const len = Number(res.headers.get("Content-Length")) || 0;
    if (len && len < MIN_BYTES) return;
    await cache.put(src, res);
  } catch {
    /* a missed save only means the next open tries again */
  }
}

/** A blob URL of the saved file, or null when this browser has not kept it yet. */
export async function cachedBlobUrl(src: string): Promise<string | null> {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(src);
    if (!hit) return null;
    const blob = await hit.blob();
    if (blob.size < MIN_BYTES) return null;
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}
