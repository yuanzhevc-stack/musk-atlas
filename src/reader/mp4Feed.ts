/** Pull a fragmented MP4 apart as the bytes arrive, so playback can start on the first piece. */

export interface Mp4Piece {
  init: Uint8Array | null;
  segments: Uint8Array[];
  /** How many leading bytes are safe to drop. An unfinished fragment stays behind. */
  used: number;
}

const typeAt = (data: Uint8Array, i: number) => String.fromCharCode(data[i], data[i + 1], data[i + 2], data[i + 3]);

function u32(data: Uint8Array, i: number) {
  return ((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0;
}

/** Walk only the top-level boxes. `initSent` means ftyp+moov were already handed out. */
export function pullMp4(data: Uint8Array, initSent: boolean): Mp4Piece {
  let i = 0;
  let initEnd = -1;
  let segStart = -1;
  const segments: Uint8Array[] = [];
  while (i + 8 <= data.length) {
    const size = u32(data, i);
    if (size < 8 || i + size > data.length) break;
    const typ = typeAt(data, i + 4);
    if (typ === "moof") {
      if (!initSent && initEnd < 0) initEnd = i;
      segStart = i;
    } else if (typ === "mdat" && segStart >= 0) {
      segments.push(data.slice(segStart, i + size));
      segStart = -1;
    }
    i += size;
  }
  const init = !initSent && initEnd > 0 ? data.slice(0, initEnd) : null;
  const used = !initSent && initEnd < 0 ? 0 : segStart >= 0 ? segStart : i;
  return { init, segments, used };
}

/** Enough of the header to choose a player. Progressive files have mdat and no moof. */
export function sniffMp4(data: Uint8Array): "fragmented" | "progressive" | "unknown" {
  let i = 0;
  let sawMdat = false;
  while (i + 8 <= data.length) {
    const size = u32(data, i);
    if (size < 8 || i + size > data.length) break;
    const typ = typeAt(data, i + 4);
    if (typ === "moof") return "fragmented";
    if (typ === "mdat") sawMdat = true;
    i += size;
  }
  if (sawMdat) return "progressive";
  return "unknown";
}

function findAscii(data: Uint8Array, text: string) {
  const needle = text.split("").map((c) => c.charCodeAt(0));
  for (let i = 0; i + needle.length < data.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) if (data[i + j] !== needle[j]) ok = false;
    if (ok) return i;
  }
  return -1;
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();

/** Codec string from the init segment. Falls back to a widely played High@3.1 + AAC-LC pair. */
export function codecFromInit(init: Uint8Array): string {
  const at = findAscii(init, "avcC");
  if (at >= 0 && at + 7 < init.length) {
    return `avc1.${hex2(init[at + 5])}${hex2(init[at + 6])}${hex2(init[at + 7])},mp4a.40.2`;
  }
  return "avc1.64001F,mp4a.40.2";
}

const BASE_DATA_OFFSET = 0x000001;
const DEFAULT_BASE_IS_MOOF = 0x020000;

function flagsOf(body: Uint8Array) {
  return (body[1] << 16) | (body[2] << 8) | body[3];
}

function writeFlags(body: Uint8Array, flags: number) {
  body[1] = (flags >> 16) & 0xff;
  body[2] = (flags >> 8) & 0xff;
  body[3] = flags & 0xff;
}

function setU32(out: Uint8Array, i: number, n: number) {
  out[i] = (n >>> 24) & 0xff;
  out[i + 1] = (n >>> 16) & 0xff;
  out[i + 2] = (n >>> 8) & 0xff;
  out[i + 3] = n & 0xff;
}

function i32(data: Uint8Array, i: number) {
  const n = u32(data, i);
  return n > 0x7fffffff ? n - 0x100000000 : n;
}

/** How many absolute base-data-offset fields a moof will drop. */
function stripsIn(data: Uint8Array, end: number) {
  let i = 8;
  let n = 0;
  while (i + 8 <= end) {
    const size = u32(data, i);
    if (size < 8 || i + size > end) break;
    const typ = typeAt(data, i + 4);
    if (typ === "tfhd") {
      const body = data.subarray(i + 8, i + size);
      if (body.length >= 16 && flagsOf(body) & BASE_DATA_OFFSET) n += 1;
    } else if (typ === "traf" || typ === "moof") n += stripsIn(data.subarray(i, i + size), size);
    i += size;
  }
  return n;
}

function rewriteBox(data: Uint8Array, dropBytes: number): Uint8Array {
  const size = data.length;
  const typ = typeAt(data, 4);
  if (typ === "tfhd") {
    const body = data.subarray(8);
    const flags = flagsOf(body);
    if (!(flags & BASE_DATA_OFFSET) || body.length < 16) return data.slice();
    const next = new Uint8Array(data.length - 8);
    next.set(data.subarray(0, 16), 0);
    next.set(body.subarray(16), 16);
    setU32(next, 0, next.length);
    writeFlags(next.subarray(8), (flags & ~BASE_DATA_OFFSET) | DEFAULT_BASE_IS_MOOF);
    return next;
  }
  if (typ === "trun") {
    const copy = data.slice();
    const body = copy.subarray(8);
    if (body.length >= 12 && flagsOf(body) & BASE_DATA_OFFSET) setU32(copy, 16, i32(body, 8) - dropBytes);
    return copy;
  }
  if (typ === "moof" || typ === "traf") {
    const children: Uint8Array[] = [];
    let i = 8;
    while (i + 8 <= size) {
      const child = u32(data, i);
      if (child < 8 || i + child > size) break;
      children.push(rewriteBox(data.subarray(i, i + child), dropBytes));
      i += child;
    }
    const total = 8 + children.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    setU32(out, 0, total);
    out.set(data.subarray(4, 8), 4);
    let at = 8;
    for (const child of children) {
      out.set(child, at);
      at += child.length;
    }
    return out;
  }
  return data.slice();
}

/**
 * MSE rejects a fragment whose tfhd carries an absolute file offset.
 * Drop that field, address samples from the moof, and keep the bytes that follow it.
 */
export function fixFragment(segment: Uint8Array): Uint8Array {
  if (segment.length < 16 || typeAt(segment, 4) !== "moof") return segment;
  const moofSize = u32(segment, 0);
  if (moofSize < 8 || moofSize > segment.length) return segment;
  const drop = stripsIn(segment, moofSize) * 8;
  if (!drop) return segment;
  const moof = rewriteBox(segment.subarray(0, moofSize), drop);
  const out = new Uint8Array(moof.length + (segment.length - moofSize));
  out.set(moof, 0);
  out.set(segment.subarray(moofSize), moof.length);
  return out;
}
