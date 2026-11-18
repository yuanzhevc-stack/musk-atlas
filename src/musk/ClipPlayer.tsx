import { useEffect, useRef, useState } from "react";
import { MuskText } from "../reader/MuskText";
import { wordAt } from "../reader/sync";
import { clock, type Sentence } from "./corpus";

const PAD = 0.3; // must match cut_clips.py

/** Native in-page clip player. Word highlight updates only when the spoken word changes. */
export function ClipPlayer({ sentence, from, to, nonce, title = "" }: { sentence: Sentence; from: number; to: number; nonce: number; title?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [wi, setWi] = useState(-1);
  const [gate, setGate] = useState<"ok" | "blocked" | "error" | "missing">(sentence.c ? "ok" : "missing");
  const starts = sentence.w.map((w) => w[1]);
  const clipStart = Math.max(0, sentence.s - PAD);
  const src = sentence.c;
  const yt = `https://www.youtube.com/watch?v=${sentence.v}&t=${Math.max(0, Math.floor(sentence.s))}s`;
  const now = wi >= 0 ? starts[wi] + 0.01 : undefined;

  useEffect(() => {
    const v = ref.current;
    if (!src || !v) {
      setGate("missing");
      setWi(-1);
      return;
    }
    setGate("ok");
    setWi(-1);
    v.currentTime = 0;
    const pending = v.play();
    if (pending) pending.then(() => setGate((g) => (g === "error" ? g : "ok"))).catch(() => setGate("blocked"));
  }, [nonce, src]);

  const manual = () => {
    const pending = ref.current?.play();
    if (pending) pending.then(() => setGate("ok")).catch(() => setGate("blocked"));
  };

  if (!src) {
    return (
      <div className="musk-player musk-noclip" data-testid="clip-missing">
        <p>这一句还没有上传片段。页内不会改播别的视频。</p>
        <a href={yt} target="_blank" rel="noreferrer">
          在 YouTube 打开 {clock(sentence.s)}
        </a>
      </div>
    );
  }

  return (
    <>
      <div className="musk-player">
        <video
          key={src}
          ref={ref}
          src={src}
          playsInline
          controls
          autoPlay
          preload="auto"
          onTimeUpdate={(e) => {
            const n = wordAt(starts, clipStart + e.currentTarget.currentTime);
            setWi((w) => (w === n ? w : n));
          }}
          onPlay={() => setGate("ok")}
          onEnded={() => setWi(-1)}
          onError={() => setGate("error")}
          data-testid="clip"
        />
        {gate === "blocked" && (
          <div className="vs-overlay" data-testid="clip-blocked">
            <p>浏览器拦截了自动播放。</p>
            <button type="button" onClick={manual} data-testid="clip-manual">
              点击播放
            </button>
          </div>
        )}
        {gate === "error" && (
          <div className="vs-overlay" data-testid="clip-error">
            <p>这段片段打不开（文件不在，或被浏览器拦截）。不会改播别的视频。</p>
            <a href={yt} target="_blank" rel="noreferrer">
              在 YouTube 打开 {clock(sentence.s)}
            </a>
          </div>
        )}
      </div>
      <p className="musk-stage-text">
        <MuskText sentence={sentence} title={title} place="stage" from={from} to={to} now={now} />
      </p>
    </>
  );
}
