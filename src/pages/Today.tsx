/** 今日 — built only from my own 语料 (reader + Musk): today's FSRS reviews, what I saved today, and a few to revisit. */
import { ArrowRight, BookOpenText, GraduationCap, Pause, Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ClipPlayer } from "../musk/ClipPlayer";
import { clock, sentence as loadSentence, type Sentence } from "../musk/corpus";
import { reader, useReader, type Item } from "../reader/model";
import { muskLookup } from "../reader/MuskSays";
import { formatInterval } from "../store/srs";
import { dayKey } from "../store/store";
import { KIND_LABEL, ReviewSheet } from "./Corpus";

function greeting(h: number) {
  if (h < 5) return "夜深了";
  if (h < 11) return "早上好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

/** Kept for 我的 (word-atlas streak). */
export function streakOf(days: Record<string, { r: number }>) {
  let n = 0;
  const d = new Date();
  if (!(days[dayKey(d)]?.r > 0)) d.setDate(d.getDate() - 1);
  while (days[dayKey(d)]?.r > 0) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

const statusText = (s: Item["status"]) => (s === 5 ? "已知" : s === -1 ? "忽略" : `${s}`);

export function Today() {
  const st = useReader();
  const [reviewing, setReviewing] = useState(false);
  const now = new Date();
  const t = Date.now();
  const today = dayKey(now);
  const all = Object.values(st.items).filter((it) => it.status !== -1 && !(it.status === 5 && !it.srs && it.kind === "word" && !it.meaning && !it.ctx));
  const due = all.filter((it) => it.srs && it.srs.due <= t).sort((a, b) => a.srs!.due - b.srs!.due);
  const inReview = all.filter((it) => it.srs);
  const nextDue = inReview.filter((it) => it.srs!.due > t).sort((a, b) => a.srs!.due - b.srs!.due)[0];
  const fresh = all.filter((it) => dayKey(new Date(it.created)) === today).sort((a, b) => b.created - a.created);
  const learning = all.filter((it) => it.status >= 1 && it.status <= 4);
  const freshKeys = new Set(fresh.map((it) => it.key));
  const dueKeys = new Set(due.map((it) => it.key));
  // Revisit: learning items not already shown, least recently touched first.
  const revisit = learning.filter((it) => !freshKeys.has(it.key) && !dueKeys.has(it.key)).sort((a, b) => a.updated - b.updated).slice(0, 5);
  const notInReview = learning.filter((it) => !it.srs);

  return (
    <div className="page rd-page td-page" data-testid="today">
      <header className="rd-head">
        <div>
          <p className="rd-eyebrow">
            {now.getMonth() + 1}月{now.getDate()}日 · 星期{"日一二三四五六"[now.getDay()]}
          </p>
          <h1 className="rd-title">{greeting(now.getHours())}</h1>
        </div>
      </header>

      {!all.length ? (
        <section className="td-empty" data-testid="today-empty">
          <BookOpenText size={30} />
          <h2>还没有语料</h2>
          <p>在阅读里点词、选短语、存句子，它们会每天出现在这里。</p>
          <div>
            <a className="rd-btn rd-btn-primary" href="#/reader">
              去阅读 <ArrowRight size={15} />
            </a>
            <a className="rd-btn" href="#/">
              去 Musk
            </a>
          </div>
        </section>
      ) : (
        <>
          <div className="td-stats" data-testid="today-stats">
            <Stat n={due.length} label="待复习" />
            <Stat n={fresh.length} label="今天新增" />
            <Stat n={learning.length} label="学习中" />
            <Stat n={all.length} label="语料" href="#/corpus" />
          </div>

          <section className={`td-review ${due.length ? "" : "is-clear"}`} data-testid="today-review">
            <div>
              <p className="rd-eyebrow">今日复习</p>
              {due.length ? (
                <h2>
                  <b>{due.length}</b> 条到期
                </h2>
              ) : inReview.length ? (
                <h2>今天复习完了</h2>
              ) : (
                <h2>还没有加入复习</h2>
              )}
              <p className="rd-dim">
                {due.length
                  ? "先回忆，再看释义和 Musk 原声。"
                  : nextDue
                    ? `下一条 ${formatInterval(nextDue.srs!.due - t)}后`
                    : notInReview.length
                      ? `${notInReview.length} 条学习中的语料可以加入复习`
                      : "在语料里点「加入复习」"}
              </p>
            </div>
            {due.length ? (
              <button className="rd-btn rd-btn-primary" onClick={() => setReviewing(true)} data-testid="today-review-start">
                <GraduationCap size={16} /> 开始复习
              </button>
            ) : notInReview.length ? (
              <button className="rd-btn" onClick={() => notInReview.forEach((it) => reader.addToReview(it.key))} data-testid="today-add-review">
                全部加入复习
              </button>
            ) : null}
          </section>

          {due.length > 0 && <Group title="到期" items={due.slice(0, 6)} more={due.length - 6} testid="today-due" />}
          <Group title="今天新增" items={fresh.slice(0, 8)} more={fresh.length - 8} testid="today-fresh" empty="今天还没存新语料。去阅读点几个词吧。" />
          {revisit.length > 0 && <Group title="再看看" sub="学习中 · 最久没碰" items={revisit} testid="today-revisit" />}
        </>
      )}
      <ReviewSheet open={reviewing} onClose={() => setReviewing(false)} />
    </div>
  );
}

function Stat({ n, label, href }: { n: number; label: string; href?: string }) {
  const body = (
    <>
      <b>{n}</b>
      <span>{label}</span>
    </>
  );
  return href ? (
    <a className="td-stat" href={href}>
      {body}
    </a>
  ) : (
    <div className="td-stat">{body}</div>
  );
}

function Group({ title, sub, items, more = 0, testid, empty }: { title: string; sub?: string; items: Item[]; more?: number; testid: string; empty?: string }) {
  return (
    <section className="td-group" data-testid={testid}>
      <header>
        <h3>{title}</h3>
        {sub && <span className="rd-dim">{sub}</span>}
        <a className="rd-link" href="#/corpus">
          {more > 0 ? `还有 ${more} 条 ›` : "语料 ›"}
        </a>
      </header>
      {!items.length ? <p className="rd-dim td-none">{empty}</p> : (
        <ul className="td-list">
          {items.map((it) => (
            <TodayCard key={it.key} it={it} />
          ))}
        </ul>
      )}
    </section>
  );
}

function sourceHref(it: Item) {
  if (!it.ctx) return null;
  if (it.ctx.musk) return `#/?q=${encodeURIComponent(it.kind === "sentence" ? it.text.split(/\s+/).slice(0, 4).join(" ") : it.key)}`;
  return `#/reader?l=${it.ctx.lesson}&s=${it.ctx.sid}`;
}

function TodayCard({ it }: { it: Item }) {
  const s = it.kind === "sentence" ? "" : (it.ctx?.sentence ?? "");
  const at = s.toLowerCase().indexOf(it.text.toLowerCase());
  const href = sourceHref(it);
  return (
    <li className={`td-card kind-${it.kind}`} data-testid="today-card">
      <div className="td-card-head">
        <b className="td-text">{it.text}</b>
        <span className={`rd-pill st-${it.status}`}>{statusText(it.status)}</span>
        {it.kind !== "word" && <em className="td-kind">{KIND_LABEL[it.kind]}</em>}
      </div>
      {it.meaning && <p className="td-meaning">{it.meaning}</p>}
      {s && (
        <p className="td-ctx">
          {at >= 0 ? (
            <>
              {s.slice(0, at)}
              <mark>{s.slice(at, at + it.text.length)}</mark>
              {s.slice(at + it.text.length)}
            </>
          ) : (
            s
          )}
        </p>
      )}
      <MuskClip it={it} />
      {href && (
        <a className="td-src" href={href}>
          {it.ctx?.musk ? `Musk · ${it.ctx.title.slice(0, 28)} · ${clock(it.ctx.musk.t)}` : `《${it.ctx!.title.slice(0, 24)}》`}
        </a>
      )}
    </li>
  );
}

/** First "Musk 怎么说" clip for the item, when the corpus has one. Sentences saved from Musk replay their own clip. */
function MuskClip({ it }: { it: Item }) {
  const [hit, setHit] = useState<{ s: Sentence; from: number; to: number; title: string } | null | undefined>(undefined);
  const [on, setOn] = useState(0);
  useEffect(() => {
    let live = true;
    setHit(undefined);
    const p =
      it.kind === "sentence"
        ? it.ctx?.musk
          ? loadSentence(it.ctx.sid).then((s) => (s && s.c ? { s, from: -1, to: -1, title: it.ctx!.title } : null))
          : Promise.resolve(null)
        : muskLookup(it.key, 1).then((r) => (r.hits[0] ? { s: r.hits[0].sentence, from: r.hits[0].from, to: r.hits[0].to, title: r.hits[0].video?.title ?? "" } : null));
    p.then((h) => live && setHit(h), () => live && setHit(null));
    return () => {
      live = false;
    };
  }, [it.key, it.kind, it.ctx]);
  const preview = useMemo(() => (hit ? hit.s.t : ""), [hit]);
  if (!hit) return null;
  return (
    <div className={`td-musk ${on ? "is-on" : ""}`} data-testid="today-musk">
      <button className="td-musk-btn" onClick={() => setOn(on ? 0 : Date.now())} data-testid="today-musk-play">
        <span className="rd-play">{on ? <Pause size={11} fill="currentColor" /> : <Play size={11} fill="currentColor" />}</span>
        <span>
          <small>Musk 怎么说</small>
          {!on && <span className="td-musk-line">{preview}</span>}
        </span>
      </button>
      {on > 0 && (
        <div className="rd-musk-stage">
          <ClipPlayer sentence={hit.s} from={hit.from} to={hit.to} nonce={on} title={hit.title} />
        </div>
      )}
    </div>
  );
}
