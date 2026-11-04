import { useEffect, useRef, useState } from "react";
import { MuskText } from "../reader/MuskText";
import type { Sentence } from "./corpus";

const PAD = 0.3; // must match cut_clips.py

/** Native in-page clip player with live word highlighting (karaoke style). */
export function ClipPlayer({ sentence, from, to, nonce, title = "" }: { sentence: Sentence; from: number; to: number; nonce: number; title?: string }) {
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
      <p className="musk-stage-text">
        <MuskText sentence={sentence} title={title} place="stage" from={from} to={to} now={t >= 0 ? now : undefined} />
      </p>
    </>
  );
}
