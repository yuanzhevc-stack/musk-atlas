/** Lesson ids the account has deleted. Stored in the synced notes so another device does not merge them back. */
import { allNotes, replaceNotes } from "./lessonNotes";
import { reader } from "./model";

export const GONE_KEY = "__gone";
const ID = /^[A-Za-z0-9_-]{4,32}$/;

export function goneSet(notes: Record<string, string> | undefined): Set<string> {
  const raw = notes?.[GONE_KEY] ?? "";
  return new Set(raw.split(",").map((id) => id.trim()).filter((id) => ID.test(id)));
}

/** Newest ids stay when the note would exceed the account field limit. */
export function withGone(notes: Record<string, string>, ids: Iterable<string>): Record<string, string> {
  const set = goneSet(notes);
  for (const id of ids) if (ID.test(id)) set.add(id);
  const next = { ...notes };
  delete next[GONE_KEY];
  let list = [...set];
  let packed = list.join(",");
  while (packed.length > 1900 && list.length > 1) {
    list = list.slice(1);
    packed = list.join(",");
  }
  if (packed) next[GONE_KEY] = packed;
  return next;
}

export function forgetLesson(id: string) {
  replaceNotes(withGone(allNotes(), [id]));
  reader.removeLesson(id);
}
