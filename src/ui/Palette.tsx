import { CornerDownLeft, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAtlas } from "../atlas/context";
import { openWord } from "../lib/router";
import { searchAtlas } from "./searchAtlas";
import { Illustration } from "./Illustration";
import { QuickLookup } from "./QuickLookup";

export { searchAtlas } from "./searchAtlas";

export function Palette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const atlas = useAtlas();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const results = useMemo(() => searchAtlas(atlas, q, 30), [atlas, q]);
  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open]);
  useEffect(() => setSel(0), [q]);
  if (!open) return null;
  const pick = (id: string) => {
    onClose();
    openWord(id);
  };
  return (
    <div className="palette-root" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="查词" onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <label className="palette-input">
          <Search size={20} />
          <input
            ref={input}
            value={q}
            data-testid="palette-input"
            placeholder="英文查词，或中文说法，例如 overhear / 偶然听到"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(results.length - 1, s + 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              }
              if (e.key === "Enter" && results[sel]) pick(results[sel].id);
            }}
            aria-controls="palette-list"
            aria-activedescendant={results[sel] ? `pal-${results[sel].id}` : undefined}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <kbd>Esc</kbd>
        </label>
        <div className="palette-body">
          {q.trim() && <QuickLookup raw={q} />}
          {results.length > 0 && <p className="palette-section">图鉴词库</p>}
          <ul id="palette-list" className="palette-list" role="listbox">
            {results.map((w, i) => (
              <li
                key={w.id}
                id={`pal-${w.id}`}
                role="option"
                aria-selected={i === sel}
                className={i === sel ? "is-sel" : ""}
                onMouseEnter={() => setSel(i)}
                onClick={() => pick(w.id)}
              >
                <Illustration src={atlas.img(w, "thumb")} word={w.word} topic={w.topic} className="palette-thumb" />
                <span className="palette-word" lang="en">
                  {w.word}
                </span>
                <span className="palette-zh">{w.zh}</span>
                {i === sel && <CornerDownLeft size={15} className="palette-enter" />}
              </li>
            ))}
            {!q && (
              <li className="palette-hint">
                英文查离线词典，不要求这个词已经在课文或 Musk 语料里。中文则建议一种英文说法。
                <kbd>↑</kbd>
                <kbd>↓</kbd> 选择图鉴词条 <kbd>↵</kbd> 打开
              </li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}
