/** Video-first study: player and the lesson's own captions. Word taps reuse the reader card. */
import { ExternalLink, Languages, Pause, Play, RotateCcw, SkipBack, SkipForward } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type RefObject } from "react";
import type { Item, Lesson, Token } from "./model";
import { phraseIndex } from "./model";
import { translate } from "./dict";
import { LocalPlayer } from "./LocalPlayer";
import { cacheNote, initialSource, lessonCache, saveChoice, type SourceChoice } from "./hostedLesson";
import { centerScroll, followAllowed, sentenceAt, shouldRecenter } from "./sync";
import { YoutubePlayer, type PlayerHandle, type PlayerPhase } from "./YoutubePlayer";
import { clockOf, watchUrl } from "./youtube";

type Sel = { from: number; to: number };
const statusClass = (it?: Item) => (!it ? "s-new" : it.status === 5 ? "s-known" : it.status === -1 ? "s-ign" : `s-${it.status}`);

interface RowProps {
  sid: number;
  tokens: Token[];
  active: boolean;
  selFrom: number;
  selTo: number;
  stamp: string;
  timeLabel: string;
  showTr: boolean;
  tr: string;
  itemsRef: RefObject<Record<string, Item>>;
  phraseRef: RefObject<Map<number, { from: number; to: number; key: string }>>;
  bus: RefObject<Bus>;
}

interface Bus {
  jump: (sid: number) => void;
  down: (i: number, e: PointerEvent) => void;
  enter: (i: number) => void;
  clickWord: (i: number, e: MouseEvent) => void;
}

const SentRow = memo(
  function SentRow({ sid, tokens, active, selFrom, selTo, timeLabel, showTr, tr, itemsRef, phraseRef, bus }: RowProps) {
    return (
      <div className={`vs-sent ${active ? "is-on" : ""}`} role="listitem" data-vs={sid} aria-current={active ? "true" : undefined} data-testid="vs-sent">
        <button type="button" className="vs-jump" onClick={() => bus.current?.jump(sid)} aria-label={`从第 ${sid + 1} 句播放`} data-testid="vs-jump">
          {timeLabel}
        </button>
        <div className="vs-copy">
        <div
          className="vs-line rd-text"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest(".w")) return;
            bus.current?.jump(sid);
          }}
        >
          {tokens.map((t) => {
            const ph = phraseRef.current?.get(t.i);
            const inSel = selFrom >= 0 && t.i >= selFrom && t.i <= selTo;
            if (!t.key)
              return (
                <span key={t.i} className={`${ph && t.i > ph.from && t.i < ph.to ? "ph" : ""}${inSel ? " in-sel" : ""}`}>
                  {t.text}
                </span>
              );
            const it = itemsRef.current?.[t.key];
            return (
              <span
                key={t.i}
                data-ti={t.i}
                data-testid="tok"
                className={`w ${statusClass(it)}${ph ? " ph" : ""}${inSel ? " in-sel" : ""}${selFrom === t.i ? " sel-a" : ""}${selTo === t.i ? " sel-b" : ""}`}
                onPointerDown={(e) => bus.current?.down(t.i, e)}
                onPointerEnter={() => bus.current?.enter(t.i)}
                onClick={(e) => bus.current?.clickWord(t.i, e)}
              >
                {t.text}
              </span>
            );
          })}
        </div>
          {active && showTr && (
            <p className="vs-tr" data-testid="vs-tr">
              <small>机器翻译 · MyMemory 或 Google</small>
              {tr || "正在取译文…"}
            </p>
          )}
        </div>
      </div>
    );
  },
  (a, b) =>
    a.sid === b.sid &&
    a.active === b.active &&
    a.selFrom === b.selFrom &&
    a.selTo === b.selTo &&
    a.stamp === b.stamp &&
    a.timeLabel === b.timeLabel &&
    a.showTr === b.showTr &&
    a.tr === b.tr &&
    a.tokens === b.tokens,
);

