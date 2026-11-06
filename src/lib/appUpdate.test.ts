import assert from "node:assert/strict";
import { test } from "node:test";
import { nextDocumentUrl, reloadTarget } from "./appUpdate";

const oldSrc = "/musk-atlas/assets/index-D2D9ULwv.js";
const nextSrc = "/musk-atlas/assets/index-B82HncN7.js";

test("a matching script does not reload", () => {
  assert.equal(reloadTarget(nextSrc, nextSrc, null), null);
  assert.equal(reloadTarget(oldSrc, oldSrc, null), null);
});

test("a newer script reloads once and then stops", () => {
  assert.equal(reloadTarget(oldSrc, nextSrc, null), nextSrc);
  assert.equal(reloadTarget(oldSrc, nextSrc, nextSrc), null);
});

test("rejects a version value that is not a script path", () => {
  assert.equal(reloadTarget(oldSrc, "javascript:alert(1)", null), null);
  assert.equal(reloadTarget(oldSrc, "../secret.js", null), null);
  assert.equal(reloadTarget(oldSrc, "", null), null);
});

test("the replacement URL keeps the hash route and does not drop storage", () => {
  const href = "https://yuanzhevc-stack.github.io/musk-atlas/#/corpus";
  const next = new URL(nextDocumentUrl(href, nextSrc));
  assert.equal(next.pathname, "/musk-atlas/");
  assert.equal(next.hash, "#/corpus");
  assert.equal(next.searchParams.get("v"), "index-B82HncN7.js");
});
