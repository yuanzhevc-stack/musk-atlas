import assert from "node:assert/strict";
import { test } from "node:test";
import { centerScroll, followAllowed, isConfirmedMusk, lessonMedia, lyricScroll, sentenceAt, sentenceSpan, shouldRecenter, sourcePlan, wordAt } from "./sync";

const times = [0, 1.2, 4, 4, 9];

test("sentence index follows the player clock and does not jump early", () => {
  assert.equal(sentenceAt([], 3), 0);
  assert.equal(sentenceAt(times, -1), 0);
  assert.equal(sentenceAt(times, 0), 0);
  assert.equal(sentenceAt(times, 1.19), 0);
  assert.equal(sentenceAt(times, 1.2), 1);
  assert.equal(sentenceAt(times, 3.9), 1);
  assert.equal(sentenceAt(times, 4), 3);
  assert.equal(sentenceAt(times, 100), 4);
});

test("sentence span stops at the next caption and caps a long gap", () => {
  assert.equal(sentenceSpan([], 0), null);
  assert.deepEqual(sentenceSpan([0, 5, 40], 0), { t: 0, e: 5 });
  assert.deepEqual(sentenceSpan([0, 5, 40], 1), { t: 5, e: 35 });
  assert.deepEqual(sentenceSpan([0, 5, 40], 2), { t: 40, e: 46 });
  assert.equal(sentenceSpan([0, 5], 3), null);
});

test("a new save records the youtube id and time without calling it Musk", () => {
  assert.equal(lessonMedia(undefined, 0), undefined);
  assert.equal(lessonMedia({ v: "", times: [0] }, 0), undefined);
  const media = lessonMedia({ v: "abcdefghijk", times: [12, 18] }, 0);
  assert.deepEqual(media, { kind: "youtube", v: "abcdefghijk", t: 12, e: 18 });
  assert.equal("musk" in (media ?? {}), false);
});

test("playback prefers the real source and keeps older items playable", () => {
  const ctx = { lesson: "L1", sid: 1, sentence: "Look at that.", media: { kind: "youtube", v: "abcdefghijk", t: 3, e: 9 } };
  const lesson = { id: "L1", yt: { v: "abcdefghijk", times: [0, 5, 40] } };
  assert.deepEqual(sourcePlan(ctx, lesson), { type: "youtube", v: "abcdefghijk", t: 5, e: 35 });
  assert.deepEqual(sourcePlan(ctx, undefined), { type: "youtube", v: "abcdefghijk", t: 3, e: 9 });
  assert.deepEqual(sourcePlan({ lesson: "musk", sid: 4, sentence: "Wow.", musk: { v: "zzz", t: 8 } }, lesson), { type: "musk", v: "zzz", t: 8 });
  assert.deepEqual(sourcePlan({ lesson: "L1", sid: 0, sentence: "No video here." }, undefined), { type: "tts" });
  assert.deepEqual(sourcePlan(undefined, lesson), { type: "none" });
  assert.deepEqual(sourcePlan({ lesson: "other", sid: 1, sentence: "x", media: { kind: "nope", t: 1 } }, { id: "other" }), { type: "tts" });
});

test("only a confirmed voiceprint is Musk", () => {
  assert.equal(isConfirmedMusk("musk"), true);
  assert.equal(isConfirmedMusk("uncertain"), false);
  assert.equal(isConfirmedMusk("not_musk"), false);
  assert.equal(isConfirmedMusk(null), false);
  assert.equal(isConfirmedMusk(undefined), false);
});

test("lyrics keep the current line on the focus line and inside the pane", () => {
  assert.equal(lyricScroll(200, 1000, 500, 40), 444);
  assert.equal(lyricScroll(200, 1000, 0, 40), 0);
  assert.equal(lyricScroll(200, 1000, 960, 40), 800);
  assert.equal(lyricScroll(400, 400, 200, 40), 0);
});

test("transcript centers the current line and stays inside the pane", () => {
  assert.equal(centerScroll(200, 1000, 500, 40), 420);
  assert.equal(centerScroll(200, 1000, 0, 40), 0);
  assert.equal(centerScroll(200, 1000, 960, 40), 800);
  assert.equal(centerScroll(400, 400, 200, 40), 0);
  assert.equal(centerScroll(0, 1000, 100, 20), 0);
  assert.equal(shouldRecenter(420, 430), false);
  assert.equal(shouldRecenter(0, 420), true);
});

test("a clock tick just before the next sentence does not switch early", () => {
  const marks = [0, 10, 20, 30];
  assert.equal(sentenceAt(marks, 9.99), 0);
  assert.equal(sentenceAt(marks, 10), 1);
  assert.equal(sentenceAt(marks, 19.5), 1);
  assert.equal(sentenceAt(marks, 30), 3);
});

test("follow pauses while selecting, while a card is open, or after a manual scroll", () => {
  assert.equal(followAllowed({ picking: false, cardOpen: false, userHold: false }), true);
  assert.equal(followAllowed({ picking: true, cardOpen: false, userHold: false }), false);
  assert.equal(followAllowed({ picking: false, cardOpen: true, userHold: false }), false);
  assert.equal(followAllowed({ picking: false, cardOpen: false, userHold: true }), false);
});

test("word highlight index changes only when the spoken word changes", () => {
  const starts = [0.5, 1, 1.4];
  assert.equal(wordAt(starts, 0.4), -1);
  assert.equal(wordAt(starts, 0.5), 0);
  assert.equal(wordAt(starts, 1.2), 1);
  assert.equal(wordAt(starts, 9), 2);
  assert.equal(wordAt([], 1), -1);
});
