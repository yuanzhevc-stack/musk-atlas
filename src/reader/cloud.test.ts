import assert from "node:assert/strict";
import test from "node:test";
import { mergeCloud, type CloudLibrary } from "./cloud";

test("a second device keeps both lessons and the newer sentence", () => {
  const server: CloudLibrary = {
    rev: 3,
    lessons: [{ id: "a", title: "A", text: "one", created: 1, opened: 10, sid: 1 }],
    items: { hello: { key: "hello", text: "hello", kind: "word", status: 1, meaning: "", notes: "", created: 1, updated: 5 } },
    notes: { "a:0": "server" },
    progress: { version: 2, cards: { w1: { reps: 2, seen: 1 } }, days: {}, bookmarks: [] },
  };
  const local = {
    lessons: [
      { id: "a", title: "A", text: "one", created: 1, opened: 20, sid: 4 },
      { id: "b", title: "B", text: "two", created: 2, opened: 3 },
    ],
    items: { hello: { key: "hello", text: "hello", kind: "word" as const, status: 2 as const, meaning: "", notes: "", created: 1, updated: 9 } },
    notes: { "b:1": "local" },
    progress: { version: 2, cards: { w2: { reps: 1, seen: 2 } }, days: {}, bookmarks: ["w2"] },
  };
  const merged = mergeCloud(server, local);
  assert.equal(merged.lessons.find((l) => l.id === "a")?.sid, 4);
  assert.equal(merged.lessons.some((l) => l.id === "b"), true);
  assert.equal(merged.items.hello.status, 2);
  assert.equal(merged.notes["a:0"], "server");
  assert.equal(merged.notes["b:1"], "local");
  const cards = (merged.progress as { cards: Record<string, unknown> }).cards;
  assert.equal("w1" in cards && "w2" in cards, true);
});
