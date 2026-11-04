import { Check, Plus, Volume2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { openWord } from "../lib/router";
import { speak, useMeanings } from "./dict";
import { MeaningList } from "./Meanings";
import { reader, useReader, type Context, type Item, type Status } from "./model";
import { MuskSays } from "./MuskSays";
import { gsel } from "./select";

export type Sel = { from: number; to: number };

/* ---------- word / phrase panel ---------- */

export function StatusPicker({ value, onChange }: { value: Status | 0; onChange: (s: Status) => void }) {
  const opts: [Status, React.ReactNode, string][] = [
    [1, "1", "新"],
    [2, "2", "认得"],
    [3, "3", "熟悉"],
    [4, "4", "掌握"],
    [5, <Check key="k" size={15} />, "已知"],
    [-1, <X key="x" size={15} />, "忽略"],
  ];
  return (
    <div className="rd-status" role="radiogroup" aria-label="状态">
      {opts.map(([s, icon, label]) => (
        <button key={s} role="radio" aria-checked={value === s} className={`st-${s} ${value === s ? "is-on" : ""}`} onClick={() => onChange(s)} title={label} data-testid={`status-${s}`}>
          {icon}
          <small>{label}</small>
        </button>
      ))}
    </div>
  );
}

export function WordCard({
  text,
  k,
  ctx,
  phrase,
  autoMusk,
  canExtend,
  onExtend,
  onPick,
  onStatus,
  onClose,
  best,
  hideMusk = false,
}: {
  hideMusk?: boolean;
  best: React.MutableRefObject<string>;
  text: string;
  k: string;
  ctx: Context;
  phrase?: { from: number; to: number; key: string };
  autoMusk: number;
  canExtend: { left: boolean; right: boolean };
  onExtend: (d: 1 | -1) => void;
  onPick: (r: Sel) => void;
  onStatus: (s: Status) => void;
  onClose: () => void;
}) {
  const st = useReader();
  const it = st.items[k];
  const isPhrase = k.includes(" ");
  const m = useMeanings(k);
  const [hint, setHint] = useState(0);
  const [showMusk, setShowMusk] = useState(false);
  best.current = m.senses[0]?.text ?? "";
  useEffect(() => {
    if (autoMusk) setShowMusk(true);
  }, [autoMusk]);

  const hints = m.senses.map((x) => x.text);
  const save = (patch: Partial<Item>) => reader.upsert(text, { status: it?.status ?? 1, ...(!it?.meaning && patch.meaning === undefined && best.current ? { meaning: best.current } : {}), ...patch }, ctx);
  const accept = (h: string) => save({ meaning: !it?.meaning ? h : it.meaning.includes(h) ? it.meaning : `${it.meaning}；${h}` });

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (!hideMusk && gsel.get()) return; // a floating card is on top
      if (e.key === "ArrowDown" && hints.length) {
        e.preventDefault();
        setHint((h) => Math.min(hints.length - 1, h + 1));
      } else if (e.key === "ArrowUp" && hints.length) {
        e.preventDefault();
        setHint((h) => Math.max(0, h - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (hints[hint]) accept(hints[hint]);
        else save({});
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  const sentence = ctx.sentence;
  const at = sentence.toLowerCase().indexOf(text.toLowerCase());

  return (
    <div className="rd-panel" data-testid="panel">
      <span className="rd-grip" aria-hidden="true" />
      <header className="rd-panel-head">
        <div>
          <h3 data-testid="panel-word">{text}</h3>
          <p className="rd-dim">
            {isPhrase ? "短语" : m.ipa ? `/${m.ipa}/` : ""}
            {!it && <span className="rd-pill rd-pill-new">新词</span>}
            {it && <span className={`rd-pill st-${it.status}`}>{it.status === 5 ? "已知" : it.status === -1 ? "忽略" : `等级 ${it.status}`}</span>}
          </p>
        </div>
        <div className="rd-panel-tools">
          <button className="rd-icon" onClick={() => speak(text)} aria-label="发音">
            <Volume2 size={17} />
          </button>
          <button className="rd-icon" onClick={onClose} aria-label="关闭">
            <X size={17} />
          </button>
        </div>
      </header>

      <StatusPicker value={it?.status ?? 0} onChange={onStatus} />

      {!it && (
        <button className="rd-btn rd-btn-primary rd-save" onClick={() => save({})} data-testid="save">
          <Plus size={16} /> {isPhrase ? "保存短语" : "加入语料库"}
        </button>
      )}

      <div className="rd-extend">
        <button disabled={!canExtend.left} onClick={() => onExtend(-1)}>
          ‹ 向前扩展
        </button>
        <button disabled={!canExtend.right} onClick={() => onExtend(1)} data-testid="extend-right">
          向后扩展 ›
        </button>
      </div>
      {phrase && phrase.key !== k && (
        <button className="rd-chip" onClick={() => onPick({ from: phrase.from, to: phrase.to })}>
          短语 · {phrase.key}
        </button>
      )}

      <label className="rd-field">
        <span>释义</span>
        <textarea
          data-meaning
          rows={2}
          value={it?.meaning ?? ""}
          placeholder={hints[0] ? `点下方释义填入，或自己写` : "写下你的释义"}
          onChange={(e) => save({ meaning: e.target.value })}
          data-testid="meaning"
        />
      </label>

      <MeaningList m={m} active={hint} onPick={accept} onLex={m.lexId ? () => openWord(m.lexId!) : undefined} />

      <label className="rd-field">
        <span>笔记</span>
        <textarea rows={2} value={it?.notes ?? ""} placeholder="例句、联想、用法…" onChange={(e) => save({ notes: e.target.value })} />
      </label>

      <figure className="rd-ctx">
        <figcaption>原句</figcaption>
        <blockquote>
          {at >= 0 ? (
            <>
              {sentence.slice(0, at)}
              <mark>{sentence.slice(at, at + text.length)}</mark>
              {sentence.slice(at + text.length)}
            </>
          ) : (
            sentence
          )}
        </blockquote>
      </figure>

      {hideMusk ? null : showMusk ? (
        <MuskSays q={k} autoplay={!!autoMusk} />
      ) : (
        <button className="rd-btn rd-btn-musk" onClick={() => setShowMusk(true)} data-testid="musk-open">
          ▶ Musk 怎么说
        </button>
      )}
    </div>
  );
}
