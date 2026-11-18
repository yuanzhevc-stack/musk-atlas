/** YouTube IFrame Player. Reports the real clock; never substitutes another video. */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { clockOf, watchUrl } from "./youtube";

export type PlayerPhase = "loading" | "playing" | "paused" | "blocked" | "embed" | "missing" | "error";

export interface PlayerHandle {
  seek: (seconds: number) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
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
function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      loading = null;
      reject(new Error("yt-api"));
    }, 12000);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      window.clearTimeout(timer);
      prev?.();
      resolve();
    };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.async = true;
    s.onerror = () => {
      window.clearTimeout(timer);
      loading = null;
      reject(new Error("yt-api"));
    };
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
}>(function YoutubePlayer({ videoId, title, initial, end, nonce = 0, onTime, onPhase }, ref) {
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
  }));

  useEffect(() => {
    const parent = frame.current;
    if (!parent || !videoId) {
      setPh("missing");
      return;
    }
    let dead = false;
    let poll = 0;
    let blockedTimer = 0;
    let slowTimer = 0;
    const mount = document.createElement("div");
    mount.className = "vs-yt-host";
    parent.insertBefore(mount, parent.firstChild);
    setPh("loading");
    const armBlocked = () => {
      window.clearTimeout(blockedTimer);
      blockedTimer = window.setTimeout(() => {
        if (dead) return;
        const state = player.current?.getPlayerState?.();
        if (state === PLAYING || state === BUFFERING) return;
        if (phaseRef.current === "embed" || phaseRef.current === "missing" || phaseRef.current === "error") return;
        if (state === 2) setPh("paused");
        else setPh("blocked");
      }, 1400);
    };
    loadYouTubeApi()
      .then(() => {
        if (dead || !window.YT) return;
        slowTimer = window.setTimeout(() => {
          if (!dead && phaseRef.current === "loading") setPh("error", "YouTube 播放器没有就绪。");
        }, 10000);
        const endAt = end != null && end > initialRef.current ? Math.ceil(end) : undefined;
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
              if (dead) return;
              window.clearTimeout(slowTimer);
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
              if (dead) return;
              if (ev.data === PLAYING) {
                window.clearTimeout(blockedTimer);
                setPh("playing");
                window.clearInterval(poll);
                poll = window.setInterval(() => {
                  try {
                    const t = player.current?.getCurrentTime?.();
                    if (typeof t === "number" && Number.isFinite(t)) onTimeRef.current?.(t);
                  } catch {
                    /* destroyed */
                  }
                }, 250);
              } else if (ev.data === 2 || ev.data === 0) {
                window.clearInterval(poll);
                setPh("paused");
              }
            },
            onError: (ev: { data: number }) => {
              if (dead) return;
              window.clearInterval(poll);
              if (ev.data === 101 || ev.data === 150 || ev.data === 153) setPh("embed");
              else if (ev.data === 100) setPh("missing");
              else setPh("error", "YouTube 播放器没有把这个视频放出来。");
            },
          },
        });
      })
      .catch(() => {
        if (!dead) setPh("error", "YouTube 播放器没有加载成功。");
      });
    return () => {
      dead = true;
      window.clearInterval(poll);
      window.clearTimeout(blockedTimer);
      window.clearTimeout(slowTimer);
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
  }, [videoId, end, title]);

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
        <p className="vs-overlay vs-overlay-quiet" data-testid="yt-loading">
          正在连接 YouTube…
        </p>
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
          <a href={outbound} target="_blank" rel="noreferrer">
            在 YouTube 打开 {clockOf(at)}
          </a>
        </div>
      )}
    </div>
  );
});
