/** Playback of a hosted full lesson. The clock is the file's own currentTime.
 *  A file this browser has already kept starts from disk. Otherwise the faststart
 *  file plays at once, and the whole file is kept for the next open. */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { PlayerHandle, PlayerPhase } from "./YoutubePlayer";
import { clipReached } from "./lessonDesk";
import { cachedBlobUrl, retainMedia } from "./mediaCache";

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
  const seekGuard = useRef(0);
  const wantPlay = useRef(true);
  const rateRef = useRef(rate);
  const [phase, setPhase] = useState<PlayerPhase>("loading");
  const phaseRef = useRef(phase);
  const seenRef = useRef(false);
  phaseRef.current = phase;
  const [wait, setWait] = useState(true);
  onTimeRef.current = onTime;
  onPhaseRef.current = onPhase;
  onDurationRef.current = onDuration;
  rateRef.current = rate;
  if (performance.now() >= seekGuard.current) clipRef.current = clip;

  const setPh = (next: PlayerPhase) => {
    setPhase(next);
    onPhaseRef.current?.(next);
  };

  const covers = (node: HTMLVideoElement, target: number) => {
    const ranges = node.buffered;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) - 0.15 <= target && ranges.end(i) >= target - 0.05) return true;
    }
    return false;
  };

  const startPlayback = () => {
    const v = video.current;
    if (!v) return;
    const target = Math.max(0, initialRef.current);
    const ready = v.buffered.length === 0 || target <= 0.25 || covers(v, target);
    if (ready && v.buffered.length && covers(v, target) && Math.abs(v.currentTime - target) > 0.35) {
      try { v.currentTime = target; } catch { /* not seekable yet */ }
    }
    const bound = clipRef.current;
    if (ready && bound && v.currentTime >= bound.end - 0.08 && v.currentTime <= bound.end + 0.2) v.currentTime = bound.start;
    v.playbackRate = rateRef.current;
    v.play().then(() => { if (ready) setPh("playing"); }).catch((err: { name?: string }) => {
      if (err?.name === "NotAllowedError") setPh("blocked");
    });
  };

  useImperativeHandle(ref, () => ({
    seek(seconds: number, nextClip?: { start: number; end: number } | null) {
      const v = video.current;
      if (!v) return;
      if (nextClip !== undefined) clipRef.current = nextClip;
      const target = Math.max(0, seconds);
      initialRef.current = target;
      seekGuard.current = performance.now() + 700;
      const end = v.seekable.length ? v.seekable.end(v.seekable.length - 1) : 0;
      if (end >= target) v.currentTime = target;
    },
    play() {
      wantPlay.current = true;
      startPlayback();
    },
    pause() {
      wantPlay.current = false;
      video.current?.pause();
    },
    toggle() {
      const v = video.current;
      if (!v) return;
      if (v.paused) {
        wantPlay.current = true;
        startPlayback();
      } else {
        wantPlay.current = false;
        v.pause();
      }
    },
    getTime() {
      const t = video.current?.currentTime;
      return typeof t === "number" && Number.isFinite(t) ? t : initialRef.current;
    },
    setRate(next: number) {
      rateRef.current = next;
      if (video.current) video.current.playbackRate = next;
    },
  }));

  useEffect(() => {
    const v = video.current;
    if (!v || !src) return;
    let dead = false;
    let blobUrl = "";
    seenRef.current = false;
    setWait(true);

    const arm = (url: string, fromDisk: boolean) => {
      if (dead) return;
      if (fromDisk) setWait(false);
      v.src = url;
      const seekAndPlay = () => {
        if (dead) return;
        const dur = v.duration;
        if (typeof dur === "number" && Number.isFinite(dur) && dur > 0) onDurationRef.current?.(dur);
        const target = Math.max(0, initialRef.current);
        if (target > 0.25 && Math.abs(v.currentTime - target) > 0.35) {
          try { v.currentTime = target; } catch { /* not seekable yet */ }
        }
        if (wantPlay.current) startPlayback();
      };
      if (v.readyState >= 1) seekAndPlay();
      else v.addEventListener("loadedmetadata", seekAndPlay, { once: true });
    };

    void (async () => {
      const hit = await cachedBlobUrl(src);
      if (dead) {
        if (hit) URL.revokeObjectURL(hit);
        return;
      }
      if (hit) {
        blobUrl = hit;
        arm(hit, true);
        return;
      }
      arm(src, false);
      retainMedia(src);
    })();

    return () => {
      dead = true;
      v.pause();
      v.removeAttribute("src");
      v.load();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
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
      if (!node || !bound || performance.now() < seekGuard.current) {
        frame = requestAnimationFrame(tick);
        return;
      }
      if (node.currentTime >= bound.end - 0.08) {
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
    if (node && typeof t === "number" && bound && performance.now() >= seekGuard.current && clipReached(t, bound.start, bound.end)) node.pause();
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
        onLoadedData={() => setWait(false)}
        onTimeUpdate={emit}
        onSeeked={emit}
        onDurationChange={() => {
          const dur = video.current?.duration;
          if (typeof dur === "number" && Number.isFinite(dur) && dur > 0) onDurationRef.current?.(dur);
        }}
        onPlay={() => setPh("playing")}
        onPlaying={() => {
          const node = video.current;
          const bound = clipRef.current;
          if (node && bound && performance.now() >= seekGuard.current && clipReached(node.currentTime, bound.start, bound.end)) node.pause();
          else {
            seenRef.current = true;
            setWait(false);
            setPh("playing");
          }
        }}
        onWaiting={() => { if (!seenRef.current) setWait(true); }}
        onPause={() => setPh("paused")}
        onError={() => {
          if (phaseRef.current !== "loading") setPh("error");
        }}
      />
      {wait && phase !== "blocked" && phase !== "error" && (
        <div className="vs-overlay" data-testid="local-buffer">
          <p>正在打开</p>
        </div>
      )}
      {phase === "blocked" && (
        <div className="vs-overlay" data-testid="local-blocked">
          <p>浏览器拦截了自动播放。</p>
          <button type="button" onClick={() => { wantPlay.current = true; startPlayback(); }} data-testid="local-manual">
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
