/** Sentence notes for the lesson desk. Separate from the reader corpus so a note does not create a word. */

const KEY = "musk-atlas:lesson-notes:v1";

type Store = { version: 1; notes: Record<string, string> };

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { version: 1, notes: {} };
    const parsed = JSON.parse(raw) as Store;
    if (parsed?.version !== 1 || typeof parsed.notes !== "object" || !parsed.notes) return { version: 1, notes: {} };
    return parsed;
  } catch {
    return { version: 1, notes: {} };
  }
}

const idOf = (lessonId: string, sid: number) => `${lessonId}:${sid}`;
let afterNote: (() => void) | null = null;

export function onNotesCommit(fn: (() => void) | null) {
  afterNote = fn;
}

export function allNotes(): Record<string, string> {
  return { ...read().notes };
}

export function replaceNotes(notes: Record<string, string>) {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(notes)) if (typeof v === "string" && v.trim()) clean[k] = v.slice(0, 2000);
  try {
    localStorage.setItem(KEY, JSON.stringify({ version: 1, notes: clean }));
  } catch {
    /* keep the previous notes */
  }
}

export function readNote(lessonId: string, sid: number): string {
  const text = read().notes[idOf(lessonId, sid)];
  return typeof text === "string" ? text : "";
}

export function writeNote(lessonId: string, sid: number, text: string) {
  const store = read();
  const id = idOf(lessonId, sid);
  const next = text.trim();
  if (next) store.notes[id] = next.slice(0, 2000);
  else delete store.notes[id];
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* the note stays in the field until the next successful write */
  }
  afterNote?.();
}
