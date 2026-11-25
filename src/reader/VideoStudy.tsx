/** Video-first study: player and the lesson's own captions. Word taps reuse the reader card. */
import { BookMarked, BookOpen, Clock, Compass, Copy, Eye, EyeOff, Heart, Maximize, Mic, MoreHorizontal, Pause, Pencil, Play, Repeat, RotateCcw, Search, SkipBack, SkipForward } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Item, Lesson, Token } from "./model";
import { normalize, phraseIndex, reader } from "./model";
import { ecdict, translate } from "./dict";
import { LocalPlayer } from "./LocalPlayer";
import { saveChoice, type SourceChoice } from "./hostedLesson";
import { adoptReady, cacheStatusLine, forgetReady, fullMediaUrl, openingSource, readFullCache, rememberedJob, rememberedReady, retryFullCache, type CacheView } from "./fullCache";
import { DESK_MODES, MODE_LABEL, clipReached, dragPhrase, keptCaption, loopDecision, loopRange, nextSpeed, REPLAY_BLOCKED, rowDisclosure, rowPointer, selectedPhrase, showsChinese, type DeskMode, type RowDisclosure } from "./lessonDesk";
import { LessonPractice } from "./LessonPractice";
import { loadClip, recordingError, recorderSupport, saveClip } from "./lessonAudio";
import { readNote, writeNote } from "./lessonNotes";
import { centerScroll, followAllowed, lessonMedia, sentenceAt, sentenceSpan, shouldRecenter } from "./sync";
import { YoutubePlayer, type PlayerHandle, type PlayerPhase } from "./YoutubePlayer";
import { captionsToLesson, clockOf, fetchCaptions, sentenceCase, watchUrl } from "./youtube";
import { toast } from "../ui/Toast";

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
  disclosure: RowDisclosure;
  itemsRef: RefObject<Record<string, Item>>;
  phraseRef: RefObject<Map<number, { from: number; to: number; key: string }>>;
  bus: RefObject<Bus>;
}

interface Bus {
  jump: (sid: number) => void;
  down: (i: number, e: PointerEvent) => void;
  enter: (i: number) => void;
  clickWord: (i: number, e: MouseEvent) => void;
  consumed: () => boolean;
}

