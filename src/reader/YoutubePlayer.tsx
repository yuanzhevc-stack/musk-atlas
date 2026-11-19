/** YouTube IFrame Player. Reports the real clock; never substitutes another video. */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { YOUTUBE_STARTUP_MESSAGE, YOUTUBE_STARTUP_MS, youtubeEventAllowed, type StartupPhase } from "./youtubeStartup";
import { clockOf, watchUrl } from "./youtube";

export type PlayerPhase = StartupPhase;

export interface PlayerHandle {
  seek: (seconds: number) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  getTime: () => number;
}

interface YTPlayer {
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  getCurrentTime: () => number;
  getPlayerState: () => number;
  destroy: () => void;
}

declare global {
  interface Window {
    YT?: { Player: new (el: HTMLElement, opts: object) => YTPlayer };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let loading: Promise<void> | null = null;
let loadGen = 0;
function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (loading) return loading;
  const gen = ++loadGen;
  loading = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled || gen !== loadGen) return;
      settled = true;
      window.clearTimeout(timer);
      if (ok && window.YT?.Player) resolve();
      else {
        loading = null;
        reject(new Error("yt-api"));
      }
    };
    const timer = window.setTimeout(() => finish(false), YOUTUBE_STARTUP_MS);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      finish(true);
    };
    if (document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) return;
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.async = true;
    s.onerror = () => finish(false);
    document.head.appendChild(s);
  });
  return loading;
}

const PLAYING = 1;
const BUFFERING = 3;

