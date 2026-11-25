/** Playback of a hosted full lesson. The clock is the file's own currentTime.
 *  A fragmented file starts from the first piece instead of waiting for the whole download. */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { PlayerHandle, PlayerPhase } from "./YoutubePlayer";
import { clipReached } from "./lessonDesk";
import { codecFromInit, fixFragment, pullMp4, sniffMp4 } from "./mp4Feed";

const appendable = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;

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
  const [pct, setPct] = useState<number | null>(null);
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
    seenRef.current = false;
    setWait(true);
    setPct(null);
    let objectUrl = "";
    let fetchDone = false;
    const ac = new AbortController();
    const pending: ArrayBuffer[] = [];
    let source: MediaSource | null = null;
    let buffer: SourceBuffer | null = null;
    let opened = false;
    let failed = false;

    const bufferedThrough = (target: number) => covers(v, target);

    const tryStart = () => {
      if (dead || !wantPlay.current) return;
      const target = Math.max(0, initialRef.current);
      if (target > 0.2 && !bufferedThrough(target)) return;
      if (!v.buffered.length) return;
      if (Math.abs(v.currentTime - target) > 0.4 && bufferedThrough(target)) {
        try { v.currentTime = target; } catch { /* not seekable yet */ }
      }
      if (v.paused) startPlayback();
    };

    const pump = () => {
      if (!buffer || buffer.updating || failed) return;
      const next = pending.shift();
      if (!next) {
        if (fetchDone && source && source.readyState === "open") {
          const end = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
          if (end > 1) {
            try { source.duration = end; } catch { /* already ended */ }
            onDurationRef.current?.(end);
          }
          try { source.endOfStream(); } catch { /* already closed */ }
        }
        tryStart();
        return;
      }
      try {
        buffer.appendBuffer(next);
      } catch {
        failOver();
      }
    };

    const openStream = (init: Uint8Array) => {
      if (source || typeof MediaSource === "undefined") {
        failOver();
        return;
      }
      const mime = `video/mp4; codecs="${codecFromInit(init)}"`;
      if (!MediaSource.isTypeSupported(mime)) {
        failOver();
        return;
      }
      source = new MediaSource();
      objectUrl = URL.createObjectURL(source);
      v.src = objectUrl;
      source.addEventListener("sourceopen", () => {
        if (dead || !source || source.readyState !== "open") return;
        try {
          buffer = source.addSourceBuffer(mime);
        } catch {
          failOver();
          return;
        }
        buffer.mode = "segments";
        buffer.addEventListener("updateend", () => {
          pump();
          tryStart();
        });
        buffer.addEventListener("error", () => failOver());
        opened = true;
        pump();
      });
    };

    const failOver = () => {
      if (failed || dead) return;
      failed = true;
      ac.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = "";
      v.src = src;
      const seekAndPlay = () => {
        const dur = v.duration;
        if (typeof dur === "number" && Number.isFinite(dur) && dur > 0) onDurationRef.current?.(dur);
        try { v.currentTime = Math.max(0, initialRef.current); } catch { /* not seekable yet */ }
        if (wantPlay.current) startPlayback();
      };
      v.addEventListener("loadedmetadata", seekAndPlay, { once: true });
    };

    const run = async () => {
      let res: Response;
      try {
        res = await fetch(src, { signal: ac.signal });
      } catch {
        if (!dead) failOver();
        return;
      }
      if (!res.ok || !res.body) {
        failOver();
        return;
      }
      const total = Number(res.headers.get("Content-Length")) || 0;
      const reader = res.body.getReader();
      let held = new Uint8Array(0);
      let received = 0;
      let initSent = false;
      let kind: "unknown" | "fragmented" | "progressive" = "unknown";
      try {
        while (!dead && !failed) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (!dead) setPct(total > 0 ? Math.min(99, Math.round((received / total) * 100)) : null);
          const merged = new Uint8Array(held.length + value.byteLength);
          merged.set(held, 0);
          merged.set(value, held.length);
          held = merged;
          if (kind === "unknown") kind = sniffMp4(held);
          if (kind === "unknown" && held.length > 2_000_000) {
            failOver();
            return;
          }
          if (kind === "progressive") {
            failOver();
            return;
          }
          if (kind !== "fragmented") continue;
          const piece = pullMp4(held, initSent);
          if (piece.init) {
            initSent = true;
            pending.push(appendable(piece.init));
            openStream(piece.init);
          }
          for (const seg of piece.segments) pending.push(appendable(fixFragment(seg)));
          if (piece.used > 0) held = held.subarray(piece.used);
          if (opened) pump();
        }
      } catch {
        if (!dead && !failed) failOver();
        return;
      }
      fetchDone = true;
      if (!dead && !failed && kind !== "fragmented") failOver();
      else pump();
    };
    void run();

    return () => {
      dead = true;
      ac.abort();
      v.pause();
      v.removeAttribute("src");
      v.load();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
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
          <p>{pct == null ? "正在缓冲…" : `正在缓冲 ${pct}%`}</p>
          <p>开头到达就开始，不用等整段下完。</p>
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
