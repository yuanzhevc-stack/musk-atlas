import { useEffect, useRef } from "react";

/** Minimal typing for the bits of the YouTube IFrame API we use. */
interface YTPlayer {
  getCurrentTime(): number;
  pauseVideo(): void;
  getPlayerState(): number;
  destroy(): void;
}
declare global {
  interface Window {
    YT?: { Player: new (el: HTMLIFrameElement, opts: object) => YTPlayer };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let api: Promise<void> | null = null;
function loadApi() {
  api ??= new Promise<void>((resolve, reject) => {
    if (window.YT?.Player) return resolve();
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.onerror = () => reject(new Error("iframe api"));
    document.head.appendChild(s);
  });
  return api;
}

export const LEAD = 1;
export const TAIL = 1;

/** Plays [start-LEAD, end+TAIL] of a YouTube video, pausing at the end when the IFrame API is available. */
export function Player({ videoId, start, end, nonce }: { videoId: string; start: number; end: number; nonce: number }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const from = Math.max(0, Math.floor(start - LEAD));
  const stopAt = end + TAIL;
  const src = `https://www.youtube-nocookie.com/embed/${videoId}?start=${from}&autoplay=1&enablejsapi=1&playsinline=1&rel=0&modestbranding=1&origin=${encodeURIComponent(location.origin)}`;

  useEffect(() => {
    let player: YTPlayer | null = null;
    let timer = 0;
    let alive = true;
    loadApi()
      .then(() => {
        if (!alive || !ref.current || !window.YT) return;
        player = new window.YT.Player(ref.current, {});
        timer = window.setInterval(() => {
          try {
            if (player && player.getPlayerState() === 1 && player.getCurrentTime() >= stopAt) player.pauseVideo();
          } catch {
            /* player not ready */
          }
        }, 150);
      })
      .catch(() => null);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [videoId, stopAt, nonce]);

  return (
    <div className="musk-player">
      <iframe
        key={`${videoId}-${from}-${nonce}`}
        ref={ref}
        src={src}
        title="YouTube player"
        allow="autoplay; encrypted-media; picture-in-picture"
        allowFullScreen
      />
    </div>
  );
}
