import assert from "node:assert/strict";
import { test } from "node:test";
import { YOUTUBE_STARTUP_MESSAGE, YOUTUBE_STARTUP_MS, youtubeEventAllowed } from "./youtubeStartup";

test("a late ready or timeout cannot overwrite a failure or a started player", () => {
  assert.equal(youtubeEventAllowed("loading", "ready"), true);
  assert.equal(youtubeEventAllowed("loading", "timeout"), true);
  assert.equal(youtubeEventAllowed("error", "ready"), false);
  assert.equal(youtubeEventAllowed("error", "timeout"), false);
  assert.equal(youtubeEventAllowed("embed", "ready"), false);
  assert.equal(youtubeEventAllowed("playing", "ready"), false);
  assert.equal(youtubeEventAllowed("playing", "state"), true);
  assert.equal(youtubeEventAllowed("error", "state"), false);
  assert.equal(youtubeEventAllowed("blocked", "failure"), true);
  assert.equal(youtubeEventAllowed("missing", "failure"), false);
});

test("startup copy does not blame the network and stays bounded", () => {
  assert.equal(YOUTUBE_STARTUP_MESSAGE.includes("网络"), false);
  assert.equal(YOUTUBE_STARTUP_MESSAGE.includes("重试"), true);
  assert.equal(YOUTUBE_STARTUP_MESSAGE.includes("缓存"), true);
  assert.equal(YOUTUBE_STARTUP_MESSAGE.includes("选择本机"), false);
  assert.equal(YOUTUBE_STARTUP_MS <= 8000, true);
  assert.equal(YOUTUBE_STARTUP_MS >= 1000, true);
});
