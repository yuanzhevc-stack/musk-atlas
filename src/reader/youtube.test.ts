import assert from "node:assert/strict";
import { test } from "node:test";

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  },
});

test("caption errors stay specific when YouTube blocks the fetch", async () => {
  const { captionErrorMessage } = await import("./youtube.ts");
  assert.equal(captionErrorMessage("no_captions", 404), "这个视频没有字幕");
  assert.equal(captionErrorMessage("no_english", 404), "这个视频没有英文字幕");
  assert.equal(captionErrorMessage("captions_blocked", 503), "YouTube 暂时拦下了字幕请求（登录或机器人检查），稍后再试");
  assert.equal(captionErrorMessage("timedtext_blocked", 502), "YouTube 暂时拒绝了字幕请求，稍后再试");
  assert.equal(captionErrorMessage("unavailable", 404), "这个视频不存在或已无法观看");
  assert.equal(captionErrorMessage("age_restricted", 403), "这个视频有年龄限制，公开字幕拿不到");
  assert.equal(captionErrorMessage("empty_captions", 502), "字幕是空的");
  assert.equal(captionErrorMessage(undefined, 503), "字幕获取失败（503）");
  assert.equal(captionErrorMessage("captions_blocked", 503).includes("没有字幕"), false);
});
