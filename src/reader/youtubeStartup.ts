/** Whole startup, from script load through onReady. One budget, not stacked timers. */
export const YOUTUBE_STARTUP_MS = 8000;

/** Does not claim the viewer's network failed. The in-page player simply did not become ready. */
export const YOUTUBE_STARTUP_MESSAGE =
  "页内的 YouTube 播放器没有在限定时间内就绪。可以重试，选择本机视频，或到 YouTube 打开。";

export type StartupPhase = "loading" | "playing" | "paused" | "blocked" | "embed" | "missing" | "error";

/** A late ready or timeout must not replace a failure, a finished start, or another source. */
export function youtubeEventAllowed(phase: StartupPhase, event: "ready" | "timeout" | "state" | "failure"): boolean {
  if (event === "ready" || event === "timeout") return phase === "loading";
  if (event === "failure") return phase === "loading" || phase === "playing" || phase === "paused" || phase === "blocked";
  return phase === "loading" || phase === "playing" || phase === "paused" || phase === "blocked";
}
