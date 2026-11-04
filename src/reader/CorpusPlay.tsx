/** 语料 detail: autoplay the item's own sentence (YouTube span / Musk clip / TTS), then 其他片段 across video lessons + Musk. */
import { ExternalLink, Pause, Play, Volume2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ClipPlayer } from "../musk/ClipPlayer";
import { clock, findSentence, type Sentence } from "../musk/corpus";
import { muskLookup } from "./MuskSays";
import { MuskText } from "./MuskText";
import { parse, useReader, type Item, type Lesson } from "./model";
import { tts, useTts } from "./tts";
import { watchUrl } from "./youtube";

export type Clip = {
  id: string;
  text: string;
  /** Char range to highlight in `text` (-1 = none). */
  from: number;
  to: number;
  title: string;
  src: "yt" | "musk" | "tts";
  t?: number;
  e?: number;
  v?: string;
  musk?: Sentence;
  uncertain?: boolean;
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Char range of `key` (normalized words) inside `text`, or [-1,-1]. */
export function rangeOf(text: string, key: string): [number, number] {
  const ws = key.split(" ").filter(Boolean);
  if (!ws.length) return [-1, -1];
  const re = new RegExp(`(?<![A-Za-z0-9])${ws.map(esc).join("[^A-Za-z0-9]+")}(?![A-Za-z0-9])`, "i");
  const m = re.exec(text);
  return m ? [m.index, m.index + m[0].length] : [-1, -1];
}

const docs = new Map<string, ReturnType<typeof parse>>();
const docOf = (l: Lesson) => {
  let d = docs.get(l.id + l.text.length);
  if (!d) docs.set(l.id + l.text.length, (d = parse(l.text)));
  return d;
};
const spanOf = (l: Lesson, sid: number): [number, number] | null => {
  const t = l.yt?.times[sid];
  if (t == null) return null;
  const nx = l.yt!.times.slice(sid + 1).find((x) => x > t);
  return [t, Math.min(nx ?? t + 6, t + 30)];
};

/** Every sentence in video lessons where the key's words occur in a row. */
function lessonHits(lessons: Lesson[], key: string, skip?: { lesson: string; sid: number }): Clip[] {
  const ws = key.split(" ");
  const out: Clip[] = [];
  for (const l of lessons) {
    if (!l.yt) continue;
    const d = docOf(l);
    const bySid = new Map<number, string[]>();
    for (const p of d.paragraphs) for (const t of p.tokens) if (t.key) (bySid.get(t.sid) ?? bySid.set(t.sid, []).get(t.sid)!).push(t.key);
    for (const [sid, keys] of bySid) {
      if (skip && skip.lesson === l.id && skip.sid === sid) continue;
      if (!keys.some((_, j) => ws.every((w, k) => keys[j + k] === w))) continue;
      const sp = spanOf(l, sid);
      if (!sp) continue;
      const text = d.sentences[sid];
      const [from, to] = rangeOf(text, key);
      out.push({ id: `l:${l.id}:${sid}`, text, from, to, title: l.title, src: "yt", v: l.yt.v, t: sp[0], e: sp[1] });
    }
  }
  return out;
}

/** The item's own sentence as a playable clip. */
function useSource(it: Item, lessons: Lesson[]): Clip | null | undefined {
  const [musk, setMusk] = useState<Clip | null | undefined>(undefined);
  const ctx = it.ctx;
  useEffect(() => {
    if (!ctx?.musk) return;
    let live = true;
    findSentence(ctx.musk.v, ctx.musk.t).then(
      (s) => {
        if (!live) return;
        if (!s) return setMusk(null);
        const [from, to] = it.kind === "sentence" ? [-1, -1] : rangeOf(s.t, it.key);
        setMusk({ id: `m:${s.id}`, text: s.t, from, to, title: ctx.title, src: "musk", musk: s, t: s.s });
      },
      () => live && setMusk(null),
    );
    return () => {
      live = false;
    };
  }, [ctx?.musk?.v, ctx?.musk?.t, it.key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ctx) return null;
  if (ctx.musk) return musk;
  const l = lessons.find((x) => x.id === ctx.lesson);
  const text = ctx.sentence;
  const [from, to] = it.kind === "sentence" ? [-1, -1] : rangeOf(text, it.key);
  const sp = l ? spanOf(l, ctx.sid) : null;
  if (l?.yt && sp) return { id: `l:${l.id}:${ctx.sid}`, text, from, to, title: ctx.title, src: "yt", v: l.yt.v, t: sp[0], e: sp[1] };
  return { id: `t:${ctx.lesson}:${ctx.sid}`, text, from, to, title: ctx.title, src: "tts" };
}

function Marked({ c }: { c: Clip }) {
  if (c.musk) return <MuskText sentence={c.musk} title={c.title} place="says" from={c.from} to={c.to} />;
  if (c.from < 0) return <>{c.text}</>;
  return (
    <>
      {c.text.slice(0, c.from)}
      <mark>{c.text.slice(c.from, c.to)}</mark>
      {c.text.slice(c.to)}
    </>
  );
}

function Stage({ c, nonce }: { c: Clip; nonce: number }) {
  const tt = useTts();
  useEffect(() => {
    if (c.src !== "tts") return;
    tts.play(-1, c.text).then(() => tts.stop());
    return () => tts.stop();
  }, [c.id, nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  if (c.src === "musk" && c.musk) return <ClipPlayer sentence={c.musk} from={c.from} to={c.to} nonce={nonce} title={c.title} />;
  if (c.src === "yt")
    return (
      <>
        <div className="rd-yt-frame cp-frame">
          <iframe
            key={`${c.id}:${nonce}`}
            src={`https://www.youtube-nocookie.com/embed/${c.v}?start=${Math.floor(c.t!)}&end=${Math.ceil(c.e!)}&autoplay=1&playsinline=1&rel=0&cc_load_policy=0`}
            title={c.title}
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
            data-testid="cp-embed"
          />
        </div>
        <p className="musk-stage-text">
          <Marked c={c} />
        </p>
        <p className="cp-out">
          <a href={watchUrl(c.v!, c.t!)} target="_blank" rel="noreferrer" data-testid="cp-out">
            在 YouTube 打开 {clock(c.t!)} <ExternalLink size={12} />
          </a>
        </p>
      </>
    );
  const on = tt.sid === -1;
  return (
    <div className="cp-tts" data-testid="cp-tts">
      <button className="rd-sv-act rd-sv-play" onClick={() => (on && !tt.loading ? tts.stop() : tts.play(-1, c.text).then(() => tts.stop()))} aria-label="朗读">
        {on ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
      </button>
      <p className="musk-stage-text">
        <Marked c={c} />
      </p>
      <small className="rd-dim">
        <Volume2 size={12} /> 没有视频，朗读原句
      </small>
    </div>
  );
}

export function CorpusPlay({ it, replay }: { it: Item; replay: number }) {
  const st = useReader();
  const src = useSource(it, st.lessons);
  const [musk, setMusk] = useState<Clip[] | null>(null);
  const [on, setOn] = useState<{ c: Clip; nonce: number } | null>(null);
  const words = it.kind !== "sentence";

  const local = useMemo(
    () => (words ? lessonHits(st.lessons, it.key, it.ctx && !it.ctx.musk ? { lesson: it.ctx.lesson, sid: it.ctx.sid } : undefined) : []),
    [st.lessons, it.key, words], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => {
    if (!words) return setMusk([]);
    let live = true;
    setMusk(null);
    muskLookup(it.key, 8).then(
      (r) =>
        live &&
        setMusk(
          r.hits.map((h) => ({ id: `m:${h.sentence.id}`, text: h.sentence.t, from: h.from, to: h.to, title: h.video?.title ?? h.sentence.v, src: "musk", musk: h.sentence, t: h.sentence.s, uncertain: h.sentence.m !== "musk" })),
        ),
      () => live && setMusk([]),
    );
    return () => {
      live = false;
    };
  }, [it.key, words]);

  const others = useMemo(() => {
    const seen = new Set<string>(src ? [src.text.toLowerCase()] : []);
    return [...local, ...(musk ?? [])].filter((c) => {
      const k = c.text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (c.id === src?.id || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [local, musk, src?.id, src?.text]);
  // Autoplay the item's own sentence as soon as it resolves.
  useEffect(() => {
    if (src && !on) setOn({ c: src, nonce: Date.now() });
  }, [src]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (replay) setOn((o) => (o ? { ...o, nonce: Date.now() } : src ? { c: src, nonce: Date.now() } : o));
  }, [replay]); // eslint-disable-line react-hooks/exhaustive-deps

  const row = (c: Clip, label: string) => (
    <li key={c.id}>
      <button className={on?.c.id === c.id ? "is-on" : ""} onClick={() => setOn({ c, nonce: Date.now() })} data-testid="cp-row">
        <span className="rd-play">
          <Play size={11} fill="currentColor" />
        </span>
        <span className="rd-musk-text">
          <span className="cp-line">
            <Marked c={c} />
          </span>
          <small>
            {label}
            {c.t != null ? ` · ${clock(c.t)}` : ""}
            {c.uncertain ? " · 未确认" : ""}
          </small>
        </span>
      </button>
    </li>
  );

  return (
    <div className="cp" data-testid="corpus-play">
      <div className="rd-musk-stage cp-stage" data-testid="cp-stage">
        {on ? <Stage c={on.c} nonce={on.nonce} /> : src === null ? <p className="rd-dim">没有原句</p> : <p className="rd-dim">加载中…</p>}
      </div>
      {src && on && on.c.id !== src.id && (
        <button className="rd-link cp-back" onClick={() => setOn({ c: src, nonce: Date.now() })}>
          ‹ 回到原句
        </button>
      )}
      {words && (
        <section className="rd-musk is-compact cp-others" data-testid="cp-others">
          <header>
            <h4>
              其他片段 <small data-testid="cp-count">{musk ? others.length : "…"}</small>
            </h4>
          </header>
          {!musk && !local.length ? (
            <p className="rd-dim">查找中…</p>
          ) : !others.length ? (
            <p className="rd-dim">别的视频里还没遇到过</p>
          ) : (
            <ol className="rd-musk-list">{others.map((c) => row(c, c.src === "musk" ? `Musk · ${c.title.slice(0, 28)}` : `《${c.title.slice(0, 24)}》`))}</ol>
          )}
        </section>
      )}
    </div>
  );
}
