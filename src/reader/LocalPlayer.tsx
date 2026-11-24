/** Native playback of a hosted full lesson. The clock is the file's own currentTime. */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { PlayerHandle, PlayerPhase } from "./YoutubePlayer";
import { clipReached } from "./lessonDesk";

export const LocalPlayer = forwardRef<PlayerHandle, {
  src: string;
  title: string;
  initial: number;
  onTime?: (seconds: number) => void;
  onPhase?: (phase: PlayerPhase) => void;
  onDuration?: (seconds: number) => void;
  rate?: number;
  /** Hard stop for the current sentence. Null while a loop or continuous play is on. */
  clip?: { start: number; end: number } | null;
}>(function LocalPlayer({ src, title, initial, onTime, onPhase, onDuration, rate = 1, clip = null }, ref) {
  const video = useRef<HTMLVideoElement>(null);
  const onTimeRef = useRef(onTime);
  const onPhaseRef = useRef(onPhase);
  const onDurationRef = useRef(onDuration);
  const clipRef = useRef(clip);
  const initialRef = useRef(initial);
  const [phase, setPhase] = useState<PlayerPhase>("loading");
  onTimeRef.current = onTime;
  onPhaseRef.current = onPhase;
  onDurationRef.current = onDuration;
  clipRef.current = clip;

  const setPh = (next: PlayerPhase) => {
    setPhase(next);
    onPhaseRef.current?.(next);
  };

  useImperativeHandle(ref, () => ({
    seek(seconds: number) {
      const v = video.current;
      if (!v) return;
      const target = Math.max(0, seconds);
      initialRef.current = target;
      if (Math.abs((v.currentTime || 0) - target) < 0.08) {
        if (v.paused) void v.play().catch(() => setPh("blocked"));
        return;
      }
      const fast = (v as HTMLVideoElement & { fastSeek?: (t: number) => void }).fastSeek;
      if (typeof fast === "function") fast.call(v, target);
      else v.currentTime = target;
    },
    play() {
      const v = video.current;
      const bound = clipRef.current;
      if (v && bound && v.currentTime >= bound.end - 0.08) v.currentTime = bound.start;
      v?.play().then(() => setPh("playing")).catch(() => setPh("blocked"));
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
    setRate(next: number) {
      if (video.current) video.current.playbackRate = next;
    },
  }));

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.src = src;
    const seekAndPlay = () => {
      const dur = v.duration;
      if (typeof dur === "number" && Number.isFinite(dur) && dur > 0) onDurationRef.current?.(dur);
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
    };
  }, [src]);

  useEffect(() => {
    if (video.current) video.current.playbackRate = rate;
  }, [rate, src]);

  // timeupdate is too sparse, and one pause() can be undone by a late play().
  // Hold the file inside the current sentence on every frame.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const node = video.current;
      const bound = clipRef.current;
      if (node && bound && node.currentTime >= bound.end - 0.08) {
        const holdAt = Math.max(bound.start, bound.end - 0.05);
        if (node.currentTime > holdAt + 0.03) node.currentTime = holdAt;
        if (!node.paused) node.pause();
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [src]);

  const emit = () => {
    const node = video.current;
    const t = node?.currentTime;
    const bound = clipRef.current;
    if (node && typeof t === "number" && bound && clipReached(t, bound.start, bound.end)) node.pause();
    if (typeof t === "number" && Number.isFinite(t)) onTimeRef.current?.(t);
  };

  return (
    <div className="vs-frame" data-testid="local-frame">
      <video
        ref={video}
        playsInline
        preload="auto"
        title={title}
        data-testid="local-video"
        onTimeUpdate={emit}
        onSeeked={emit}
        onPlay={() => setPh("playing")}
        onPlaying={() => {
          const node = video.current;
          const bound = clipRef.current;
          if (node && bound && clipReached(node.currentTime, bound.start, bound.end)) node.pause();
          else setPh("playing");
        }}
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
          <p>这段缓存视频打不开。可以改用在线。</p>
        </div>
      )}
    </div>
  );
});
