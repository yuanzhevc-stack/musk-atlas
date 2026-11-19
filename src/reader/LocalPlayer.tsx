/** Native playback of a file the user picked. The clock is the file's own currentTime. */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { PlayerHandle, PlayerPhase } from "./YoutubePlayer";

export const LocalPlayer = forwardRef<PlayerHandle, {
  file: File;
  title: string;
  initial: number;
  onTime?: (seconds: number) => void;
  onPhase?: (phase: PlayerPhase) => void;
}>(function LocalPlayer({ file, title, initial, onTime, onPhase }, ref) {
  const video = useRef<HTMLVideoElement>(null);
  const url = useRef<string | null>(null);
  const onTimeRef = useRef(onTime);
  const onPhaseRef = useRef(onPhase);
  const initialRef = useRef(initial);
  const [phase, setPhase] = useState<PlayerPhase>("loading");
  onTimeRef.current = onTime;
  onPhaseRef.current = onPhase;

  const setPh = (next: PlayerPhase) => {
    setPhase(next);
    onPhaseRef.current?.(next);
  };

  useImperativeHandle(ref, () => ({
    seek(seconds: number) {
      const v = video.current;
      if (!v) return;
      initialRef.current = seconds;
      v.currentTime = Math.max(0, seconds);
    },
    play() {
      video.current?.play().then(() => setPh("playing")).catch(() => setPh("blocked"));
    },
    pause() {
      video.current?.pause();
    },
    toggle() {
      const v = video.current;
      if (!v) return;
      if (v.paused) void this.play();
      else v.pause();
    },
    getTime() {
      const t = video.current?.currentTime;
      return typeof t === "number" && Number.isFinite(t) ? t : initialRef.current;
    },
  }));

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const src = URL.createObjectURL(file);
    url.current = src;
    v.src = src;
    const seekAndPlay = () => {
      try {
        v.currentTime = Math.max(0, initialRef.current);
      } catch {
        /* not seekable yet */
      }
      v.play().then(() => setPh("playing")).catch(() => setPh("blocked"));
    };
    v.addEventListener("loadedmetadata", seekAndPlay);
    return () => {
      v.pause();
      v.removeAttribute("src");
      v.load();
      URL.revokeObjectURL(src);
    };
  }, [file]);

  const emit = () => {
    const t = video.current?.currentTime;
    if (typeof t === "number" && Number.isFinite(t)) onTimeRef.current?.(t);
  };

  return (
    <div className="vs-frame" data-testid="local-frame">
      <video
        ref={video}
        playsInline
        controls
        preload="auto"
        title={title}
        data-testid="local-video"
        onTimeUpdate={emit}
        onSeeked={emit}
        onPlay={() => setPh("playing")}
        onPause={() => setPh("paused")}
        onError={() => setPh("error")}
      />
      {phase === "blocked" && (
        <div className="vs-overlay" data-testid="local-blocked">
          <p>浏览器拦截了自动播放。</p>
          <button type="button" onClick={() => video.current?.play().then(() => setPh("playing")).catch(() => setPh("blocked"))} data-testid="local-manual">
            点击播放
          </button>
        </div>
      )}
      {phase === "error" && (
        <div className="vs-overlay" data-testid="local-error">
          <p>这个文件打不开。可以另选一个视频，或改用在线。</p>
        </div>
      )}
    </div>
  );
});
