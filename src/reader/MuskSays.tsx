/** "Musk 怎么说": look a corpus key up in the sharded Musk index and play the clips (R2) with the shared ClipPlayer. */
import { Play } from "lucide-react";
import { useEffect, useState } from "react";
import { candidates, clock, materialize, type Hit } from "../musk/corpus";
import { ClipPlayer } from "../musk/ClipPlayer";
import { MuskText } from "./MuskText";

export interface MuskResult {
  hits: Hit[];
  /** Total verified-Musk matches (sentence level) and all matches. */
  musk: number;
  all: number;
}
const memo = new Map<string, Promise<MuskResult>>();
export function muskLookup(key: string, limit = 6): Promise<MuskResult> {
  const id = `${key}|${limit}`;
  if (!memo.has(id))
    memo.set(
      id,
      (async () => {
        const cand = await candidates(key);
        if (!cand) return { hits: [], musk: 0, all: 0 };
        // Verified Musk first; fall back to uncertain if nothing verified (never not_musk).
        const ids = cand.m.length ? cand.m : cand.u;
        const hits = (await materialize(cand.lemmas, ids.slice(0, limit * 2))).filter((h) => h.sentence.c).slice(0, limit);
        return { hits, musk: cand.m.length, all: cand.m.length + cand.u.length + cand.n.length };
      })().catch((e) => {
        memo.delete(id);
        throw e;
      }),
    );
  return memo.get(id)!;
}

export function MuskSays({ q, autoplay = false, compact = false }: { q: string; autoplay?: boolean; compact?: boolean }) {
  const [res, setRes] = useState<MuskResult | null>(null);
  const [err, setErr] = useState(false);
  const [on, setOn] = useState<{ hit: Hit; nonce: number } | null>(null);
  useEffect(() => {
    let live = true;
    setRes(null);
    setOn(null);
    setErr(false);
    muskLookup(q).then(
      (r) => {
        if (!live) return;
        setRes(r);
        if (autoplay && r.hits[0]) setOn({ hit: r.hits[0], nonce: Date.now() });
      },
      () => live && setErr(true),
    );
    return () => {
      live = false;
    };
  }, [q, autoplay]);

  return (
    <section className={`rd-musk ${compact ? "is-compact" : ""}`} data-testid="musk-says">
      <header>
        <h4>Musk 怎么说</h4>
        {res && (
          <a href={`#/?q=${encodeURIComponent(q)}`} className="rd-link">
            {res.musk ? `${res.musk} 句` : res.all ? "未确认" : ""} 全部 ›
          </a>
        )}
      </header>
      {err ? (
        <p className="rd-dim">语料加载失败</p>
      ) : !res ? (
        <p className="rd-dim">查找中…</p>
      ) : !res.hits.length ? (
        <p className="rd-dim">语料里还没有他说过这个</p>
      ) : (
        <>
          {on && (
            <div className="rd-musk-stage">
              <ClipPlayer sentence={on.hit.sentence} from={on.hit.from} to={on.hit.to} nonce={on.nonce} title={on.hit.video.title} />
            </div>
          )}
          <ol className="rd-musk-list">
            {res.hits.map((h) => (
              <li key={h.id}>
                <button className={on?.hit.id === h.id ? "is-on" : ""} onClick={() => setOn({ hit: h, nonce: Date.now() })} data-testid="musk-hit">
                  <span className="rd-play">
                    <Play size={11} fill="currentColor" />
                  </span>
                  <span className="rd-musk-text">
                    <MuskText sentence={h.sentence} title={h.video?.title ?? h.sentence.v} place="says" from={h.from} to={h.to} />
                    <small>
                      {h.video?.title ?? h.sentence.v} · {clock(h.sentence.s)}
                      {h.sentence.m === "uncertain" ? " · 未确认" : ""}
                    </small>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
