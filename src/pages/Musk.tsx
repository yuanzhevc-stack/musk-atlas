import { Bookmark, BookmarkCheck, Play, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { go } from "../lib/router";
import { candidates, clock, sentence, findSentence, loadManifest, materialize, type Candidates, type Hit, type Manifest } from "../musk/corpus";
import { ClipPlayer } from "../musk/ClipPlayer";
import { useVocab, vocab } from "../musk/vocab";
import { CorpusChip, KeepSentence } from "../reader/CorpusChip";
import { MuskText } from "../reader/MuskText";
import { gsel } from "../reader/select";

const PAGE = 60;
const SUGGEST = ["look at", "fundamental", "wow", "actually", "physics", "I think"];

interface Clip {
  hit: Hit;
  nonce: number;
}

export function SpeakerBadge({ m, p }: { m: Hit["sentence"]["m"]; p: number | null }) {
  if (!m) return null;
  const label = m === "musk" ? "已确认马斯克" : m === "uncertain" ? "不确定" : "非马斯克";
  return (
    <span className={`spk-badge spk-${m}`} data-testid="spk-badge" title={p == null ? undefined : `声纹相似度 ${p.toFixed(2)}`}>
      {label}
    </span>
  );
}

export function MuskPage({ q: initial = "", c }: { q?: string; c?: string }) {
  const [corpus, setCorpus] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState(initial);
  const [muskOnly, setMuskOnly] = useState(true);
  const [clip, setClip] = useState<Clip | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [res, setRes] = useState<{ cand: Candidates | null; hits: Hit[]; total: number; shown: number; hidden: number | null } | null>(null);
  const saved = useVocab();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadManifest().then(setCorpus, (e: Error) => setError(e.message));
    if (!c) input.current?.focus();
  }, []);

  // Deep link from the corpus (#/?q=..&c=<sentence id>): open that exact clip.
  useEffect(() => {
    const id = Number(c);
    if (!corpus || !c || !Number.isFinite(id)) return;
    sentence(id).then(
      (s) => {
        const i = initial ? s.t.toLowerCase().indexOf(initial.toLowerCase()) : -1;
        setClip({ hit: { id: `c:${id}`, sentence: s, video: corpus.videos[s.v], start: s.s, end: s.e, from: Math.max(0, i), to: i < 0 ? 0 : i + initial.length }, nonce: Date.now() });
      },
      () => null,
    );
  }, [corpus, c]);

  // Keep the query in the hash so a search can be bookmarked.
  useEffect(() => {
    const t = setTimeout(() => go({ page: "musk", q: q.trim() || undefined }, null, true), 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => setLimit(PAGE), [q, muskOnly]);
  // Sharded search: postings first, then only the sentence chunks needed for the shown hits.
  useEffect(() => {
    const query = q.trim();
    if (!corpus || !query) {
      setRes(null);
      return;
    }
    let live = true;
    const t = setTimeout(async () => {
      try {
        const cand = await candidates(query);
        const ids = cand ? (muskOnly ? cand.m : [...cand.m, ...cand.u, ...cand.n]) : [];
        const hits = cand ? await materialize(cand.lemmas, ids.slice(0, limit)) : [];
        let hidden: number | null = null;
        if (cand && muskOnly) {
          const rest = [...cand.u, ...cand.n];
          hidden = rest.length <= 120 ? (await materialize(cand.lemmas, rest)).length : null;
        }
        if (live) setRes({ cand, hits, total: ids.length, shown: Math.min(limit, ids.length), hidden });
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [corpus, q, muskOnly, limit]);

  const hasSpeaker = !!corpus && (corpus.labels.musk ?? 0) > 0;
  const hits = res?.hits ?? [];
  const more = !!res && res.total > res.shown;
  const hidden = res?.hidden ?? 0;
  const videoCount = new Set(hits.map((h) => h.sentence.v)).size;

  const play = (h: Hit) => setClip({ hit: h, nonce: Date.now() });
  const index = clip ? hits.findIndex((h) => h.id === clip.hit.id) : -1;

  // playphrase-style keys: ↓/↑ next/prev (auto-play), Enter/Space replay.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || gsel.get()) return;
      const typing = (e.target as HTMLElement).tagName === "INPUT" && (e.target as HTMLInputElement).type !== "checkbox";
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!hits.length) return;
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        const next = hits[Math.min(hits.length - 1, Math.max(0, index < 0 ? 0 : index + d))];
        play(next);
        document.querySelector(`[data-hit="${next.id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      } else if (e.key === "Enter" || (e.key === " " && !typing)) {
        if (!hits.length) return;
        e.preventDefault();
        play(clip && index >= 0 ? clip.hit : hits[0]);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  return (
    <div className="page musk-page">
      <header className="musk-hero">
        <p className="eyebrow">Musk Corpus · {corpus ? `${Object.keys(corpus.videos).length} 个视频 · ${corpus.n.toLocaleString()} 句` : "加载中"}</p>
        <h1 className="display">他怎么说这个词？</h1>
        <label className="musk-search">
          <Search size={20} />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="输入单词或短语，如 look at"
            aria-label="搜索单词或短语"
            spellCheck={false}
            autoCapitalize="off"
          />
          {q && (
            <button className="icon-btn" onClick={() => setQ("")} aria-label="清空">
              <X size={18} />
            </button>
          )}
        </label>
        <div className="musk-meta">
          {!q.trim() ? (
            <div className="chips">
              {SUGGEST.map((s) => (
                <button key={s} className="chip" onClick={() => setQ(s)}>
                  {s}
                </button>
              ))}
            </div>
          ) : (
            <span className="musk-count" data-testid="hit-count">
              {hits.length}
              {more ? "+" : ""} 处 · {videoCount} 个视频
              {muskOnly && hidden > 0 && <span className="musk-hidden"> · 另有 {hidden} 处未确认/非马斯克已隐藏</span>}
            </span>
          )}
          {q.trim() && (
            <CorpusChip q={q} hit={clip?.hit ?? hits[0]} />
          )}
          {hasSpeaker && (
            <label className="musk-toggle" title="按声纹验证：只显示确认是马斯克本人说的句子；关闭后显示全部（含不确定）">
              <input type="checkbox" checked={muskOnly} onChange={(e) => setMuskOnly(e.target.checked)} />
              <span>只看 Musk</span>
            </label>
          )}
        </div>
      </header>

      {error && <p className="sheet-error">{error}</p>}

      <div className={`musk-layout ${clip ? "has-clip" : ""}`}>
        <ol className="musk-hits">
          {hits.slice(0, 300).map((h) => {
            const id = `${h.sentence.v}@${h.start}`;
            const on = clip?.hit.id === h.id;
            const isSaved = saved.some((x) => x.id === id);
            return (
              <li key={h.id} data-hit={h.id} className={`musk-hit ${on ? "is-on" : ""} ${h.sentence.c ? "" : "no-clip"}`}>
                <button className="musk-hit-main" onClick={() => play(h)} data-testid="hit">
                  <span className="musk-play">
                    <Play size={14} fill="currentColor" />
                  </span>
                  <span className="musk-hit-body">
                    <span className="musk-sentence">
                      <MuskText sentence={h.sentence} title={h.video.title} place="hit" from={h.from} to={h.to} />
                    </span>
                    <span className="musk-source">
                      {h.video.title} · {clock(h.start)}
                      <SpeakerBadge m={h.sentence.m} p={h.sentence.p} />
                    </span>
                  </span>
                </button>
                <span className="musk-hit-acts">
                <button
                  className="icon-btn"
                  aria-label={isSaved ? "移出语料本" : "加入语料本"}
                  title={isSaved ? "移出语料本" : "加入语料本"}
                  onClick={() =>
                    vocab.toggle({ id, phrase: h.sentence.t.slice(h.from, h.to), videoId: h.sentence.v, title: h.video.title, start: h.start, end: h.end, sentence: h.sentence.t, added: Date.now() })
                  }
                >
                  {isSaved ? <BookmarkCheck size={18} /> : <Bookmark size={18} />}
                </button>
                <KeepSentence hit={h} />
                </span>
              </li>
            );
          })}
          {more && (
            <li className="musk-more">
              <button className="chip" onClick={() => setLimit((l) => l + PAGE)}>
                显示更多
              </button>
            </li>
          )}
          {q.trim() && corpus && res && !hits.length && <li className="musk-empty">语料里还没有 Musk 说过「{q.trim()}」。</li>}
        </ol>

        {clip && (
          <aside className="musk-stage" aria-label="播放器">
            <ClipPlayer sentence={clip.hit.sentence} from={clip.hit.from} to={clip.hit.to} nonce={clip.nonce} title={clip.hit.video.title} />
            <p className="musk-source">
              {index >= 0 && `${index + 1} / ${hits.length} · `}
              {clip.hit.video.title} · {clock(clip.hit.start)}
              <SpeakerBadge m={clip.hit.sentence.m} p={clip.hit.sentence.p} /> ·{" "}
              <a href={`https://youtu.be/${clip.hit.sentence.v}?t=${Math.max(0, Math.floor(clip.hit.start - 1))}`} target="_blank" rel="noreferrer">
                在 YouTube 打开
              </a>
            </p>
            <p className="musk-keys">↑ ↓ 上一句 / 下一句 · Enter 重播</p>
          </aside>
        )}
      </div>

      {saved.length > 0 && (
        <section className="musk-saved">
          <h2>我的语料本 · {saved.length}</h2>
          <ul>
            {saved.map((s) => (
              <li key={s.id}>
                <button className="musk-hit-main" onClick={async () => {
                    const si = await findSentence(s.videoId, s.start);
                    if (!si || !corpus) return;
                    const i = si.t.indexOf(s.phrase);
                    setClip({ hit: { id: `saved:${s.id}`, sentence: si, video: corpus.videos[si.v], start: s.start, end: s.end, from: Math.max(0, i), to: i < 0 ? 0 : i + s.phrase.length }, nonce: Date.now() });
                  }}>
                  <span className="musk-play">
                    <Play size={14} fill="currentColor" />
                  </span>
                  <span className="musk-hit-body">
                    <b>{s.phrase}</b>
                    <span className="musk-sentence">{s.sentence}</span>
                    <span className="musk-source">
                      {s.title} · {clock(s.start)}
                    </span>
                  </span>
                </button>
                <button className="icon-btn" onClick={() => vocab.remove(s.id)} aria-label="删除">
                  <X size={16} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
