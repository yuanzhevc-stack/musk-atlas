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

test("spoken lines stay inside their caption and do not share one start time", async () => {
  const { captionsToLesson, speechLines } = await import("./youtube.ts");
  const { parse } = await import("./model.ts");
  const segs: [number, number, string][] = [
    [0, 10000, "SO MANY AREAS OF CONVERGENCE THAT THAT DIDN'T EXIST IN YEARS BEFORE AND ARE INCREASINGLY SIGNIFICANT TO THE FUTURE."],
    [10000, 7000, ">> I GOT A HARD QUESTION FOR YOU. WE ASKED READERS IF THEY HAD QUESTIONS FOR YOU, AND ONE QUESTION THAT CAME BACK A LOT WAS THIS. IT RELATES TO THE"],
    [17000, 8000, "MERGER OF SPACEX AND TESLA, AND RELATES TO THE IDEA THAT AT TESLA, YOU HAVE A PAY AWARD THAT'S TIED TO OPERATING"],
  ];
  const lines = speechLines(segs);
  assert.equal(lines[0].text.endsWith("future."), true);
  assert.equal(lines[0].text.startsWith("So many"), true);
  assert.equal(lines[0].ms, 0);
  assert.ok(lines[1].ms >= 10000);
  assert.ok(lines.every((line, i) => i === 0 || line.ms > lines[i - 1].ms));
  const relates = lines.find((line) => /relates to the merger/i.test(line.text));
  assert.ok(relates);
  assert.ok(relates.ms >= 10000);
  assert.ok(relates.ms < 17000);
  assert.equal(lines.some((line) => /merger/i.test(line.text) && line.ms < 10000), false);
  const lesson = captionsToLesson({ v: "abcdefghijk", title: "", author: "", lang: "en", kind: "manual", segs });
  assert.equal(lesson.times.length, parse(lesson.text).sentences.length);
  assert.equal(lesson.times.length, lesson.text.split(/\n+/).filter((line) => line.trim()).length);
  assert.ok(lesson.times[1] >= 10);
  const sentences = parse(lesson.text).sentences;
  const merger = sentences.findIndex((line) => /merger/i.test(line));
  assert.ok(merger > 0);
  assert.ok(lesson.times[merger] >= 10);
  assert.ok(lesson.times[merger] < 17);
});

test("caption fragments join into a sentence and a new but-clause starts another", async () => {
  const { speechLines } = await import("./youtube.ts");
  const lines = speechLines([
    [61000, 2000, "Many of you know that I'm very big"],
    [63000, 2000, "on creating a vision for your future,"],
    [65000, 2000, "but the best way to do that"],
    [67000, 2000, "is by also creating an antidote"],
    [69000, 2000, "and having a negative thing."],
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, "Many of you know that I'm very big on creating a vision for your future,");
  assert.equal(lines[0].ms, 61000);
  assert.equal(lines[1].text, "but the best way to do that is by also creating an antidote and having a negative thing.");
  assert.equal(lines[1].ms, 65000);
});

test("all-caps captions become sentence case and normal captions stay", async () => {
  const { sentenceCase } = await import("./youtube.ts");
  assert.equal(sentenceCase("SO MANY AREAS OF CONVERGENCE."), "So many areas of convergence.");
  assert.equal(sentenceCase("I DON'T THINK I SHOULD BE COMPENSATED."), "I don't think I should be compensated.");
  assert.equal(sentenceCase("MERGER OF SPACEX AND TESLA."), "Merger of SpaceX and Tesla.");
  assert.equal(sentenceCase("Elon already wrote this in normal case."), "Elon already wrote this in normal case.");
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