function stampOf(tokens: Token[], items: Record<string, Item>, phraseAt: Map<number, { key: string }>) {
  let s = "";
  for (const t of tokens) {
    if (!t.key) continue;
    s += `${t.i}:${items[t.key]?.status ?? "n"}:${phraseAt.get(t.i)?.key ?? ""};`;
  }
  return s;
}

export function VideoStudy({
  lesson,
  doc,
  items,
  sel,
  setSel,
  cur,
  setCur,
}: {
  lesson: Lesson;
  doc: { paragraphs: { tokens: Token[] }[]; sentences: string[] };
  items: Record<string, Item>;
  sel: Sel | null;
  setSel: (s: Sel | null) => void;
  cur: number;
  setCur: (n: number | ((c: number) => number)) => void;
}) {
  const yt = lesson.yt!;
  const times = yt.times;
  const player = useRef<PlayerHandle>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const hold = useRef(0);
  const picking = useRef(false);
  const drag = useRef<{ start: number; moved: boolean } | null>(null);
  const dragEnd = useRef(0);
  const anchor = useRef<number | null>(null);
  const timesRef = useRef(times);
  const curRef = useRef(cur);
  timesRef.current = times;
  curRef.current = cur;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [phase, setPhase] = useState<PlayerPhase>("loading");
  const [showTr, setShowTr] = useState(false);
  const [tr, setTr] = useState<Record<number, string>>({});
  const [hint, setHint] = useState("");
  const [held, setHeld] = useState(false);
  const [source, setSource] = useState<SourceChoice>(() => initialSource(yt.v));
  const [asked, setAsked] = useState(false);
  const [bootAt, setBootAt] = useState(() => times[cur] ?? 0);
  const clock = useRef(times[cur] ?? 0);
  const alignMode = useRef<"force" | "follow">("force");
  const programmatic = useRef(false);
  const holdTimer = useRef(0);
  const lastSet = useRef(0);
  const ignoreScrollUntil = useRef(0);
  const selRef = useRef(sel);
  const heldRef = useRef(held);
  selRef.current = sel;
  heldRef.current = held;

  const all = useMemo(() => doc.paragraphs.flatMap((p) => p.tokens), [doc]);
  const lines = useMemo(() => {
    const by = new Map<number, Token[]>();
    for (const t of all) {
      const g = by.get(t.sid);
      if (g) g.push(t);
      else by.set(t.sid, [t]);
    }
    return doc.sentences.map((text, sid) => ({ sid, text, tokens: by.get(sid) ?? [] }));
  }, [all, doc.sentences]);
  const phraseAt = useMemo(() => {
    const idx = phraseIndex(items);
    const map = new Map<number, { from: number; to: number; key: string }>();
    if (!idx.size) return map;
    const bySid = new Map<number, Token[]>();
    for (const t of all) {
      if (!t.key) continue;
      const g = bySid.get(t.sid);
      if (g) g.push(t);
      else bySid.set(t.sid, [t]);
    }
    for (const words of bySid.values()) {
      words.forEach((t, j) => {
        for (const ws of idx.get(t.key!) ?? []) {
          if (j + ws.length > words.length || !ws.every((w, k) => words[j + k].key === w)) continue;
          const range = { from: t.i, to: words[j + ws.length - 1].i, key: ws.join(" ") };
          for (let i = range.from; i <= range.to; i++) if (!map.has(i) || map.get(i)!.key.length < range.key.length) map.set(i, range);
        }
      });
    }
    return map;
  }, [all, items]);
  const phraseRef = useRef(phraseAt);
  phraseRef.current = phraseAt;

  const jump = (sid: number) => {
    if (Date.now() - dragEnd.current < 400) return;
    const t = timesRef.current[sid];
    if (t == null || !Number.isFinite(t)) {
      setHint("这一句没有时间点，不能定位。");
      return;
    }
    setHint("");
    hold.current = Date.now() + 1200;
    alignMode.current = "force";
    heldRef.current = false;
    window.clearTimeout(holdTimer.current);
    setHeld(false);
    setSel(null);
    setCur(sid);
    player.current?.seek(t);
    player.current?.play();
  };
  const replay = () => {
    const t = timesRef.current[curRef.current];
    if (t == null || !Number.isFinite(t)) {
      setHint("这一句没有时间点，不能重播。");
      return;
    }
    setHint("");
    hold.current = Date.now() + 1200;
    alignMode.current = "force";
    heldRef.current = false;
    window.clearTimeout(holdTimer.current);
    setHeld(false);
    player.current?.seek(t);
    player.current?.play();
    requestAnimationFrame(() => alignTo(curRef.current, "force"));
  };
  const step = (d: 1 | -1) => {
    const n = curRef.current + d;
    if (n < 0 || n >= lines.length) return;
    jump(n);
  };
  const bus = useRef<Bus>({
    jump,
    down(i, e) {
      e.stopPropagation();
      picking.current = true;
      if (e.pointerType === "mouse" && e.button === 0 && !e.shiftKey) drag.current = { start: i, moved: false };
    },
    enter(i) {
      const d = drag.current;
      if (!d || i === d.start) return;
      d.moved = true;
      anchor.current = d.start;
      setSel({ from: Math.min(d.start, i), to: Math.max(d.start, i) });
    },
    clickWord(i, e) {
      e.stopPropagation();
      e.preventDefault();
      if (drag.current?.moved) return;
      if (e.shiftKey && anchor.current != null) setSel({ from: Math.min(anchor.current, i), to: Math.max(anchor.current, i) });
      else {
        anchor.current = i;
        setSel({ from: i, to: i });
      }
    },
  });
  bus.current.jump = jump;
  bus.current.down = (i, e) => {
    e.stopPropagation();
    picking.current = true;
    if (e.pointerType === "mouse" && e.button === 0 && !e.shiftKey) drag.current = { start: i, moved: false };
  };
  bus.current.enter = (i) => {
    const d = drag.current;
    if (!d || i === d.start) return;
    d.moved = true;
    anchor.current = d.start;
    setSel({ from: Math.min(d.start, i), to: Math.max(d.start, i) });
  };
  bus.current.clickWord = (i, e) => {
    e.stopPropagation();
    e.preventDefault();
    if (drag.current?.moved) return;
    if (e.shiftKey && anchor.current != null) setSel({ from: Math.min(anchor.current, i), to: Math.max(anchor.current, i) });
    else {
      anchor.current = i;
      setSel({ from: i, to: i });
    }
  };

  useEffect(() => {
    const up = () => {
      if (drag.current?.moved) dragEnd.current = Date.now();
      picking.current = false;
      setTimeout(() => (drag.current = null), 0);
    };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
      if (el.tagName === "BUTTON" && (e.key === " " || e.key === "Enter")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "r") replay();
      else if (e.key === "t") setShowTr((s) => !s);
      else if (e.key === " ") player.current?.toggle();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  useEffect(() => {
    if (!showTr || tr[cur] != null) return;
    let live = true;
    const at = cur;
    translate(doc.sentences[at] ?? "").then((text) => {
      if (!live) return;
      setTr((m) => ({ ...m, [at]: text ?? "没有取到译文。在线翻译没有返回，这里不会编造。" }));
    });
    return () => {
      live = false;
    };
  }, [showTr, cur, doc.sentences, tr]);

  const alignTo = (sid: number, mode: "force" | "follow") => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-vs="${sid}"]`);
    if (!list || !row || list.clientHeight < 40) return;
    if (mode === "follow" && !followAllowed({ picking: picking.current, cardOpen: selRef.current != null, userHold: heldRef.current })) return;
    const itemTop = list.scrollTop + (row.getBoundingClientRect().top - list.getBoundingClientRect().top);
    const next = centerScroll(list.clientHeight, list.scrollHeight, itemTop, row.offsetHeight);
    if (mode === "follow" && !shouldRecenter(list.scrollTop, next)) return;
    lastSet.current = next;
    ignoreScrollUntil.current = performance.now() + 160;
    programmatic.current = true;
    list.scrollTop = next;
    queueMicrotask(() => {
      programmatic.current = false;
    });
  };
  useEffect(() => {
    const mode = alignMode.current;
    alignMode.current = "follow";
    let live = true;
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (live) alignTo(cur, mode);
      }),
    );
    return () => {
      live = false;
      cancelAnimationFrame(id);
    };
  }, [cur, held, sel]); // eslint-disable-line react-hooks/exhaustive-deps
  const onListScroll = () => {
    const list = listRef.current;
    if (!list || programmatic.current || performance.now() < ignoreScrollUntil.current) return;
    if (Math.abs(list.scrollTop - lastSet.current) < 48) return;
    heldRef.current = true;
    setHeld(true);
    window.clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(() => {
      heldRef.current = false;
      setHeld(false);
    }, 8000);
  };
  const backToCurrent = () => {
    heldRef.current = false;
    window.clearTimeout(holdTimer.current);
    setHeld(false);
    alignTo(curRef.current, "force");
  };

  const onTime = (t: number) => {
    clock.current = t;
    if (picking.current || Date.now() < hold.current) return;
    const i = sentenceAt(timesRef.current, t);
    setCur((c) => (c === i ? c : i));
  };
  const cache = lessonCache(yt.v);
  const switchSource = (next: SourceChoice) => {
    const reported = player.current?.getTime();
    const t = typeof reported === "number" && reported >= 0.4 ? reported : clock.current;
    setBootAt(Number.isFinite(t) ? t : (times[cur] ?? 0));
    saveChoice(yt.v, next);
    setPhase(next === "online" ? "loading" : "paused");
    setSource(next);
  };
  const chooseLocal = () => {
    if (cache.kind === "full") {
      switchSource("local");
      setAsked(false);
      return;
    }
    setAsked(true);
  };
  const playingCache = source === "local" && cache.kind === "full";
  const playDisabled = playingCache ? phase === "error" : phase === "embed" || phase === "missing" || phase === "error";

  const at = times[cur];
  const last = Math.max(0, doc.sentences.length - 1);
  return (
    <div className="vs" data-testid="video-study">
      <div className="vs-stage">
        <header className="vs-head">
          <h1>{lesson.title}</h1>
          <p>
            {yt.author ? `${yt.author} · ` : ""}
            {yt.kind === "asr" ? "自动字幕" : "人工字幕"}
            {" · "}
            <a href={watchUrl(yt.v, at ?? 0)} target="_blank" rel="noreferrer">
              在 YouTube 打开 {at != null ? clockOf(at) : ""} <ExternalLink size={12} />
            </a>
          </p>
        </header>
        {playingCache && cache.kind === "full" ? (
          <LocalPlayer key={cache.url} ref={player} src={cache.url} title={lesson.title} initial={bootAt} onTime={onTime} onPhase={setPhase} />
        ) : (
          <YoutubePlayer key="online" ref={player} videoId={yt.v} title={lesson.title} initial={bootAt} onTime={onTime} onPhase={setPhase} onUseLocal={chooseLocal} />
        )}
        {playingCache && (
          <p className="vs-local-name" data-testid="vs-local-name">
            本地 · 已缓存的整段
          </p>
        )}
        {asked && !playingCache && (
          <p className="vs-pick-note" data-testid="vs-local-offer">
            {cacheNote(cache.kind)}
          </p>
        )}
        {lines[cur] && (
          <div className="vs-now" data-testid="vs-now" data-sid={cur}>
            <SentRow
              sid={cur}
              tokens={lines[cur].tokens}
              active
              selFrom={sel && lines[cur].tokens.some((t) => t.i >= sel.from && t.i <= sel.to) ? sel.from : -1}
              selTo={sel && lines[cur].tokens.some((t) => t.i >= sel.from && t.i <= sel.to) ? sel.to : -1}
              stamp={stampOf(lines[cur].tokens, items, phraseAt)}
              timeLabel={times[cur] != null ? clockOf(times[cur]) : "–"}
              showTr={showTr}
              tr={tr[cur] ?? ""}
              itemsRef={itemsRef}
              phraseRef={phraseRef}
              bus={bus}
            />
          </div>
        )}
        <div className="vs-bar" role="group" aria-label="本句播放">
          <button type="button" onClick={() => step(-1)} disabled={cur <= 0} aria-label="上一句" data-testid="vs-prev">
            <SkipBack size={16} /> <span>上一句</span>
          </button>
          <button type="button" onClick={replay} aria-label="重播本句" data-testid="vs-replay">
            <RotateCcw size={16} /> <span>重播本句</span>
          </button>
          <button
            type="button"
            onClick={() => player.current?.toggle()}
            disabled={playDisabled}
            aria-label={phase === "playing" ? "暂停" : "播放"}
            data-testid="vs-play"
          >
            {phase === "playing" ? <Pause size={16} /> : <Play size={16} />} <span>{phase === "playing" ? "暂停" : "播放"}</span>
          </button>
          <button type="button" onClick={() => step(1)} disabled={cur >= last} aria-label="下一句" data-testid="vs-next">
            <SkipForward size={16} /> <span>下一句</span>
          </button>
          <button type="button" className={showTr ? "is-on" : ""} onClick={() => setShowTr((s) => !s)} aria-pressed={showTr} aria-label={showTr ? "隐藏中译" : "显示中译"} data-testid="vs-tr-toggle">
            <Languages size={16} /> <span>{showTr ? "隐藏中译" : "中译"}</span>
          </button>
          <div className="vs-source" role="tablist" aria-label="视频来源" data-testid="vs-source">
            <button
              type="button"
              role="tab"
              aria-selected={playingCache}
              aria-label="已缓存的整段视频"
              className={playingCache ? "is-on" : ""}
              onClick={chooseLocal}
              data-testid="vs-source-local"
            >
              本地
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={!playingCache}
              className={!playingCache ? "is-on" : ""}
              onClick={() => switchSource("online")}
              data-testid="vs-source-online"
            >
              在线
            </button>
          </div>
          <span className="vs-count">
            {cur + 1} / {doc.sentences.length}
          </span>
        </div>
        {hint && (
          <p className="vs-hint" data-testid="vs-hint">
            {hint}
          </p>
        )}
        <p className="vs-hint hide-touch">← → 上一句 / 下一句 · R 重播 · 空格播放 · T 中译 · 点词查释义，拖选短语</p>
      </div>
      <div className="vs-subs" ref={listRef} role="list" aria-label="字幕" data-testid="vs-subs" onScroll={onListScroll}>
        {held && (
          <button type="button" className="vs-return" onClick={backToCurrent} data-testid="vs-return">
            回到当前句
          </button>
        )}
        {lines.map((line) => {
          const hit = !!sel && line.tokens.length > 0 && sel.to >= line.tokens[0].i && sel.from <= line.tokens[line.tokens.length - 1].i;
          return (
            <SentRow
              key={line.sid}
              sid={line.sid}
              tokens={line.tokens}
              active={line.sid === cur}
              selFrom={hit && sel ? sel.from : -1}
              selTo={hit && sel ? sel.to : -1}
              stamp={stampOf(line.tokens, items, phraseAt)}
              timeLabel={times[line.sid] != null ? clockOf(times[line.sid]) : "–"}
              showTr={false}
              tr=""
              itemsRef={itemsRef}
              phraseRef={phraseRef}
              bus={bus}
            />
          );
        })}
      </div>
    </div>
  );
}
