import assert from "node:assert/strict";
import test from "node:test";
import { deskRows, type LessonRow } from "./libraryViews";
import type { Item, Lesson } from "./model";

const lessons: Lesson[] = [
  { id: "a", title: "Dan Koe", text: "hello world again", created: 10, opened: 50, yt: { v: "aaaaaaaaaaa", times: [0], kind: "manual", author: "Dan" } },
  { id: "b", title: "Notes", text: "alpha beta", created: 30, opened: 0 },
  { id: "c", title: "Space", text: "hello room", created: 20, opened: 40 },
];

const items: Record<string, Item> = {
  hello: { key: "hello", text: "hello", kind: "word", status: 5, meaning: "", notes: "", created: 1, updated: 1 },
  world: { key: "world", text: "world", kind: "word", status: 5, meaning: "", notes: "", created: 1, updated: 1 },
  again: { key: "again", text: "again", kind: "word", status: 5, meaning: "", notes: "", created: 1, updated: 1 },
  room: { key: "room", text: "room", kind: "word", status: 1, meaning: "", notes: "", created: 1, updated: 1 },
};

test("desk filters by kind and title, then sorts", () => {
  const videos = deskRows(lessons, items, { q: "", kind: "video", lane: "all", author: "", sort: "title" });
  assert.deepEqual(videos.map((row) => row.id), ["a"]);
  const named = deskRows(lessons, items, { q: "space", kind: "all", lane: "all", author: "", sort: "created" });
  assert.deepEqual(named.map((row) => row.id), ["c"]);
  const newest = deskRows(lessons, items, { q: "", kind: "all", lane: "all", author: "", sort: "created" });
  assert.deepEqual(newest.map((row) => row.id), ["b", "c", "a"]);
});

test("known lessons land in the familiar lane", () => {
  const rows = deskRows(lessons, items, { q: "", kind: "all", lane: "known", author: "", sort: "known" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, "a");
  assert.equal(rows[0]?.known, 100);
  const going = deskRows(lessons, {}, { q: "", kind: "text", lane: "fresh", author: "", sort: "title" }).map((row: LessonRow) => row.id);
  assert.deepEqual(going, ["b"]);
});

test("videos filter and sort by youtuber", () => {
  const more: Lesson[] = [
    ...lessons,
    { id: "d", title: "B talk", text: "one two", created: 5, opened: 5, yt: { v: "bbbbbbbbbbb", times: [0], kind: "asr", author: "Naval" } },
    { id: "e", title: "A talk", text: "one two", created: 6, opened: 6, yt: { v: "ccccccccccc", times: [0], kind: "asr", author: "Naval Ravikant" } },
  ];
  const naval = deskRows(more, items, { q: "", kind: "all", lane: "all", author: "Naval", sort: "opened" });
  assert.deepEqual(naval.map((row) => row.id), ["d"]);
  const ordered = deskRows(more, items, { q: "", kind: "all", lane: "all", author: "", sort: "author" });
  assert.deepEqual(ordered.map((row) => row.id), ["a", "d", "e", "b", "c"]);
});
