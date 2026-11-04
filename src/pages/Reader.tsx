import { ArrowLeft, BookOpen, Check, ChevronLeft, ChevronRight, ExternalLink, Pause, Play, Plus, Trash2 } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { go } from "../lib/router";
import { speak } from "../reader/dict";
import { muskLookup } from "../reader/MuskSays";
import { prefetch, RATES, tts, useTts } from "../reader/tts";
import { StatusPicker, WordCard, type Sel } from "../reader/WordCard";
export { StatusPicker };
import { lessonStats, normalize, parse, phraseIndex, reader, useReader, type Context, type Item, type Lesson, type Status, type Token } from "../reader/model";
import { gsel } from "../reader/select";
import { Sheet } from "../ui/Sheet";
import { toast } from "../ui/Toast";

const SAMPLE = {
  title: "示例 · 关于第一性原理",
  text: `I think it's important to reason from first principles rather than by analogy. The normal way we conduct our lives is we reason by analogy. We are doing this because it's like something else that was done, or it is like what other people are doing.

With first principles, you boil things down to the most fundamental truths you can imagine, and then you reason up from there. Look at the materials a rocket is made of: aluminum, titanium, copper, carbon fiber. What is the value of those materials on the commodity market? It turned out that the materials cost was only around two percent of the typical price.

So the question is: why is it so expensive? It's not that people are stupid. It's just that the industry got stuck doing things the way they had always been done. If you want to make a big change, you have to actually look at the problem and figure out what's true.`,
};

export function ToolTabs({ on }: { on: "reader" | "corpus" }) {
  return (
    <div className="rd-tabs" role="tablist">
      <a href="#/reader" className={on === "reader" ? "is-on" : ""} role="tab" aria-selected={on === "reader"}>
        课程
      </a>
      <a href="#/corpus" className={on === "corpus" ? "is-on" : ""} role="tab" aria-selected={on === "corpus"}>
        语料库
      </a>
    </div>
  );
}

export function ReaderPage({ l, s }: { l?: string; s?: string }) {
  const st = useReader();
  const lesson = l ? st.lessons.find((x) => x.id === l) : undefined;
  if (l && lesson) return <LessonView key={lesson.id} lesson={lesson} focusSid={s ? Number(s) : undefined} />;
  return <Library missing={!!l} />;
}

/* ---------- library ---------- */

function Library({ missing }: { missing: boolean }) {
  const st = useReader();
  const [importing, setImporting] = useState(false);
  return (
    <div className="page rd-page">
      <header className="rd-head">
        <div>
          <p className="rd-eyebrow">阅读</p>
          <h1 className="rd-title">课程</h1>
        </div>
        <ToolTabs on="reader" />
      </header>
      {missing && <p className="rd-dim">这节课不在这台设备上（数据存在本机浏览器）。</p>}
      <div className="rd-lib">
        <button className="rd-card rd-card-new" onClick={() => setImporting(true)} data-testid="import-open">
          <Plus size={22} />
          <b>导入课程</b>
          <span>粘贴一段英文</span>
        </button>
        {st.lessons.map((ls) => {
          const k = lessonStats(ls.text, st.items);
          const known = k.unique ? Math.round(((k.unique - k.blue - k.learning) / k.unique) * 100) : 0;
          return (
            <a key={ls.id} href={`#/reader?l=${ls.id}`} className="rd-card" data-testid="lesson-card">
              <b>{ls.title}</b>
              <span className="rd-card-meta">
                {k.unique} 词 · <i className="dot dot-blue" />
                {k.blue} · <i className="dot dot-yellow" />
                {k.learning}
              </span>
              <span className="rd-bar">
                <span style={{ width: `${known}%` }} />
              </span>
              <span className="rd-card-foot">
                {known}% 已知
                {ls.url && <ExternalLink size={12} />}
              </span>
            </a>
          );
        })}
        {!st.lessons.length && (
          <button
            className="rd-card rd-card-ghost"
            onClick={() => {
              const ls = reader.addLesson(SAMPLE);
              go({ page: "reader", l: ls.id });
            }}
          >
            <BookOpen size={20} />
            <b>试试示例</b>
            <span>一段关于第一性原理的短文</span>
          </button>
        )}
      </div>
      <ImportSheet open={importing} onClose={() => setImporting(false)} />
    </div>
  );
}

function ImportSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const ok = text.trim().length > 0;
  const submit = () => {
    if (!ok) return;
    const firstLine = text.trim().split("\n")[0].slice(0, 48);
    const ls = reader.addLesson({ title: title.trim() || firstLine, url: url.trim() || undefined, text: text.trim() });
    setTitle("");
    setUrl("");
    setText("");
    onClose();
    go({ page: "reader", l: ls.id });
  };
  return (
    <Sheet open={open} onClose={onClose} label="导入课程" className="rd-sheet">
      <h2 className="rd-sheet-title">导入课程</h2>
      <div className="rd-form">
        <label>
          <span>标题</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="可留空" data-testid="import-title" />
        </label>
        <label>
          <span>来源链接</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://（可选）" inputMode="url" autoCapitalize="off" />
        </label>
        <label>
          <span>正文</span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="粘贴英文文本…" rows={9} data-testid="import-text" />
        </label>
        <button className="rd-btn rd-btn-primary" disabled={!ok} onClick={submit} data-testid="import-save">
          开始阅读
        </button>
      </div>
    </Sheet>
  );
}

/* ---------- lesson ---------- */

const isWord = (t: Token) => !!t.key;
const statusClass = (it?: Item) => (!it ? "s-new" : it.status === 5 ? "s-known" : it.status === -1 ? "s-ign" : `s-${it.status}`);

