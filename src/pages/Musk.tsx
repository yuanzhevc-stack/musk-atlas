import { Bookmark, BookmarkCheck, Play, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { go } from "../lib/router";
import { clock, loadCorpus, search, type Corpus, type Hit } from "../musk/corpus";
import { ClipPlayer } from "../musk/ClipPlayer";
import { useVocab, vocab } from "../musk/vocab";

const SUGGEST = ["look at", "fundamental", "wow", "actually", "physics", "I think"];

interface Clip {
  hit: Hit;
  nonce: number;
}

function Highlight({ text, from, to }: { text: string; from: number; to: number }) {
  return (
    <>
      {text.slice(0, from)}
      <mark>{text.slice(from, to)}</mark>
      {text.slice(to)}
    </>
  );
}

export function MuskPage({ q: initial = "" }: { q?: string }) {
  const [corpus, setCorpus] = useState<Corpus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState(initial);
  const [muskOnly, setMuskOnly] = useState(false);
  const [clip, setClip] = useState<Clip | null>(null);
  const saved = useVocab();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadCorpus().then(setCorpus, (e: Error) => setError(e.message));
    input.current?.focus();
  }, []);

  // Keep the query in the hash so a search can be bookmarked.
  useEffect(() => {
    const t = setTimeout(() => go({ page: "musk", q: q.trim() || undefined }, null, true), 250);
    return () => clearTimeout(t);
  }, [q]);

  const hasSpeaker = !!corpus && Object.values(corpus.videos).some((v) => v.speaker);
  const all = useMemo(() => (corpus && q.trim() ? search(corpus, q) : []), [corpus, q]);
  const hits = muskOnly ? all.filter((h) => h.sentence.k !== "host") : all;
  const videoCount = new Set(hits.map((h) => h.sentence.v)).size;

  const play = (h: Hit) => setClip({ hit: h, nonce: Date.now() });
  const index = clip ? hits.findIndex((h) => h.id === clip.hit.id) : -1;

  // playphrase-style keys: ↓/↑ next/prev (auto-play), Enter/Space replay.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
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
        <p className="eyebrow">Musk Corpus · {corpus ? `${Object.keys(corpus.videos).length} 个视频 · ${corpus.sentences.length.toLocaleString()} 句` : "加载中"}</p>
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
              {hits.length} 处 · {videoCount} 个视频
            </span>
          )}
          {hasSpeaker && (
            <label className="musk-toggle" title="仅部分视频有说话人标注；未标注的句子会保留">
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
                      <Highlight text={h.sentence.t} from={h.from} to={h.to} />
                    </span>
                    <span className="musk-source">
                      {h.video.title} · {clock(h.start)}
                      {h.sentence.k === "host" && <em> · 主持人</em>}
                    </span>
                  </span>
                </button>
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
              </li>
            );
          })}
          {q.trim() && corpus && !hits.length && <li className="musk-empty">语料里还没有 Musk 说过「{q.trim()}」。</li>}
        </ol>

        {clip && (
          <aside className="musk-stage" aria-label="播放器">
            <ClipPlayer sentence={clip.hit.sentence} from={clip.hit.from} to={clip.hit.to} nonce={clip.nonce} />
            <p className="musk-source">
              {index >= 0 && `${index + 1} / ${hits.length} · `}
              {clip.hit.video.title} · {clock(clip.hit.start)} ·{" "}
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
                <button className="musk-hit-main" onClick={() => {
                    const si = corpus?.sentences.find((x) => x.v === s.videoId && x.t === s.sentence);
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
