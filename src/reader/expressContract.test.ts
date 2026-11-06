import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseSuggestion, validateExpressInput } from "./expressContract";

const good = {
  primary: {
    expression: "Set Aside",
    usage: "先放到一边，不是扔掉。",
    example: { en: "Set it aside for now.", zh: "先放到一边。" },
  },
  alternatives: [
    { expression: "Let Go", usage: "更偏松开手里的东西。", example: { en: "Let go of the cup.", zh: "松开杯子。" } },
    { expression: "Set Aside", usage: "和首选重复，应该丢掉。" },
  ],
  clips: [{ id: "fake" }],
  idiomatic: true,
};

test("parser keeps one primary, tidies case, and drops unknown fields", () => {
  const parsed = parseSuggestion("```json\n" + JSON.stringify(good) + "\n```");
  assert.ok(parsed);
  assert.equal(parsed.primary.expression, "set aside");
  assert.equal(parsed.primary.example.zh, "先放到一边。");
  assert.equal(parsed.alternatives.length, 1);
  assert.equal(parsed.alternatives[0].expression, "let go");
  assert.equal("clips" in parsed, false);
  assert.equal(JSON.stringify(parsed).includes("fake"), false);
});

test("a prose model answer is not a suggestion", () => {
  assert.equal(parseSuggestion("overhear is the most idiomatic"), null);
  assert.equal(parseSuggestion({ primary: { expression: "go", usage: "english only", example: { en: "Go.", zh: "走。" } } }), null);
});

test("input bounds", () => {
  assert.equal(validateExpressInput({ q: "把这件事放下" }).ok, true);
  assert.deepEqual(validateExpressInput({ q: "overhear" }), { ok: false, error: "not_chinese" });
  assert.equal(validateExpressInput({ q: "" }).ok, false);
  assert.equal(validateExpressInput({ q: "好".repeat(121) }).ok, false);
  assert.equal(validateExpressInput(["好"]).ok, false);
  const ctx = validateExpressInput({ q: "放下", context: "  松开手里的杯子  " });
  assert.equal(ctx.ok && ctx.context, "松开手里的杯子");
});

test("product code does not hardcode the sample paraphrase", () => {
  const files = [
    "src/reader/expressContract.ts",
    "src/reader/suggest.ts",
    "src/reader/englishLookup.ts",
    "src/reader/query.ts",
    "src/ui/QuickLookup.tsx",
    "workers/tts/src/express.ts",
  ];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    assert.equal(src.includes("偶然听到"), false, file);
    assert.equal(src.includes("overhear"), false, file);
  }
});
