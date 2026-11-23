/** Playback sync for video study. Pure helpers so sentence highlighting does not depend on the player. */
import type { MediaRef } from "./model";

export type { MediaRef };

/** Last sentence whose start is <= t. Times are non-decreasing seconds. */
export function sentenceAt(times: number[], t: number): number {
  if (!times.length || !Number.isFinite(t)) return 0;
  let lo = 0;
  let hi = times.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = times[mid];
    if (typeof start === "number" && start <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** [start, end] of one caption sentence. End is the next start, otherwise start+6, and never more than 30s. */
export function sentenceSpan(times: number[], sid: number): { t: number; e: number } | null {
  const t = times[sid];
  if (t == null || !Number.isFinite(t)) return null;
  const next = times.slice(sid + 1).find((x) => typeof x === "number" && x > t);
  return { t, e: Math.min(next ?? t + 6, t + 30) };
}

/** YouTube source stored on a new corpus item. Undefined when this sentence has no timestamp. */
export function lessonMedia(yt: { v: string; times: number[] } | undefined, sid: number): MediaRef | undefined {
  if (!yt?.v) return undefined;
  const span = sentenceSpan(yt.times, sid);
  if (!span) return undefined;
  return { kind: "youtube", v: yt.v, t: span.t, e: span.e };
}

export type SourcePlan =
  | { type: "none" }
  | { type: "tts" }
  | { type: "musk"; v: string; t: number }
  | { type: "youtube"; v: string; t: number; e: number };

type PlanCtx = {
  lesson?: string;
  sid?: number;
  sentence?: string;
  musk?: { v: string; t: number };
  media?: { kind?: string; v?: string; t?: number; e?: number };
} | null | undefined;

/** Which real source can play this saved item. Does not invent a clip. */
export function sourcePlan(ctx: PlanCtx, lesson: { id: string; yt?: { v: string; times: number[] } } | undefined): SourcePlan {
  if (!ctx) return { type: "none" };
  if (ctx.musk?.v) return { type: "musk", v: ctx.musk.v, t: ctx.musk.t };
  if (lesson && lesson.id === ctx.lesson && lesson.yt?.v) {
    const span = sentenceSpan(lesson.yt.times, ctx.sid ?? -1);
    if (span) return { type: "youtube", v: lesson.yt.v, t: span.t, e: span.e };
  }
  const m = ctx.media;
  if (m?.kind === "youtube" && m.v && m.t != null && Number.isFinite(m.t)) {
    const t = m.t;
    const e = m.e != null && Number.isFinite(m.e) && m.e > t ? Math.min(m.e, t + 30) : t + 8;
    return { type: "youtube", v: m.v, t, e };
  }
  if (ctx.sentence) return { type: "tts" };
  return { type: "none" };
}

/** Only a voiceprint label of "musk" is a confirmed Musk line. */
export const isConfirmedMusk = (m: string | null | undefined) => m === "musk";

/**
 * Scroll offset that places a row near the vertical center of a transcript pane.
 * Coordinates are inside the scrolling content, not the page.
 */
export function centerScroll(viewHeight: number, contentHeight: number, itemTop: number, itemHeight: number): number {
  if (!(viewHeight > 0) || contentHeight <= viewHeight) return 0;
  const raw = itemTop - (viewHeight - Math.min(itemHeight, viewHeight)) / 2;
  const max = Math.max(0, contentHeight - viewHeight);
  return Math.max(0, Math.min(max, raw));
}

/**
 * Scroll offset that places a row on the lyric focus line.
 * Focus 0.38 keeps the current line above center, with the next lines still visible.
 */
export function lyricScroll(viewHeight: number, contentHeight: number, itemTop: number, itemHeight: number, focus = 0.38): number {
  if (!(viewHeight > 0) || contentHeight <= viewHeight) return 0;
  const raw = itemTop - viewHeight * focus + Math.min(itemHeight, viewHeight) / 2;
  const max = Math.max(0, contentHeight - viewHeight);
  return Math.max(0, Math.min(max, raw));
}

/** True when the pane should move. A line already near the center stays put. */
export function shouldRecenter(current: number, target: number, slack = 28): boolean {
  return Math.abs(current - target) > slack;
}

/** Playback may move the transcript. A drag, an open word card, or a recent manual scroll holds it. */
export function followAllowed(opts: { picking: boolean; cardOpen: boolean; userHold: boolean }): boolean {
  return !opts.picking && !opts.cardOpen && !opts.userHold;
}

/** Last word whose start is <= t, or -1 before the first word. */
export function wordAt(starts: number[], t: number): number {
  if (!starts.length || !Number.isFinite(t)) return -1;
  let lo = 0;
  let hi = starts.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = starts[mid];
    if (typeof start === "number" && start <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}
