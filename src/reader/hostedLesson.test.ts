import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CLIP_VIDEO_IDS, FULL_LESSON_URLS, cacheNote, classifyLesson, initialSource, lessonCache, readChoice, saveChoice, sentenceClipUrl } from "./hostedLesson";

test("sentence clips are the corpus videos, and none of them is a full lesson", () => {
  const manifest = JSON.parse(readFileSync("public/musk/index/manifest.json", "utf8")) as { videos: Record<string, unknown>; n: number; clips: number };
  assert.deepEqual([...CLIP_VIDEO_IDS].sort(), Object.keys(manifest.videos).sort());
  assert.equal(manifest.clips, manifest.n);
  assert.deepEqual(FULL_LESSON_URLS, {});
  for (const id of CLIP_VIDEO_IDS) {
    const found = lessonCache(id);
    assert.equal(found.kind, "clips");
    assert.equal("url" in found, false);
  }
  const clip = sentenceClipUrl("cdZZpaB2kDM", 140239);
  assert.equal(clip, "https://pub-ad0e50befa7b4387a7d73a8c8a796eb3.r2.dev/clips/cdZZpaB2kDM/140239.mp4");
  assert.equal(JSON.stringify(lessonCache("cdZZpaB2kDM")).includes(clip), false);
});

test("an imported lesson with no cache is not labeled as a hosted video", () => {
  assert.deepEqual(lessonCache("dQw4w9WgVcQ"), { kind: "none" });
  assert.match(cacheNote("none"), /不会从这台设备选文件/);
  assert.match(cacheNote("clips"), /单句片段/);
  assert.equal(/上传文件|选择视频|选择文件夹/.test(cacheNote("none") + cacheNote("clips")), false);
});

test("a full-file map is used only when the url is not a sentence clip", () => {
  const full = { cdZZpaB2kDM: "https://pub-ad0e50befa7b4387a7d73a8c8a796eb3.r2.dev/videos/cdZZpaB2kDM.mp4" };
  assert.deepEqual(classifyLesson("cdZZpaB2kDM", full, CLIP_VIDEO_IDS), { kind: "full", url: full.cdZZpaB2kDM });
  const clipAsFull = { cdZZpaB2kDM: sentenceClipUrl("cdZZpaB2kDM", 140239) };
  assert.equal(classifyLesson("cdZZpaB2kDM", clipAsFull, CLIP_VIDEO_IDS).kind, "clips");
});

test("the source choice is its own key and does not touch the reader store", () => {
  const mem = new Map<string, string>();
  const store = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", { value: store, configurable: true });
  localStorage.setItem("musk-atlas:reader:v1", "{\"items\":{\"oldword\":{\"meaning\":\"旧词保留\"}}}");
  saveChoice("cdZZpaB2kDM", "online");
  assert.equal(readChoice("cdZZpaB2kDM"), "online");
  assert.equal(initialSource("cdZZpaB2kDM"), "online");
  assert.equal(JSON.parse(localStorage.getItem("musk-atlas:reader:v1")!).items.oldword.meaning, "旧词保留");
  assert.equal(localStorage.getItem("musk-atlas:video-source:v1")!.includes("musk-atlas:reader"), false);
});
