import assert from "node:assert/strict";
import { test } from "node:test";
import { codecFromInit, fixFragment, pullMp4, sniffMp4 } from "./mp4Feed.ts";

function box(type: string, payload: Uint8Array) {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(type.split("").map((c) => c.charCodeAt(0)), 4);
  out.set(payload, 8);
  return out;
}

test("a fragmented file yields the init segment and each moof+mdat, holding a partial tail", () => {
  const init = new Uint8Array([...box("ftyp", new Uint8Array([1, 2])), ...box("moov", new Uint8Array([3]))]);
  const seg = new Uint8Array([...box("moof", new Uint8Array([4])), ...box("mdat", new Uint8Array([5, 6, 7]))]);
  const partial = seg.subarray(0, 4);
  const first = pullMp4(new Uint8Array([...init, ...partial]), false);
  assert.equal(first.init, null);
  assert.equal(first.segments.length, 0);
  assert.equal(first.used, 0);
  assert.equal(sniffMp4(new Uint8Array([...init, ...partial])), "unknown");

  const all = new Uint8Array([...init, ...seg, ...seg.subarray(0, 4)]);
  const piece = pullMp4(all, false);
  assert.deepEqual(piece.init, init);
  assert.equal(piece.segments.length, 1);
  assert.deepEqual(piece.segments[0], seg);
  assert.equal(piece.used, init.length + seg.length);
  assert.equal(sniffMp4(all), "fragmented");

  const rest = pullMp4(all.subarray(piece.used), true);
  assert.equal(rest.init, null);
  assert.equal(rest.segments.length, 0);
  assert.equal(rest.used, 0);
});

test("a progressive file is not treated as fragments", () => {
  const data = new Uint8Array([...box("ftyp", new Uint8Array(4)), ...box("moov", new Uint8Array(8)), ...box("mdat", new Uint8Array(12))]);
  assert.equal(sniffMp4(data), "progressive");
  const piece = pullMp4(data, false);
  assert.equal(piece.segments.length, 0);
});

test("codec string is read from avcC", () => {
  const init = box("avcC", new Uint8Array([1, 0x64, 0x00, 0x1f, 0xff]));
  assert.equal(codecFromInit(init), "avc1.64001F,mp4a.40.2");
});

test("absolute fragment offsets become moof-relative for the browser", () => {
  const tfhdBody = new Uint8Array(20);
  tfhdBody[3] = 0x39;
  tfhdBody.set([0, 0, 0, 1], 4);
  const tfhd = box("tfhd", tfhdBody);
  const trunBody = new Uint8Array(12);
  trunBody[3] = 1;
  new DataView(trunBody.buffer).setInt32(8, 100);
  const trun = box("trun", trunBody);
  const traf = box("traf", new Uint8Array([...tfhd, ...trun]));
  const mfhd = box("mfhd", new Uint8Array(8));
  const moof = box("moof", new Uint8Array([...mfhd, ...traf, ...traf]));
  const mdat = box("mdat", new Uint8Array([9, 9]));
  const fixed = fixFragment(new Uint8Array([...moof, ...mdat]));
  assert.equal(fixed.length, moof.length + mdat.length - 16);
  assert.equal(String.fromCharCode(fixed[4], fixed[5], fixed[6], fixed[7]), "moof");
  const view = new DataView(fixed.buffer, fixed.byteOffset, fixed.byteLength);
  let saw = 0;
  for (let i = 0; i + 20 < fixed.length; i++) {
    if (fixed[i + 4] === 116 && fixed[i + 5] === 114 && fixed[i + 6] === 117 && fixed[i + 7] === 110) {
      assert.equal(view.getInt32(i + 16), 84);
      saw += 1;
    }
  }
  assert.equal(saw, 2);
});
