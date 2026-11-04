/** Floating word card for selections made outside the reader (Musk transcripts). */
import { useEffect, useRef } from "react";
import { reader, normalize, type Status } from "./model";
import { gsel, selText, useGSel } from "./select";
import { WordCard } from "./WordCard";

export function GlobalCard() {
  const sel = useGSel();
  const best = useRef("");
  const text = sel ? selText(sel) : "";
  const k = normalize(text);

  const setStatus = (s: Status) => {
    if (!sel || !k) return;
    const prev = reader.item(k);
    reader.upsert(text, { status: s, ...(s >= 1 && s <= 4 && !prev?.meaning && best.current ? { meaning: best.current } : {}) }, sel.ctx);
  };
  useEffect(() => {
    const off = () => gsel.clear();
    window.addEventListener("hashchange", off);
    return () => window.removeEventListener("hashchange", off);
  }, []);
  useEffect(() => {
    if (!sel) return;
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key;
      if (key === "Escape") gsel.clear();
      else if (key >= "1" && key <= "4") setStatus(Number(key) as Status);
      else if (key === "k") setStatus(5);
      else if (key === "x") setStatus(-1);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  });
  if (!sel || !k) return null;
  const extend = (d: 1 | -1) => {
    const list = d > 0 ? sel.toks.slice(sel.to + 1) : sel.toks.slice(0, sel.from).reverse();
    const w = list.find((t) => t.key);
    if (w) gsel.update(d > 0 ? { to: w.i } : { from: w.i });
  };
  const words = sel.toks.filter((t) => t.key);
  return (
    <aside className="rd-aside rd-float is-open" aria-label="词卡" data-testid="global-card">
      <WordCard
        key={k}
        text={text}
        k={k}
        ctx={sel.ctx}
        autoMusk={0}
        canExtend={{ left: sel.from > (words[0]?.i ?? 0), right: sel.to < (words[words.length - 1]?.i ?? 0) }}
        onExtend={extend}
        onPick={(r) => gsel.update(r)}
        onStatus={setStatus}
        onClose={gsel.clear}
        best={best}
        hideMusk
      />
    </aside>
  );
}
