/** Global word/phrase selection for text outside the reader (Musk transcript lines). One card at a time. */
import { useSyncExternalStore } from "react";
import type { Context } from "./model";

export interface Tok {
  i: number;
  text: string;
  key?: string;
}
export interface GSel {
  owner: string;
  toks: Tok[];
  from: number;
  to: number;
  anchor: number;
  ctx: Context;
}
let cur: GSel | null = null;
const subs = new Set<() => void>();
const set = (v: GSel | null) => {
  cur = v;
  subs.forEach((f) => f());
};
export const gsel = {
  get: () => cur,
  pick(owner: string, toks: Tok[], i: number, ctx: Context, extend = false) {
    if (extend && cur && cur.owner === owner) set({ ...cur, from: Math.min(cur.anchor, i), to: Math.max(cur.anchor, i) });
    else set({ owner, toks, from: i, to: i, anchor: i, ctx });
  },
  range(owner: string, toks: Tok[], a: number, b: number, ctx: Context) {
    set({ owner, toks, from: Math.min(a, b), to: Math.max(a, b), anchor: a, ctx });
  },
  update: (patch: Partial<GSel>) => cur && set({ ...cur, ...patch }),
  clear: () => set(null),
};
export const useGSel = () =>
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => cur,
  );
export const selText = (s: GSel) =>
  s.toks
    .slice(s.from, s.to + 1)
    .map((t) => t.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
