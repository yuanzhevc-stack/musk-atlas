import assert from "node:assert/strict";
import test from "node:test";
import { checkCloze, checkWords, clozePieces, loopDecision, loopRange, nextSpeed, personalCards } from "./lessonDesk.ts";

test("dictation compares words and ignores punctuation", () => {
  const hit = checkWords("Now we go this way.", "now we go this way");
  assert.equal(hit.same, true);
  assert.equal(hit.correct, 5);
  const miss = checkWords("I think it's probably enough.", "I think it is enough");
  assert.equal(miss.same, false);
  assert.equal(miss.matches[2], false);
  assert.equal(miss.total, 5);
});

test("cloze blanks are stable and skip function words", () => {
  const sentence = "I think it's probably enough too. Now we're gonna get some chicken.";
  const a = clozePieces(sentence);
  const b = clozePieces(sentence);
  assert.deepEqual(a.answers, b.answers);
  assert.ok(a.answers.length >= 1);
  assert.ok(a.answers.every((word) => word.length >= 4));
  assert.equal(a.answers.some((word) => ["the", "and", "this", "that"].includes(word.toLowerCase())), false);
  const check = checkCloze(a.answers, a.answers);
  assert.equal(check.same, true);
  const wrong = checkCloze(a.answers, a.answers.map((word, i) => (i === 0 ? "xxxx" : word)));
  assert.equal(wrong.same, false);
});

test("a sentence loop holds at the end and restarts after the interval", () => {
  assert.deepEqual(loopDecision({ time: 3, start: 1, end: 5, enabled: true, pauseAfter: false, intervalSec: 2, holding: false, heldForSec: 0 }), { type: "none" });
  assert.deepEqual(loopDecision({ time: 5, start: 1, end: 5, enabled: true, pauseAfter: false, intervalSec: 2, holding: false, heldForSec: 0 }), { type: "hold" });
  assert.deepEqual(loopDecision({ time: 5, start: 1, end: 5, enabled: true, pauseAfter: false, intervalSec: 2, holding: true, heldForSec: 1 }), { type: "none" });
  assert.deepEqual(loopDecision({ time: 5, start: 1, end: 5, enabled: true, pauseAfter: false, intervalSec: 2, holding: true, heldForSec: 2 }), { type: "restart", at: 1 });
  assert.deepEqual(loopDecision({ time: 5, start: 1, end: 5, enabled: true, pauseAfter: true, intervalSec: 0, holding: true, heldForSec: 9 }), { type: "none" });
  assert.equal(loopDecision({ time: 9, start: 1, end: 5, enabled: false, pauseAfter: false, intervalSec: 0, holding: false, heldForSec: 0 }).type, "none");
});

test("an A-B range uses the first start and the last sentence end", () => {
  const range = loopRange([0, 4, 9], 0, 1);
  assert.equal(range?.start, 0);
  assert.equal(range?.end, 9);
});

test("speed cycles through the real steps", () => {
  assert.equal(nextSpeed(1), 1.25);
  assert.equal(nextSpeed(2), 0.75);
});

test("cards are saved lesson words ordered by review time", () => {
  const cards = personalCards(
    [
      { key: "chicken", text: "chicken", kind: "word", meaning: "鸡", status: 1, srs: { due: 50 }, ctx: { lesson: "L" } },
      { key: "sample", text: "sample", kind: "word", meaning: "", status: 1, ctx: { lesson: "other" } },
      { key: "costco", text: "Costco", kind: "word", meaning: "", status: 2, srs: { due: 10 } },
      { key: "lets go this way", text: "let's go this way", kind: "sentence", meaning: "", status: 1, ctx: { lesson: "L" } },
    ],
    "L",
    new Set(["costco"]),
  );
  assert.deepEqual(cards.map((c) => c.key), ["costco", "chicken"]);
});
