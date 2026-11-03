/** Personal Musk phrasebook, kept in localStorage. */
import { useSyncExternalStore } from "react";

export interface Saved {
  id: string;
  phrase: string;
  videoId: string;
  title: string;
  start: number;
  end: number;
  sentence: string;
  added: number;
}
const KEY = "musk-atlas:vocab:v1";
const subs = new Set<() => void>();
let items: Saved[] = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]") as Saved[];
  } catch {
    return [];
  }
})();
function commit(next: Saved[]) {
  items = next;
  localStorage.setItem(KEY, JSON.stringify(items));
  subs.forEach((f) => f());
}
export const vocab = {
  has: (id: string) => items.some((x) => x.id === id),
  toggle(item: Saved) {
    commit(this.has(item.id) ? items.filter((x) => x.id !== item.id) : [item, ...items]);
  },
  remove: (id: string) => commit(items.filter((x) => x.id !== id)),
};
export const useVocab = () =>
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => items,
  );
