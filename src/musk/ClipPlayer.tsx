import { useEffect, useRef, useState } from "react";
import type { Sentence } from "./corpus";

const PAD = 0.3; // must match cut_clips.py

/** Native in-page clip player with live word highlighting (karaoke style). */
export function ClipPlayer({ sentence, from, to, nonce }: { sentence: Sentence; from: number; to: number; nonce: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [t, setT] = useState(-1);
  const clipStart = Math.max(0, sentence.s - PAD);
  const src = sentence.c;

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.currentTime = 0;
    v.play().catch(() => null);
  }, [nonce, src]);

  const now = clipStart + t;
  const text = sentence.t;
  const parts: React.ReactNode[] = [];
  let last = 0;
  sentence.w.forEach(([, ws, we, a, b], i) => {
    if (a > last) parts.push(last >= from && a <= to ? <span key={`g${i}`} className="w-hit">{text.slice(last, a)}</span> : text.slice(last, a));
    const hit = a >= from && b <= to;
    const live = t >= 0 && now >= ws && now < Math.max(we, ws + 0.15);
    parts.push(
      <span key={i} className={`${hit ? "w-hit" : ""} ${live ? "w-live" : ""}`}>
        {text.slice(a, b)}
      </span>,
    );
    last = b;
  });
  parts.push(text.slice(last));

  return (
    <>
      {src ? (
        <div className="musk-player">
          <video
            key={src}
            ref={ref}
            src={src}
            playsInline
            controls
            autoPlay
            preload="auto"
            onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
            onEnded={() => setT(-1)}
            data-testid="clip"
          />
        </div>
      ) : (
        <div className="musk-player musk-noclip">这一句还没有剪辑，可以在 YouTube 打开</div>
      )}
      <p className="musk-stage-text">{parts}</p>
    </>
  );
}