function LessonView({ lesson, focusSid }: { lesson: Lesson; focusSid?: number }) {
  const st = useReader();
  const doc = useMemo(() => parse(lesson.text), [lesson.text]);
  const startPage = useMemo(() => {
    if (focusSid == null) return Math.min(lesson.page ?? 0, doc.pages.length - 1);
    const pi = doc.paragraphs.findIndex((p) => p.tokens.some((t) => t.sid === focusSid));
    return Math.max(0, doc.pages.findIndex((pg) => pi >= pg.from && pi < pg.to));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [page, setPage] = useState(Math.max(0, startPage));
  const [sel, setSel] = useState<Sel | null>(null);
  const [flash, setFlash] = useState<number | undefined>(focusSid);
  const [size, setSize] = useState(() => Number(localStorage.getItem("musk-atlas:reader:size")) || 21);
  const [autoMusk, setAutoMusk] = useState(0);
  const anchor = useRef<number | null>(null);
  const drag = useRef<{ start: number; moved: boolean } | null>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const best = useRef("");
  const tt = useTts();

  const pg = doc.pages[page] ?? { from: 0, to: 0, words: 0 };
  const paras = doc.paragraphs.slice(pg.from, pg.to);
  const tokens = useMemo(() => paras.flatMap((p) => p.tokens), [paras]);
  const all = useMemo(() => doc.paragraphs.flatMap((p) => p.tokens), [doc]);

  useEffect(() => reader.updateLesson(lesson.id, { page, opened: Date.now() }), [page, lesson.id]);
  useEffect(() => localStorage.setItem("musk-atlas:reader:size", String(size)), [size]);
  useEffect(() => {
    if (flash == null) return;
    requestAnimationFrame(() => document.querySelector(`[data-sid="${flash}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
    const t = setTimeout(() => setFlash(undefined), 2400);
    return () => clearTimeout(t);
  }, [flash]);

  // Saved phrases found in this page's text: token index -> phrase range.
  const phraseAt = useMemo(() => {
    const idx = phraseIndex(st.items);
    const map = new Map<number, { from: number; to: number; key: string }>();
    if (!idx.size) return map;
    const words = tokens.filter(isWord);
    words.forEach((t, j) => {
      for (const ws of idx.get(t.key!) ?? []) {
        if (j + ws.length > words.length) continue;
        if (!ws.every((w, k) => words[j + k].key === w && words[j + k].sid === t.sid)) continue;
        const r = { from: t.i, to: words[j + ws.length - 1].i, key: ws.join(" ") };
        for (let i = r.from; i <= r.to; i++) if (!map.has(i) || map.get(i)!.key.length < r.key.length) map.set(i, r);
      }
    });
    return map;
  }, [tokens, st.items]);

  const selText = sel ? all.slice(sel.from, sel.to + 1).map((t) => t.text).join("").replace(/\s+/g, " ").trim() : "";
  const selKey = normalize(selText);
  const selCtx: Context | undefined = sel
    ? { lesson: lesson.id, title: lesson.title, sid: all[sel.from].sid, sentence: doc.sentences[all[sel.from].sid] }
    : undefined;

  const selectWord = (i: number, extend = false) => {
    if (extend && anchor.current != null) {
      const a = Math.min(anchor.current, i);
      const b = Math.max(anchor.current, i);
      if (all[a].sid !== all[b].sid && b - a > 40) return;
      setSel({ from: a, to: b });
    } else {
      anchor.current = i;
      setSel({ from: i, to: i });
    }
  };

  const nav = (dir: 1 | -1, onlyBlue = false) => {
    const cur = sel ? (dir > 0 ? sel.to : sel.from) : dir > 0 ? tokens[0]?.i - 1 : tokens[tokens.length - 1]?.i + 1;
    const list = dir > 0 ? tokens : [...tokens].reverse();
    const next = list.find((t) => {
      if (!isWord(t) || (dir > 0 ? t.i <= cur : t.i >= cur)) return false;
      const it = st.items[t.key!];
      return onlyBlue ? !it : !it || (it.status >= 1 && it.status <= 4);
    });
    if (next) {
      selectWord(next.i);
      document.querySelector(`[data-ti="${next.i}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  };

  const setStatus = (s: Status) => {
    if (!sel || !selKey) return;
    const prev = reader.item(selKey);
    reader.upsert(selText, { status: s, ...(s >= 1 && s <= 4 && !prev?.meaning && best.current ? { meaning: best.current } : {}) }, selCtx);
    if (s === 5 || s === -1) nav(1);
  };

  const blueOnPage = () => [...new Set(tokens.filter((t) => isWord(t) && !st.items[t.key!]).map((t) => t.text))];
  const turn = (d: 1 | -1) => {
    const n = page + d;
    if (n < 0 || n >= doc.pages.length) return;
    setSel(null);
    setPage(n);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const pageDone = () => {
    const blue = blueOnPage();
    reader.markKnown(blue);
    toast(blue.length ? `${blue.length} 个蓝词已标为已知` : "本页没有蓝词", "ok");
    if (page < doc.pages.length - 1) turn(1);
    else {
      setSel(null);
      go({ page: "reader" });
    }
  };

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || gsel.get()) return;
      const k = e.key;
      let hit = true;
      if (k === "ArrowRight" && e.shiftKey) turn(1);
      else if (k === "ArrowLeft" && e.shiftKey) turn(-1);
      else if (k === "ArrowRight") nav(1);
      else if (k === "ArrowLeft") nav(-1);
      else if (k === "b") nav(1, true);
      else if (k === "p") toggleAuto();
      else if (k === "+" || k === "=") setSize((x) => Math.min(30, x + 1));
      else if (k === "-") setSize((x) => Math.max(15, x - 1));
      else if (!sel) hit = false;
      else if (k >= "1" && k <= "4") setStatus(Number(k) as Status);
      else if (k === "k" || k === "5") setStatus(5);
      else if (k === "x") setStatus(-1);
      else if (k === "s") speak(selText);
      else if (k === "m") setAutoMusk(Date.now());
      else if (k === "h") document.querySelector<HTMLTextAreaElement>("[data-meaning]")?.focus();
      else if (k === "Escape") setSel(null);
      else hit = false;
      if (hit) e.preventDefault();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  useEffect(() => {
    const up = () => {
      setTimeout(() => (drag.current = null), 0);
    };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);

  const blueCount = blueOnPage().length;

  // ---- sentence TTS (xAI stock voice via Worker; browser speech fallback) ----
  const sidPage = useMemo(() => {
    const m = new Map<number, number>();
    doc.pages.forEach((pg2, pi) => doc.paragraphs.slice(pg2.from, pg2.to).forEach((p) => p.tokens.forEach((t) => !m.has(t.sid) && m.set(t.sid, pi))));
    return m;
  }, [doc]);
  const playFrom = async (sid: number, auto: boolean) => {
    tts.setAuto(auto);
    for (let s = sid; s < doc.sentences.length; s++) {
      const pi = sidPage.get(s);
      if (pi != null && pi !== page) setPage(pi);
      requestAnimationFrame(() => document.querySelector(`[data-sid="${s}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
      if (auto && s + 1 < doc.sentences.length) prefetch(doc.sentences[s + 1]).catch(() => null);
      const done = await tts.play(s, doc.sentences[s]);
      if (!done || !auto) return done && tts.stop();
    }
    tts.stop();
  };
  useEffect(() => () => tts.stop(), []);
  const firstSid = tokens[0]?.sid ?? 0;
  const toggleAuto = () => (tt.auto ? tts.stop() : playFrom(sel ? all[sel.from].sid : tt.sid ?? firstSid, true));

  // Learning words / phrases in the sentence being read that Musk has verified clips for.
  const [muskChips, setMuskChips] = useState<{ key: string; from: number; to: number }[]>([]);
  useEffect(() => {
    setMuskChips((c) => (c.length ? [] : c));
    if (tt.sid == null) return;
    const cands = new Map<string, { key: string; from: number; to: number }>();
    for (const t of tokens) {
      if (t.sid !== tt.sid) continue;
      const ph = phraseAt.get(t.i);
      if (ph && ph.from === t.i) {
        const it = st.items[ph.key];
        if (it && it.status >= 1 && it.status <= 4) cands.set(ph.key, ph);
      }
      if (!isWord(t)) continue;
      const it = st.items[t.key!];
      if (it && it.status >= 1 && it.status <= 4 && !cands.has(t.key!)) cands.set(t.key!, { key: t.key!, from: t.i, to: t.i });
    }
    let live = true;
    const list = [...cands.values()].sort((a, b) => b.key.length - a.key.length).slice(0, 4);
    Promise.all(list.map((c) => muskLookup(c.key, 1).then((r) => (r.musk > 0 && r.hits.length ? c : null), () => null))).then(
      (r) => live && setMuskChips(r.filter((x): x is { key: string; from: number; to: number } => !!x).slice(0, 2)),
    );
    return () => {
      live = false;
    };
  }, [tt.sid, page, st.items]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`page rd-page rd-lesson ${sel ? "has-sel" : ""}`}>
      <header className="rd-lesson-head">
        <a href="#/reader" className="rd-back" aria-label="返回课程">
          <ArrowLeft size={18} />
          课程
        </a>
        <div className="rd-lesson-tools">
          <button className={`rd-tts-auto ${tt.auto ? "is-on" : ""}`} onClick={toggleAuto} data-testid="tts-auto" aria-pressed={tt.auto}>
            {tt.auto ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
            连续播放
          </button>
          <button
            className="rd-tts-rate"
            onClick={() => tts.setRate(RATES[(RATES.indexOf(tt.rate) + 1) % RATES.length] ?? 1)}
            aria-label="语速"
            title="语速"
            data-testid="tts-rate"
          >
            {tt.rate}×
          </button>
          <button className="rd-icon" onClick={() => setSize((x) => Math.max(15, x - 1))} aria-label="缩小字号">
            A<small>-</small>
          </button>
          <button className="rd-icon" onClick={() => setSize((x) => Math.min(30, x + 1))} aria-label="放大字号">
            A<small>+</small>
          </button>
          <button
            className="rd-icon"
            onClick={() => {
              if (confirm("删除这节课？语料库里的词会保留。")) {
                reader.removeLesson(lesson.id);
                go({ page: "reader" });
              }
            }}
            aria-label="删除课程"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </header>

      <div className="rd-grid">
        <article className="rd-article">
          <h1 className="rd-lesson-title">{lesson.title}</h1>
          {lesson.url && (
            <a className="rd-source" href={lesson.url} target="_blank" rel="noreferrer">
              {lesson.url.replace(/^https?:\/\//, "").slice(0, 60)} <ExternalLink size={12} />
            </a>
          )}
          <div ref={textRef} className="rd-text" style={{ fontSize: size }} data-testid="reader-text">
            {paras.map((p, pi) => (
              <p key={pg.from + pi}>
                {p.tokens.map((t, ti) => {
                  const ph = phraseAt.get(t.i);
                  const inSel = !!sel && t.i >= sel.from && t.i <= sel.to;
                  const fl = (flash === t.sid ? " is-flash" : "") + (tt.sid === t.sid ? " is-say" : "");
                  const say =
                    ti === 0 || p.tokens[ti - 1].sid !== t.sid ? (
                      <button
                        key={`say${t.sid}`}
                        className={`rd-say ${tt.sid === t.sid ? "is-on" : ""}`}
                        onClick={() => (tt.sid === t.sid && !tt.loading ? tts.stop() : playFrom(t.sid, tt.auto))}
                        aria-label="朗读这句"
                        data-testid="say"
                      >
                        {tt.sid === t.sid ? <Pause size={10} fill="currentColor" /> : <Play size={10} fill="currentColor" />}
                      </button>
                    ) : null;
                  if (!isWord(t))
                    return (
                      <Fragment key={t.i}>
                        {say}
                        <span data-sid={t.sid} className={`${ph && t.i > ph.from && t.i < ph.to ? "ph" : ""}${inSel ? " in-sel" : ""}${fl}`}>
                          {t.text}
                        </span>
                      </Fragment>
                    );
                  const it = st.items[t.key!];
                  return (
                    <Fragment key={t.i}>
                    {say}
                    <span
                      data-ti={t.i}
                      data-sid={t.sid}
                      data-testid="tok"
                      className={`w ${statusClass(it)}${ph ? " ph" : ""}${inSel ? " in-sel" : ""}${sel && sel.from === t.i ? " sel-a" : ""}${sel && sel.to === t.i ? " sel-b" : ""}${fl}`}
                      onPointerDown={(e) => {
                        if (e.pointerType === "mouse" && e.button === 0 && !e.shiftKey) drag.current = { start: t.i, moved: false };
                      }}
                      onPointerEnter={() => {
                        const d = drag.current;
                        if (!d || t.i === d.start) return;
                        d.moved = true;
                        anchor.current = d.start;
                        setSel({ from: Math.min(d.start, t.i), to: Math.max(d.start, t.i) });
                      }}
                      onClick={(e) => {
                        if (drag.current?.moved) return;
                        selectWord(t.i, e.shiftKey);
                      }}
                    >
                      {t.text}
                    </span>
                    </Fragment>
                  );
                })}
              </p>
            ))}
          </div>

          <footer className="rd-pager">
            <button className="rd-icon" onClick={() => turn(-1)} disabled={page === 0} aria-label="上一页">
              <ChevronLeft size={18} />
            </button>
            <span>
              {page + 1} / {doc.pages.length}
            </span>
            <button className="rd-icon" onClick={() => turn(1)} disabled={page >= doc.pages.length - 1} aria-label="下一页">
              <ChevronRight size={18} />
            </button>
          </footer>
          <button className="rd-btn rd-btn-done" onClick={pageDone} data-testid="page-done">
            <Check size={17} />
            {page < doc.pages.length - 1 ? "本页读完" : "读完课程"}
            {blueCount > 0 && <small> · {blueCount} 个蓝词标为已知</small>}
          </button>
          <p className="rd-keys hide-touch">
            <kbd>←</kbd>
            <kbd>→</kbd> 切词 · <kbd>b</kbd> 下个蓝词 · <kbd>1</kbd>–<kbd>4</kbd> 等级 · <kbd>k</kbd> 已知 · <kbd>x</kbd> 忽略 · <kbd>h</kbd> 写释义 · <kbd>s</kbd> 发音 · <kbd>m</kbd>{" "}
            Musk · <kbd>⇧</kbd>+拖动/点击 选短语 · <kbd>⇧</kbd>
            <kbd>←</kbd>
            <kbd>→</kbd> 翻页 · <kbd>p</kbd> 连续播放
          </p>
          {tt.sid != null && (
            <div className="rd-np" data-testid="now-playing">
              <button className="rd-icon" onClick={() => tts.stop()} aria-label="停止">
                <Pause size={15} fill="currentColor" />
              </button>
              <span className="rd-np-meta">
                第 {tt.sid + 1}/{doc.sentences.length} 句{tt.loading ? " · 加载中…" : tt.src === "browser" ? " · 系统语音" : ""}
              </span>
              {muskChips.map((c) => (
                <button
                  key={c.key}
                  className="rd-np-musk"
                  data-testid="np-musk"
                  onClick={() => {
                    tts.stop();
                    anchor.current = c.from;
                    setSel({ from: c.from, to: c.to });
                    setAutoMusk(Date.now());
                  }}
                >
                  听 Musk 原声 · {c.key}
                </button>
              ))}
            </div>
          )}
        </article>

        <aside className={`rd-aside ${sel ? "is-open" : ""}`} aria-label="词卡">
          {sel && selKey ? (
            <WordCard
              key={selKey}
              text={selText}
              k={selKey}
              ctx={selCtx!}
              phrase={phraseAt.get(sel.from)}
              autoMusk={autoMusk}
              canExtend={{ left: sel.from > 0, right: sel.to < all.length - 1 }}
              onExtend={(d) => {
                const list = d > 0 ? all.slice(sel.to + 1) : all.slice(0, sel.from).reverse();
                const w = list.find(isWord);
                if (w) setSel(d > 0 ? { from: sel.from, to: w.i } : { from: w.i, to: sel.to });
              }}
              onPick={(r) => setSel(r)}
              onStatus={setStatus}
              onClose={() => setSel(null)}
              best={best}
            />
          ) : (
            <div className="rd-empty">
              <p>点一个词查看释义</p>
              <p className="rd-dim">拖动或按住 ⇧ 点击可以选短语</p>
              <div className="rd-legend">
                <span>
                  <i className="w s-new">新词</i>
                </span>
                <span>
                  <i className="w s-1">1</i>
                  <i className="w s-2">2</i>
                  <i className="w s-3">3</i>
                  <i className="w s-4">4</i> 学习中
                </span>
                <span>已知不标色</span>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