export const YoutubePlayer = forwardRef<PlayerHandle, {
  videoId: string;
  title: string;
  /** Where playback starts when the player is created or replayed. */
  initial: number;
  /** Stop here when set (a single saved sentence). Omit for a full lesson. */
  end?: number;
  nonce?: number;
  /** Called with the video clock. Parents should ignore calls that do not change the sentence. */
  onTime?: (seconds: number) => void;
  onPhase?: (phase: PlayerPhase) => void;
  /** Leave the embed and pick a downloaded file. Omitted where there is no lesson file. */
  onUseLocal?: () => void;
}>(function YoutubePlayer({ videoId, title, initial, end, nonce = 0, onTime, onPhase, onUseLocal }, ref) {
  const frame = useRef<HTMLDivElement>(null);
  const player = useRef<YTPlayer | null>(null);
  const initialRef = useRef(initial);
  const seenInitial = useRef(initial);
  if (seenInitial.current !== initial) {
    seenInitial.current = initial;
    initialRef.current = initial;
  }
  const onTimeRef = useRef(onTime);
  const onPhaseRef = useRef(onPhase);
  const phaseRef = useRef<PlayerPhase>("loading");
  const [phase, setPhase] = useState<PlayerPhase>("loading");
  const [detail, setDetail] = useState("");
  const [attempt, setAttempt] = useState(0);
  onTimeRef.current = onTime;
  onPhaseRef.current = onPhase;

  const setPh = (next: PlayerPhase, text = "") => {
    phaseRef.current = next;
    setPhase(next);
    if (text) setDetail(text);
    onPhaseRef.current?.(next);
  };

  useImperativeHandle(ref, () => ({
    seek(seconds: number) {
      initialRef.current = seconds;
      try {
        player.current?.seekTo(seconds, true);
      } catch {
        /* player not ready */
      }
    },
    play() {
      try {
        player.current?.playVideo();
      } catch {
        /* player not ready */
      }
    },
    pause() {
      try {
        player.current?.pauseVideo();
      } catch {
        /* player not ready */
      }
    },
    toggle() {
      const state = player.current?.getPlayerState?.();
      if (state === PLAYING || state === BUFFERING) player.current?.pauseVideo();
      else player.current?.playVideo();
    },
    getTime() {
      try {
        const t = player.current?.getCurrentTime?.();
        if (typeof t === "number" && Number.isFinite(t)) return t;
      } catch {
        /* destroyed */
      }
      return initialRef.current;
    },
  }));

  useEffect(() => {
    const parent = frame.current;
    if (!parent || !videoId) {
      setPh("missing");
      return;
    }
    let alive = true;
    let poll = 0;
    let blockedTimer = 0;
    const mount = document.createElement("div");
    mount.className = "vs-yt-host";
    parent.insertBefore(mount, parent.firstChild);
    setPh("loading");
    const apply = (next: PlayerPhase, event: "ready" | "timeout" | "state" | "failure", text = "") => {
      if (!alive || !youtubeEventAllowed(phaseRef.current, event)) return;
      setPh(next, text);
    };
    const watchdog = window.setTimeout(() => apply("error", "timeout", YOUTUBE_STARTUP_MESSAGE), YOUTUBE_STARTUP_MS);
    const armBlocked = () => {
      window.clearTimeout(blockedTimer);
      blockedTimer = window.setTimeout(() => {
        if (!alive) return;
        const state = player.current?.getPlayerState?.();
        if (state === PLAYING || state === BUFFERING) return;
        if (!youtubeEventAllowed(phaseRef.current, "state")) return;
        if (state === 2) apply("paused", "state");
        else apply("blocked", "state");
      }, 1400);
    };
    loadYouTubeApi()
      .then(() => {
        if (!alive) return;
        if (!window.YT?.Player) {
          apply("error", "timeout", YOUTUBE_STARTUP_MESSAGE);
          return;
        }
        const endAt = end != null && end > initialRef.current ? Math.ceil(end) : undefined;
        try {
          player.current = new window.YT.Player(mount, {
            host: "https://www.youtube-nocookie.com",
            videoId,
            playerVars: {
              start: Math.max(0, Math.floor(initialRef.current)),
              ...(endAt != null ? { end: endAt } : {}),
              autoplay: 1,
              playsinline: 1,
              rel: 0,
              modestbranding: 1,
              cc_load_policy: 0,
              origin: location.origin,
            },
            events: {
              onReady: (ev: { target: YTPlayer }) => {
                if (!alive || !youtubeEventAllowed(phaseRef.current, "ready")) {
                  try {
                    ev.target.destroy();
                  } catch {
                    /* already gone */
                  }
                  return;
                }
                window.clearTimeout(watchdog);
                player.current = ev.target;
                const iframe = parent.querySelector("iframe");
                iframe?.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture");
                iframe?.setAttribute("title", title);
                try {
                  ev.target.seekTo(initialRef.current, true);
                  ev.target.playVideo();
                } catch {
                  /* autoplay or seek rejected */
                }
                armBlocked();
              },
              onStateChange: (ev: { data: number }) => {
                if (!alive || !youtubeEventAllowed(phaseRef.current, "state")) return;
                if (ev.data === PLAYING) {
                  window.clearTimeout(blockedTimer);
                  window.clearTimeout(watchdog);
                  apply("playing", "state");
                  window.clearInterval(poll);
                  poll = window.setInterval(() => {
                    if (!alive) return;
                    try {
                      const t = player.current?.getCurrentTime?.();
                      if (typeof t === "number" && Number.isFinite(t)) onTimeRef.current?.(t);
                    } catch {
                      /* destroyed */
                    }
                  }, 250);
                } else if (ev.data === 2 || ev.data === 0) {
                  window.clearInterval(poll);
                  apply("paused", "state");
                }
              },
              onError: (ev: { data: number }) => {
                if (!alive || !youtubeEventAllowed(phaseRef.current, "failure")) return;
                window.clearInterval(poll);
                window.clearTimeout(watchdog);
                if (ev.data === 101 || ev.data === 150 || ev.data === 153) apply("embed", "failure");
                else if (ev.data === 100) apply("missing", "failure");
                else apply("error", "failure", "YouTube 播放器没有把这个视频放出来。");
              },
            },
          });
        } catch {
          apply("error", "timeout", YOUTUBE_STARTUP_MESSAGE);
        }
      })
      .catch(() => {
        if (alive) apply("error", "timeout", YOUTUBE_STARTUP_MESSAGE);
      });
    return () => {
      alive = false;
      window.clearInterval(poll);
      window.clearTimeout(blockedTimer);
      window.clearTimeout(watchdog);
      try {
        player.current?.destroy();
      } catch {
        /* already gone */
      }
      player.current = null;
      mount.remove();
      parent.querySelectorAll("iframe").forEach((node) => node.remove());
    };
    // `initial` is read through a ref so a sentence change does not rebuild the iframe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, end, title, attempt]);

  useEffect(() => {
    if (!nonce || !player.current) return;
    try {
      player.current.seekTo(initialRef.current, true);
      player.current.playVideo();
    } catch {
      /* not ready */
    }
  }, [nonce]);

  const at = Math.max(0, initial);
  const outbound = watchUrl(videoId, at);
  return (
    <div className="vs-frame" ref={frame} data-testid="yt-player">
      {phase === "loading" && (
        <div className="vs-overlay vs-overlay-quiet" data-testid="yt-loading">
          <p>正在连接 YouTube…</p>
          <div className="vs-overlay-actions">
            {onUseLocal && (
              <button type="button" onClick={onUseLocal} data-testid="yt-use-local">
                看本地缓存
              </button>
            )}
            <a href={outbound} target="_blank" rel="noreferrer">
              在 YouTube 打开 {clockOf(at)}
            </a>
          </div>
        </div>
      )}
      {phase === "blocked" && (
        <div className="vs-overlay" data-testid="yt-blocked">
          <p>浏览器拦截了自动播放。</p>
          <button type="button" onClick={() => player.current?.playVideo()} data-testid="yt-manual">
            点击播放
          </button>
        </div>
      )}
      {phase === "embed" && (
        <div className="vs-overlay" data-testid="yt-embed-blocked">
          <p>YouTube 拒绝了页内播放。可能是这个视频不允许嵌入，也可能是要求登录验证。这里不会改播别的视频。</p>
          <a href={outbound} target="_blank" rel="noreferrer">
            在 YouTube 打开 {clockOf(at)}
          </a>
        </div>
      )}
      {phase === "missing" && (
        <div className="vs-overlay" data-testid="yt-missing">
          <p>找不到这个视频。</p>
          <a href={outbound} target="_blank" rel="noreferrer">
            在 YouTube 打开
          </a>
        </div>
      )}
      {phase === "error" && (
        <div className="vs-overlay" data-testid="yt-error">
          <p>{detail || "页内播放没有成功。"}</p>
          <div className="vs-overlay-actions">
            <button type="button" onClick={() => setAttempt((n) => n + 1)} data-testid="yt-retry">
              重试
            </button>
            {onUseLocal && (
              <button type="button" onClick={onUseLocal} data-testid="yt-use-local">
                看本地缓存
              </button>
            )}
            <a href={outbound} target="_blank" rel="noreferrer">
              在 YouTube 打开 {clockOf(at)}
            </a>
          </div>
        </div>
      )}
    </div>
  );
});
