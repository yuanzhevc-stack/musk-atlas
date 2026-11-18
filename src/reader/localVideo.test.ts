import assert from "node:assert/strict";
import { test } from "node:test";
import { explicitFiles, matchVideoFile, readChoice, resolvePlayback, saveChoice } from "./localVideo";

const mem = new Map<string, string>();
if (typeof localStorage === "undefined") {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: () => null,
      length: 0,
    },
  });
}

test("a downloaded lesson matches its YouTube id or title, not a loose name", () => {
  const title = "How To Get Ahead Of 99% Of People (In 6-12 Months)";
  assert.equal(matchVideoFile("How To Get Ahead Of 99% Of People (In 6-12 Months).mp4", "abcdefghijk", title), "title");
  assert.equal(matchVideoFile("downloads/abcdefghijk.webm", "abcdefghijk", title), "id");
  assert.equal(matchVideoFile("How To Get Ahead Of 99 Percent Of People In 6 12 Months.mkv", "abcdefghijk", title), "title");
  assert.equal(matchVideoFile("140239.mp4", "abcdefghijk", title), "none");
  assert.equal(matchVideoFile("random-clip.mp4", "abcdefghijk", title), "none");
  assert.equal(matchVideoFile("people.mp4", "abcdefghijk", title), "none");
  assert.equal(matchVideoFile("otherid12345.mp4", "abcdefghijk", title), "none");
});

test("local plays when a file is ready, unless this lesson was set to online", () => {
  assert.equal(resolvePlayback(undefined, true), "local");
  assert.equal(resolvePlayback(undefined, false), "pick");
  assert.equal(resolvePlayback("local", false), "pick");
  assert.equal(resolvePlayback("online", true), "online");
  assert.equal(resolvePlayback("local", true), "local");
});

test("the source choice is its own key and does not touch the reader store", () => {
  const reader = localStorage.getItem("musk-atlas:reader:v1");
  localStorage.setItem("musk-atlas:reader:v1", JSON.stringify({ version: 1, lessons: [], items: { oldword: { key: "oldword", text: "oldword", meaning: "旧词保留" } } }));
  saveChoice("abcdefghijk", "online");
  assert.equal(readChoice("abcdefghijk"), "online");
  assert.equal(readChoice("missing"), undefined);
  const saved = JSON.parse(localStorage.getItem("musk-atlas:reader:v1") || "{}");
  assert.equal(saved.items.oldword.meaning, "旧词保留");
  assert.equal(localStorage.getItem("musk-atlas:video-source:v1")?.includes("abcdefghijk"), true);
  if (reader == null) localStorage.removeItem("musk-atlas:reader:v1");
  else localStorage.setItem("musk-atlas:reader:v1", reader);
});

test("one chosen file is this lesson even if the name differs; several files only attach a real match", () => {
  const title = "How To Get Ahead Of 99% Of People (In 6-12 Months)";
  const one = explicitFiles("abcdefghijk", title, [new File(["x"], "notes.mp4", { type: "video/mp4" })]);
  assert.equal(one.file?.name, "notes.mp4");
  assert.equal(one.loose, true);
  const many = explicitFiles("abcdefghijk", title, [
    new File(["a"], "other-talk.mp4", { type: "video/mp4" }),
    new File(["b"], "How To Get Ahead Of 99% Of People (In 6-12 Months).mp4", { type: "video/mp4" }),
  ]);
  assert.equal(many.file?.name.includes("How To Get Ahead"), true);
  assert.equal(many.loose, false);
  const none = explicitFiles("abcdefghijk", title, [new File(["a"], "cat.mp4", { type: "video/mp4" }), new File(["b"], "dog.mp4", { type: "video/mp4" })]);
  assert.equal(none.file, null);
  assert.equal(none.unmatched, true);
});
