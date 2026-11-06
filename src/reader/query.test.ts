import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyQuery, englishKey } from "./query";

test("english lookup ignores case and extra spaces", () => {
  assert.equal(englishKey("  Overhear  "), "overhear");
  assert.equal(englishKey("OVERHEAR"), "overhear");
  assert.equal(englishKey("Give   UP"), "give up");
  assert.equal(englishKey("overhear."), "overhear");
  assert.equal(englishKey("  don’t  "), "don't");
  const overheard = classifyQuery("  OVERHEARD ");
  assert.equal(overheard.kind, "en");
  if (overheard.kind === "en") assert.equal(overheard.key, "overheard");
});

test("chinese is recognized without a mode switch", () => {
  const zh = classifyQuery("偶然听到");
  assert.equal(zh.kind, "zh");
  if (zh.kind === "zh") assert.equal(zh.q, "偶然听到");
  const song = classifyQuery("  听到一首歌  ");
  assert.equal(song.kind, "zh");
  assert.equal(classifyQuery("overhear").kind, "en");
  assert.equal(classifyQuery("   ").kind, "empty");
  assert.equal(classifyQuery("……").kind, "empty");
});

test("a chinese sentence is not truncated into an english key", () => {
  const q = classifyQuery("我不是故意听见他们说话的");
  assert.equal(q.kind, "zh");
  if (q.kind === "zh") assert.equal(q.q.includes("听见"), true);
});
