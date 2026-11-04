/** Musk transcript sentence as interactive LingQ-style text: tap a word / drag (or ⇧-click) a phrase -> global word card. */
import { useEffect, useMemo, useRef } from "react";
import type { Sentence } from "../musk/corpus";
import { normalize, useReader, type Context, type Item } from "./model";
import { gsel, useGSel, type Tok } from "./select";

const cls = (it?: Item) => (!it ? "s-new" : it.status === 5 ? "s-known" : it.status === -1 ? "s-ign" : `s-${it.status}`);

export function muskContext(s: Sentence, title: string): Context {
  const ms = s.c ? Number(s.c.match(/\/(\d+)\.mp4$/)?.[1]) : NaN;
  return { lesson: "musk", title, sid: s.id, sentence: s.t, musk: { v: s.v, t: s.s, ...(Number.isFinite(ms) ? { ms } : {}) } };
}

export function MuskText({
  sentence,
  title,
  place,
  from = -1,
  to = -1,
  now,
}: {
  sentence: Sentence;
  title: string;
  /** Distinguishes several renderings of the same sentence (stage vs row). */
  place: string;
  /** Character range to highlight as the search hit. */
  from?: number;
  to?: number;
  /** Absolute media time for karaoke highlighting. */
  now?: number;
}) {
  const st = useReader();
  const sel = useGSel();
  const owner = `${place}:${sentence.id}`;
  const drag = useRef<{ start: number; moved: boolean } | null>(null);
  const dragEnd = useRef(0);
  useEffect(() => {
    const up = () => {
      if (drag.current?.moved) dragEnd.current = Date.now();
      setTimeout(() => (drag.current = null), 0);
    };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);
  const { toks, times } = useMemo(() => {
    const text = sentence.t;
    const toks: Tok[] = [];
    const times: ([number, number] | null)[] = [];
    let last = 0;
    for (const [, ws, we, a, b] of sentence.w) {
      if (a < last) continue;
      if (a > last) {
        toks.push({ i: toks.length, text: text.slice(last, a) });
        times.push(null);
      }
      toks.push({ i: toks.length, text: text.slice(a, b), key: normalize(text.slice(a, b)) });
      times.push([ws, we]);
      last = b;
    }
    if (last < text.length) {
      toks.push({ i: toks.length, text: text.slice(last) });
      times.push(null);
    }
    return { toks, times };
  }, [sentence]);
  const ctx = () => muskContext(sentence, title);
  const mine = sel && sel.owner === owner ? sel : null;
  let pos = 0;
  return (
    <span
      className="mt"
      data-testid="musk-text"
      onClick={(e) => {
        // A drag across words ends with a click on this common ancestor; never let it reach the row's play.
        if (drag.current?.moved || Date.now() - dragEnd.current < 400) {
          e.stopPropagation();
          e.preventDefault();
        }
      }}
    >
      {toks.map((t, i) => {
        const a = pos;
        pos += t.text.length;
        const hit = from >= 0 && a >= from && pos <= to;
        const inSel = !!mine && i >= mine.from && i <= mine.to;
        if (!t.key) return <span key={i} className={`${hit && a > from ? "w-hit" : ""}${inSel ? " in-sel" : ""}`}>{t.text}</span>;
        const tm = times[i];
        const live = now != null && tm && now >= tm[0] && now < Math.max(tm[1], tm[0] + 0.15);
        return (
          <span
            key={i}
            data-testid="mt-tok"
            className={`mw ${cls(st.items[t.key])}${hit ? " w-hit" : ""}${live ? " w-live" : ""}${inSel ? " in-sel" : ""}${mine && mine.from === i && mine.to === i ? " sel-one" : ""}`}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (e.pointerType === "mouse" && e.button === 0 && !e.shiftKey) drag.current = { start: i, moved: false };
            }}
            onPointerEnter={() => {
              const d = drag.current;
              if (!d || i === d.start) return;
              d.moved = true;
              gsel.range(owner, toks, d.start, i, ctx());
            }}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              if (drag.current?.moved) return;
              gsel.pick(owner, toks, i, ctx(), e.shiftKey);
            }}
          >
            {t.text}
          </span>
        );
      })}
    </span>
  );
}
