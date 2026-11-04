import type { Meanings } from "./dict";

/** LingQ-style suggested meanings: tap to fill 释义. */
export function MeaningList({ m, active = -1, onPick, onLex }: { m: Meanings; active?: number; onPick: (t: string) => void; onLex?: () => void }) {
  if (m.failed)
    return <p className="rd-dim rd-mean-fail">释义来源都没有结果，可以自己写</p>;
  return (
    <ul className="rd-hints" data-testid="meanings">
      {m.senses.map((s, i) => (
        <li key={`${s.src}${i}`}>
          <button className={active === i ? "is-on" : ""} onClick={() => onPick(s.text)} data-testid="meaning-chip" data-src={s.src}>
            <span className="rd-hint-text">{s.text}</span>
            <em>
              {s.src}
              {s.of ? ` · ${s.of}` : ""}
            </em>
          </button>
        </li>
      ))}
      {m.loading && (
        <>
          <li className="rd-shimmer" aria-label="释义加载中" />
          <li className="rd-shimmer rd-shimmer-short" />
        </>
      )}
      {onLex && (
        <li>
          <button className="rd-link rd-lex" onClick={onLex}>
            Word Atlas 词条 ›
          </button>
        </li>
      )}
    </ul>
  );
}