const SentRow = memo(
  function SentRow({ sid, tokens, active, selFrom, selTo, timeLabel, showTr, tr, disclosure, itemsRef, phraseRef, bus }: RowProps) {
    const follow = (e: PointerEvent<HTMLElement>) => {
      if (e.buttons !== 1 && e.type === "pointermove") return;
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const word = hit instanceof Element ? hit.closest<HTMLElement>("[data-ti]") : null;
      if (!word) return;
      bus.current?.enter(Number(word.dataset.ti));
    };
    return (
      <div className={`vs-sent ${active ? "is-on" : ""}`} role="listitem" data-vs={sid} aria-current={active ? "true" : undefined} data-testid="vs-sent" data-answer={disclosure}>
        <button type="button" className="vs-jump" onClick={() => bus.current?.jump(sid)} aria-label={`从第 ${sid + 1} 句播放`} data-testid="vs-jump">
          {timeLabel}
        </button>
        <div className="vs-copy">
        <div
          className="vs-line rd-text"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            const word = (e.target as HTMLElement).closest<HTMLElement>("[data-ti]");
            if (!word) return;
            e.stopPropagation();
            if (!e.shiftKey) {
              try {
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              } catch {
                /* the move handler still sees events that stay inside the line */
              }
            }
            bus.current?.down(Number(word.dataset.ti), e);
          }}
          onPointerMove={follow}
          onClick={(e) => {
            if (bus.current?.consumed()) {
              e.preventDefault();
              e.stopPropagation();
              return;
            }
            if ((e.target as HTMLElement).closest(".w")) return;
            bus.current?.jump(sid);
          }}
        >
          {disclosure !== "full" ? (
            <p className="desk-hidden">{disclosure === "answer-hidden" ? "这一句的答案先不放出来。" : "英文先不显示。"}</p>
          ) : tokens.map((t) => {
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
                onClick={(e) => bus.current?.clickWord(t.i, e)}
              >
                {t.text}
              </span>
            );
          })}
        </div>
          {disclosure !== "answer-hidden" && showTr && tr ? (
            <p className="vs-tr" data-testid="vs-tr">{tr}</p>
          ) : null}
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
    a.disclosure === b.disclosure &&
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
  const [mediaClock, setMediaClock] = useState(0);
  const [mediaDur, setMediaDur] = useState(0);
  const [tr, setTr] = useState<Record<number, string>>({});
  const [hint, setHint] = useState("");
  const [held, setHeld] = useState(false);
  const [source, setSource] = useState<SourceChoice>(() => openingSource(yt.v));
  const [mode, setMode] = useState<DeskMode>("both");
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    document.body.classList.add("is-study");
    return () => document.body.classList.remove("is-study");
  }, []);
  const [hideVideo, setHideVideo] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [loopOn, setLoopOn] = useState(false);
  const [pointA, setPointA] = useState<number | null>(null);
  const [intervalSec, setIntervalSec] = useState(0);
  const [pauseAfter, setPauseAfter] = useState(true);
  const [revealed, setRevealed] = useState(false);
  const [noteFor, setNoteFor] = useState<number | null>(null);
  const [noteText, setNoteText] = useState("");
  const [recNote, setRecNote] = useState("");
  const [clips, setClips] = useState<Record<number, string>>({});
  const [ipaOn, setIpaOn] = useState(false);
  const [ipaLine, setIpaLine] = useState("");
  const loopHold = useRef<{ at: number } | null>(null);
  const atEnd = useRef(false);
  const started = useRef(source);
  const pinnedOnline = useRef(false);
  const [job, setJob] = useState<CacheView | null>(() => rememberedJob(yt.v));
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
    atEnd.current = false;
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
    atEnd.current = false;
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
  const applyPhrase = (start: number, end: number) => {
    const phrase = dragPhrase(start, end);
    if (!phrase) return;
    anchor.current = phrase.from;
    setSel(phrase);
  };
  const bus = useRef<Bus>({
    jump,
    down(i, e) {
      e.stopPropagation();
      picking.current = true;
      if (e.button !== 0 || e.shiftKey) return;
      drag.current = { start: i, moved: false };
    },
    enter(i) {
      const d = drag.current;
      if (!d || i === d.start) return;
      d.moved = true;
      applyPhrase(d.start, i);
    },
    clickWord(i, e) {
      e.stopPropagation();
      e.preventDefault();
      if (drag.current?.moved || Date.now() - dragEnd.current < 400) return;
      if (e.shiftKey && anchor.current != null) applyPhrase(anchor.current, i);
      else {
        anchor.current = i;
        setSel({ from: i, to: i });
      }
    },
    consumed: () => drag.current?.moved === true || Date.now() - dragEnd.current < 400,
  });
  bus.current.jump = jump;
  bus.current.down = (i, e) => {
    e.stopPropagation();
    picking.current = true;
    if (e.button !== 0 || e.shiftKey) return;
    drag.current = { start: i, moved: false };
  };
  bus.current.enter = (i) => {
    const d = drag.current;
    if (!d || i === d.start) return;
    d.moved = true;
    applyPhrase(d.start, i);
  };
  bus.current.clickWord = (i, e) => {
    e.stopPropagation();
    e.preventDefault();
    if (drag.current?.moved || Date.now() - dragEnd.current < 400) return;
    if (e.shiftKey && anchor.current != null) applyPhrase(anchor.current, i);
    else {
      anchor.current = i;
      setSel({ from: i, to: i });
    }
  };
  bus.current.consumed = () => drag.current?.moved === true || Date.now() - dragEnd.current < 400;

  useEffect(() => {
    const up = () => {
      const gesture = drag.current;
      const intent = rowPointer({ word: gesture != null, dragged: gesture?.moved === true });
      if (intent === "lookup" && gesture) {
        dragEnd.current = Date.now();
        anchor.current = gesture.start;
        setSel({ from: gesture.start, to: gesture.start });
      } else if (intent === "keep") dragEnd.current = Date.now();
      picking.current = false;
      setTimeout(() => (drag.current = null), 0);
    };
    const onSelect = () => {
      const picked = document.getSelection();
      if (!picked || picked.isCollapsed || picked.rangeCount === 0) return;
      const node = picked.anchorNode instanceof Element ? picked.anchorNode : picked.anchorNode?.parentElement;
      if (!node || node.closest("input, textarea")) return;
      const line = node.closest(".vs-line");
      if (!line) return;
      const range = picked.getRangeAt(0);
      const ids = [...line.querySelectorAll<HTMLElement>("[data-ti]")].filter((el) => range.intersectsNode(el)).map((el) => Number(el.dataset.ti));
      const phrase = selectedPhrase(ids);
      if (!phrase) return;
      anchor.current = phrase.from;
      dragEnd.current = Date.now();
      setSel(phrase);
    };
    window.addEventListener("pointerup", up);
    document.addEventListener("selectionchange", onSelect);
    return () => {
      window.removeEventListener("pointerup", up);
      document.removeEventListener("selectionchange", onSelect);
    };
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
      else if (e.key === "t") setMode((m) => (m === "both" ? "en" : "both"));
      else if (e.key === " ") player.current?.toggle();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  useEffect(() => {
    setRevealed(false);
    loopHold.current = null;
  }, [cur, mode, loopOn, pointA]);

  useEffect(() => {
    if (!showsChinese(mode) || tr[cur] != null) return;
    let live = true;
    const at = cur;
    translate(doc.sentences[at] ?? "").then((text) => {
      if (!live) return;
      setTr((m) => ({ ...m, [at]: text ?? "没有取到译文。在线翻译没有返回，这里不会编造。" }));
    });
    return () => {
      live = false;
    };
  }, [mode, cur, doc.sentences, tr]);

  useEffect(() => {
    if (!showsChinese(mode)) return;
    let live = true;
    const pending = lines
      .map((line) => line.sid)
      .filter((sid) => tr[sid] == null)
      .sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur))
      .slice(0, 4);
    if (!pending.length) return;
    void (async () => {
      for (const sid of pending) {
        if (!live) return;
        const text = await translate(doc.sentences[sid] ?? "");
        if (!live) return;
        setTr((m) => (m[sid] != null ? m : { ...m, [sid]: text ?? "没有取到译文。在线翻译没有返回，这里不会编造。" }));
      }
    })();
    return () => {
      live = false;
    };
  }, [mode, cur, lines, tr, doc.sentences]);

  useEffect(() => {
    if (!ipaOn) return;
    let live = true;
    const words = lines[cur]?.tokens.flatMap((token) => (token.key ? [token.key] : [])) ?? [];
    void (async () => {
      const parts: string[] = [];
      for (const key of words.slice(0, 16)) {
        const hits = await ecdict(key).catch(() => []);
        const ipa = hits.find((hit) => hit.ipa)?.ipa;
        if (ipa) parts.push(`${key} ${ipa}`);
      }
      if (!live) return;
      setIpaLine(parts.length ? parts.join("  ·  ") : "词典里没有这一句的音标，这里不会编造。");
    })();
    return () => {
      live = false;
    };
  }, [ipaOn, cur, lines]);

  const bodyRef = useRef<HTMLDivElement>(null);
  const alignTo = (sid: number, mode: "force" | "follow") => {
    const list = listRef.current;
    const mark = list?.querySelector<HTMLElement>(`[data-vs="${sid}"]`);
    const row = mark?.closest<HTMLElement>(".desk-row") ?? mark;
    const line = row?.querySelector<HTMLElement>(".vs-line") ?? row;
    if (!list || !line || list.clientHeight < 40) return;
    if (mode === "follow" && !followAllowed({ picking: picking.current, cardOpen: selRef.current != null, userHold: heldRef.current })) return;
    const itemTop = list.scrollTop + (line.getBoundingClientRect().top - list.getBoundingClientRect().top);
    const next = centerScroll(list.clientHeight, list.scrollHeight, itemTop, line.offsetHeight);
    if (mode === "follow" && !shouldRecenter(list.scrollTop, next)) return;
    lastSet.current = next;
    ignoreScrollUntil.current = performance.now() + 720;
    programmatic.current = true;
    list.scrollTo({ top: next, behavior: mode === "force" ? "smooth" : "auto" });
    window.setTimeout(() => {
      programmatic.current = false;
    }, 720);
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
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || typeof ResizeObserver === "undefined") return;
    const obs = new ResizeObserver(() => {
      if (heldRef.current) return;
      alignTo(curRef.current, "follow");
    });
    obs.observe(body);
    return () => obs.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const holdList = () => {
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

  useEffect(() => {
    let live = true;
    const v = yt.v;
    const cased = lesson.text.split("\n").map((line) => sentenceCase(line)).join("\n");
    if (cased !== lesson.text) reader.updateLesson(lesson.id, { text: cased });
    void fetchCaptions(v)
      .then((c) => {
        if (!live) return;
        const next = captionsToLesson(c);
        if (!next.text.trim() || !next.times.length) return;
        const sameText = next.text === lesson.text;
        const sameTimes = next.times.length === yt.times.length && next.times.every((t, i) => t === yt.times[i]);
        if (sameText && sameTimes) return;
        const at = clock.current > 0.2 ? clock.current : (timesRef.current[curRef.current] ?? 0);
        reader.updateLesson(lesson.id, { text: next.text, yt: { ...yt, times: next.times, kind: c.kind, author: c.author ?? yt.author } });
        setTr({});
        setCur(sentenceAt(next.times, at));
      })
      .catch(() => {
        /* keep the stored lesson if captions cannot be refreshed */
      });
    return () => {
      live = false;
    };
  }, [lesson.id, yt.v]); // eslint-disable-line react-hooks/exhaustive-deps
  const onTime = (t: number) => {
    clock.current = t;
    setMediaClock((prev) => (Math.abs(prev - t) < 0.35 ? prev : t));
    const current = curRef.current;
    const times = timesRef.current;
    const looping = loopOn || pointA != null;
    const span = looping
      ? pointA != null && !loopOn
        ? loopRange(times, pointA, Math.max(pointA, current))
        : loopRange(times, current, current)
      : loopRange(times, current, current);
    if (looping && span) {
      const holding = loopHold.current != null;
      const decision = loopDecision({
        time: t,
        start: span.start,
        end: span.end,
        enabled: true,
        pauseAfter: false,
        intervalSec,
        holding,
        heldForSec: holding ? (Date.now() - loopHold.current!.at) / 1000 : 0,
      });
      if (decision.type === "hold" && !holding) {
        loopHold.current = { at: Date.now() };
        player.current?.pause();
      } else if (decision.type === "restart") {
        loopHold.current = null;
        atEnd.current = false;
        hold.current = Date.now() + 800;
        player.current?.seek(decision.at);
        player.current?.play();
      }
    } else if (pauseAfter && span && clipReached(t, span.start, span.end)) {
      atEnd.current = true;
      player.current?.pause();
    } else if (t < (span?.end ?? 0) - 0.25) atEnd.current = false;
    if (picking.current || Date.now() < hold.current) return;
    const follow = !looping && !pauseAfter;
    const i = keptCaption(current, sentenceAt(times, t), follow);
    if (!follow) return;
    setCur((c) => (c === i ? c : i));
  };
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const next = await readFullCache(yt.v);
      if (stop) return;
      setJob(next);
      const now = phaseRef.current;
      const phaseKind = now === "loading" || now === "playing" || now === "paused" ? now : "other";
      const decision = adoptReady(started.current, phaseKind, next.verified, rememberedReady(yt.v) != null);
      if (decision === "online") setSource("online");
      else if (decision === "local" && !pinnedOnline.current) setSource("local");
    };
    void tick();
    const id = window.setInterval(() => void tick(), 10_000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [yt.v]);
  const readyUrl = (job?.verified ? job.url : rememberedReady(yt.v)?.url) ?? "";
  const playingCache = source === "local" && readyUrl === fullMediaUrl(yt.v);
  const switchSource = (next: SourceChoice) => {
    pinnedOnline.current = next === "online";
    const reported = player.current?.getTime();
    const t = typeof reported === "number" && reported >= 0.4 ? reported : clock.current;
    setBootAt(Number.isFinite(t) ? t : (times[cur] ?? 0));
    saveChoice(yt.v, next);
    setPhase(next === "online" ? "loading" : "paused");
    setSource(next);
  };
  const chooseLocal = () => {
    if (playingCache || job?.verified) {
      switchSource("local");
      return;
    }
  };
  const playDisabled = playingCache ? phase === "error" : phase === "embed" || phase === "missing" || phase === "error";
  const cacheLine = phase === "error" && source === "local" ? "缓存文件没有打开。可以改用在线。" : playingCache ? "本地 · 已缓存的整段" : cacheStatusLine(job, false);

  useEffect(() => {
    player.current?.setRate(speed);
  }, [speed, source, playingCache]);
  useEffect(() => {
    if (source === "local" && phase === "error") forgetReady(yt.v);
  }, [source, phase, yt.v]);
  useEffect(() => {
    let live = true;
    void loadClip(lesson.id, cur).then((url) => {
      if (live && url) setClips((prev) => (prev[cur] ? prev : { ...prev, [cur]: url }));
    });
    return () => {
      live = false;
    };
  }, [lesson.id, cur]);

  const at = times[cur];
  const last = Math.max(0, doc.sentences.length - 1);
  const lessonKeys = useMemo(() => new Set(all.flatMap((token) => (token.key ? [token.key] : []))), [all]);
  const q = query.trim().toLowerCase();
  const visible = q ? lines.filter((line) => line.text.toLowerCase().includes(q) || (tr[line.sid] ?? "").toLowerCase().includes(q)) : lines;
  const practice = mode === "dictation" || mode === "cloze" || mode === "zh2en" || mode === "cards";
  const showZh = showsChinese(mode);
  const stageRef = useRef<HTMLDivElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const copySentence = (text: string) => {
    const done = () => toast("已复制这一句", "ok");
    if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(text).then(done, () => toast("没有复制成功", "warn"));
    else toast("这台浏览器不能复制", "warn");
  };
  const favoriteSentence = (sid: number, text: string) => {
    const saved = reader.toggleSentence(text, { lesson: lesson.id, title: lesson.title, sid, sentence: text, media: lessonMedia(lesson.yt, sid) });
    toast(saved ? "已收藏到语料库" : "已取消收藏", "ok");
  };
  const openNote = (sid: number, text: string) => {
    setNoteFor(sid);
    setNoteText(readNote(lesson.id, sid) || items[normalize(text)]?.notes || "");
  };
  const saveOpenNote = () => {
    if (noteFor == null) return;
    writeNote(lesson.id, noteFor, noteText);
    const text = doc.sentences[noteFor] ?? "";
    if (items[normalize(text)]?.kind === "sentence") reader.upsert(text, { notes: noteText.trim() });
    toast("笔记已留在这台设备", "ok");
  };
  const recordSentence = async (sid: number) => {
    if (recorder.current) {
      recorder.current.stop();
      return;
    }
    if (recorderSupport() !== "ready") {
      setRecNote("这台浏览器不能录音。");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        recorder.current = null;
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        void saveClip(lesson.id, sid, blob).then((url) => setClips((prev) => ({ ...prev, [sid]: url })));
        setRecNote("录音只保存在这台设备，没有上传。");
      };
      recorder.current = rec;
      rec.start();
      setRecNote("正在录音。再点一次麦克风结束。");
    } catch (error) {
      setRecNote(recordingError(error) === "denied" ? "没有获得麦克风权限，录音没有开始。" : "这台浏览器不能在这里录音。");
    }
  };
  const row = (line: (typeof lines)[number], inTranscript: boolean) => {
    const hit = !!sel && line.tokens.length > 0 && sel.to >= line.tokens[0].i && sel.from <= line.tokens[line.tokens.length - 1].i;
    const disclosure = rowDisclosure(mode, revealed, line.sid === cur, inTranscript);
    return (
      <div key={line.sid} className={`desk-row${inTranscript && line.sid === cur ? " is-current" : ""}`}>
        {inTranscript && <span className="desk-num">{line.sid + 1}</span>}
        <SentRow
          sid={line.sid}
          tokens={line.tokens}
          active={line.sid === cur}
          selFrom={hit && sel ? sel.from : -1}
          selTo={hit && sel ? sel.to : -1}
          stamp={stampOf(line.tokens, items, phraseAt)}
          timeLabel={(() => {
            const span = sentenceSpan(times, line.sid);
            return span ? `${clockOf(span.t)} - ${clockOf(span.e)}` : "–";
          })()}
          showTr={showZh && disclosure !== "answer-hidden"}
          tr={disclosure === "answer-hidden" ? "" : (tr[line.sid] ?? (showZh ? "正在取译文…" : ""))}
          disclosure={disclosure}
          itemsRef={itemsRef}
          phraseRef={phraseRef}
          bus={bus}
        />
        {inTranscript && (
          <div className="desk-row-actions">
            <button type="button" aria-label="复制这一句" onClick={() => copySentence(line.text)}><Copy size={14} /></button>
            <button type="button" aria-label="收藏这一句" onClick={() => favoriteSentence(line.sid, line.text)}><Heart size={16} /></button>
            <button type="button" aria-label="给这一句写笔记" onClick={() => openNote(line.sid, line.text)}><Pencil size={16} /></button>
            <button type="button" aria-label="录下自己的声音" onClick={() => void recordSentence(line.sid)}><Mic size={14} /></button>
            <button type="button" aria-label="播放这一句" onClick={() => jump(line.sid)}><Play size={14} /></button>
            {clips[line.sid] && <audio src={clips[line.sid]} controls preload="none" data-testid="sentence-audio" />}
          </div>
        )}
      </div>
    );
  };
  const bound = pauseAfter && !loopOn && pointA == null ? loopRange(times, cur, cur) : null;
  return createPortal(
    <div className={`desk ${mode === "read" ? "is-read" : ""}`} data-testid="video-study">
      <header className="desk-top">
        <a className="desk-back" href="#/reader" aria-label="返回课程">‹</a>
        <h1>{lesson.title}</h1>
        <div className="desk-source" role="tablist" aria-label="视频来源" data-testid="vs-source">
          <button type="button" role="tab" aria-selected={playingCache} aria-label="已缓存的整段视频" className={playingCache ? "is-on" : ""} onClick={chooseLocal} data-testid="vs-source-local">本地</button>
          <button type="button" role="tab" aria-selected={!playingCache} className={!playingCache ? "is-on" : ""} onClick={() => switchSource("online")} data-testid="vs-source-online">在线</button>
        </div>
      </header>
      <div className="desk-split">
      <div className="vs-stage" ref={stageRef}>
        <div className={hideVideo ? "desk-frame is-collapsed" : "desk-frame"}>
        {playingCache ? (
          <LocalPlayer key={readyUrl} ref={player} src={readyUrl} title={lesson.title} initial={bootAt} clip={bound} onTime={onTime} onPhase={setPhase} onDuration={setMediaDur} rate={speed} />
        ) : (
          <YoutubePlayer key="online" ref={player} videoId={yt.v} title={lesson.title} initial={bootAt} clip={bound} onTime={onTime} onPhase={setPhase} onDuration={setMediaDur} onUseLocal={chooseLocal} rate={speed} />
        )}
        {!hideVideo && <button type="button" className="desk-replay" aria-label="重播这一句" data-testid="desk-replay" onClick={replay} />}
        {!hideVideo && (
          <div className="desk-progress">
            <span>{clockOf(mediaClock)}</span>
            <button
              type="button"
              className="desk-progress-track"
              aria-label="跳到这一句"
              onClick={(e) => {
                if (!(mediaDur > 0)) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
                jump(sentenceAt(times, ratio * mediaDur));
              }}
            >
              <i style={{ width: `${mediaDur > 0 ? Math.min(100, (mediaClock / mediaDur) * 100) : 0}%` }} />
            </button>
            <span>{mediaDur > 0 ? clockOf(mediaDur) : "–"}</span>
          </div>
        )}
        {loopOn && !hideVideo && (
          <button type="button" className="desk-chip" onClick={() => setLoopOn(false)}>循环之后暂停 ×</button>
        )}
        </div>
        <div className="desk-tools" role="group" aria-label="本句播放">
          <button type="button" onClick={() => setSpeed((n) => nextSpeed(n))} aria-label="播放速度" data-testid="desk-speed"><span className="desk-glyph">{speed === 1 ? "1×" : `${speed}×`}</span><span>倍速</span></button>
          <button type="button" className={hideVideo ? "is-on" : ""} onClick={() => setHideVideo((v) => !v)} aria-pressed={hideVideo} aria-label={hideVideo ? "显示视频" : "隐藏视频"}>{hideVideo ? <Eye size={18} /> : <EyeOff size={18} />}<span>隐藏视频</span></button>
          <button type="button" onClick={() => { const node = stageRef.current; if (!node) return; if (document.fullscreenElement) void document.exitFullscreen(); else void node.requestFullscreen?.(); }} aria-label="全屏"><Maximize size={18} /><span>全屏</span></button>
          <button type="button" className={ipaOn ? "is-on" : ""} aria-pressed={ipaOn} onClick={() => setIpaOn((v) => !v)} aria-label="音标" data-testid="desk-ipa"><span className="desk-glyph">æ</span><span>音标</span></button>
          <button type="button" onClick={() => step(-1)} disabled={cur <= 0} aria-label="上一句" data-testid="vs-prev"><SkipBack size={18} /><span>上一句</span></button>
          <button type="button" className="desk-play" onClick={() => { if (atEnd.current) replay(); else player.current?.toggle(); }} disabled={playDisabled} aria-label={phase === "playing" ? "暂停" : "播放"} data-testid="vs-play">{phase === "playing" ? <Pause size={18} /> : <Play size={18} />}<span>{phase === "playing" ? "暂停" : "播放"}</span></button>
          <button type="button" onClick={() => step(1)} disabled={cur >= last} aria-label="下一句" data-testid="vs-next"><SkipForward size={18} /><span>下一句</span></button>
          <button type="button" className={pointA != null ? "is-on" : ""} aria-pressed={pointA != null} onClick={() => setPointA((a) => (a === cur ? null : cur))} aria-label="设置 A 点" data-testid="desk-a"><span className="desk-glyph">A</span><span>A点</span></button>
          <button type="button" className={loopOn ? "is-on" : ""} aria-pressed={loopOn} onClick={() => setLoopOn((v) => !v)} aria-label="单句循环" data-testid="desk-loop"><Repeat size={18} /><span>单句循环</span></button>
          <label className="desk-tool desk-interval">
            <Clock size={16} />
            <input type="number" min={0} max={15} step={1} value={intervalSec} onChange={(e) => setIntervalSec(Math.max(0, Math.min(15, Number(e.target.value) || 0)))} aria-label="循环间隔秒数" data-testid="desk-interval" />
            <span>间隔</span>
          </label>
          <button type="button" className={pauseAfter ? "is-on" : "is-off"} aria-pressed={pauseAfter} onClick={() => setPauseAfter((v) => !v)} data-testid="desk-pause"><RotateCcw size={16} />{!pauseAfter && <em className="desk-off">OFF</em>}<span>单句暂停</span></button>
        </div>
        {!playingCache && job && (job.status !== "unknown" || job.runner === "unreachable") && (
          <p className="desk-cache" data-testid={phase === "error" ? "vs-local-name" : "vs-cache-status"}>
            {cacheLine}
            {job.runner === "unreachable" || job.status === "unknown" || (job.status === "failed" && job.error !== "retry-cap") ? (
              <button type="button" data-testid="cache-retry" onClick={() => void retryFullCache(yt.v).then(setJob)}>再试一次</button>
            ) : null}
          </p>
        )}
        <div className="desk-sheet" onClick={(e) => { if ((e.target as HTMLElement).closest(REPLAY_BLOCKED)) return; replay(); }}>
        {lines[cur] && mode !== "cards" && mode !== "cloze" && !(mode === "zh2en" && !revealed) && !(mode === "dictation" && !revealed) && (
          <div className="vs-now" data-testid="vs-now" data-sid={cur}>
            {row(lines[cur], false)}
          </div>
        )}
        {!lines[cur] && <p className="desk-wait">等待字幕出现</p>}
        {practice && (
          <LessonPractice
            mode={mode}
            sentence={doc.sentences[cur] ?? ""}
            translation={tr[cur] ?? ""}
            lessonId={lesson.id}
            items={items}
            keys={lessonKeys}
            revealed={revealed}
            onReveal={() => setRevealed((v) => !v)}
          />
        )}
        {ipaOn && <p className="desk-ipa" data-testid="desk-ipa-line">{ipaLine || "词典里没有这一句的音标。"}</p>}
        {recNote && <p className="desk-note" data-testid="rec-note">{recNote}</p>}
        {noteFor != null && (
          <form className="desk-note-form" onSubmit={(e) => { e.preventDefault(); saveOpenNote(); }}>
            <label>第 {noteFor + 1} 句的笔记
              <textarea value={noteText} onChange={(e) => setNoteText(e.target.value)} rows={3} data-testid="sentence-note" />
            </label>
            <button type="submit">保存笔记</button>
          </form>
        )}
        {hint && <p className="vs-hint" data-testid="vs-hint">{hint}</p>}
        <details className="desk-details">
          <summary>来源</summary>
          <p>{cacheLine} · {cur + 1}/{doc.sentences.length}</p>
          <p><a href={watchUrl(yt.v, at ?? 0)} target="_blank" rel="noreferrer">在 YouTube 打开</a></p>
        </details>
        </div>
      </div>
      <div className="desk-transcript">
      <div className="desk-transcript-top">
        <div className="desk-modes" role="tablist" aria-label="学习模式">
          {DESK_MODES.map((id) => (
            <button key={id} type="button" role="tab" aria-selected={mode === id} className={mode === id ? "is-on" : ""} onClick={() => setMode(id)} data-testid={id === "both" ? "vs-tr-toggle" : `mode-${id}`}>
              {MODE_LABEL[id]}
            </button>
          ))}
        </div>
        <button type="button" className="desk-more" aria-label="更多" aria-expanded={menu} onClick={() => setMenu((v) => !v)}><MoreHorizontal size={16} /></button>
        {menu && (
          <div className="desk-menu" role="menu">
            <a href="#/reader" role="menuitem"><BookOpen size={14} /> 课程</a>
            <a href="#/corpus" role="menuitem"><BookMarked size={14} /> 语料</a>
            <a href="#/today" role="menuitem"><Compass size={14} /> 今日</a>
            <button type="button" role="menuitem" onClick={() => window.dispatchEvent(new Event("musk-atlas:lookup"))}><Search size={14} /> 查词</button>
            <button type="button" role="menuitem" onClick={() => window.dispatchEvent(new Event("musk-atlas:study-read"))}>阅读文本</button>
            <a href={watchUrl(yt.v, at ?? 0)} target="_blank" rel="noreferrer" role="menuitem">在 YouTube 打开</a>
          </div>
        )}
      </div>
      <label className="desk-search">
        <Search size={14} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索英文字幕" aria-label="搜索字幕" data-testid="transcript-search" />
      </label>
      <div className="vs-subs" ref={listRef} role="list" aria-label="字幕" data-testid="vs-subs" onWheel={holdList} onTouchMove={holdList} onPointerDown={holdList}>
        {held && <button type="button" className="vs-return" onClick={backToCurrent} data-testid="vs-return">回到当前句</button>}
        <div ref={bodyRef}>
        <div className="lyric-pad" aria-hidden="true" />
        {visible.map((line) => row(line, true))}
        {!visible.length && <p className="desk-empty">没有符合搜索的句子。</p>}
        <div className="lyric-pad" aria-hidden="true" />
        </div>
      </div>
      </div>
      </div>
    </div>,
    document.body,
  );
}
