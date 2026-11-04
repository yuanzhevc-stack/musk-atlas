import { Check, CornerUpLeft, Download, GraduationCap, MoreHorizontal, PenLine, Search, Trash2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CorpusPlay } from "../reader/CorpusPlay";
import { clock } from "../musk/corpus";
import { useVocab } from "../musk/vocab";
import { normalize, reader, useReader, type Item } from "../reader/model";
import { MuskSays } from "../reader/MuskSays";
import { useMeanings } from "../reader/dict";
import { MeaningList } from "../reader/Meanings";
import { Rating, formatInterval, preview, type Grade } from "../store/srs";
import { Sheet } from "../ui/Sheet";
import { toast } from "../ui/Toast";

type Kind = "all" | Item["kind"];
const KINDS: [Kind, string][] = [
  ["all", "全部"],
  ["word", "单词"],
  ["phrase", "短语"],
  ["sentence", "句子"],
];
type Filter = "learning" | "review" | "known" | "ignored" | "all";
const FILTERS: [Filter, string][] = [
  ["all", "全部"],
  ["learning", "学习中"],
  ["review", "复习"],
  ["known", "已知"],
  ["ignored", "忽略"],
];
const match = (it: Item, f: Filter) =>
  f === "all"
    ? true
    : f === "learning"
      ? it.status >= 1 && it.status <= 4
      : f === "review"
        ? !!it.srs
        : f === "known"
          ? it.status === 5
          : it.status === -1;
export const KIND_LABEL: Record<Item["kind"], string> = { word: "单词", phrase: "短语", sentence: "句子" };

const statusText = (s: Item["status"]) => (s === 5 ? "已知" : s === -1 ? "忽略" : `${s}`);

export function CorpusPage() {
  const st = useReader();
  const musk = useVocab();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [kind, setKind] = useState<Kind>("all");
  const [sort, setSort] = useState<"recent" | "alpha" | "status">("recent");
  const [open, setOpen] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [replay, setReplay] = useState(0);
  const file = useRef<HTMLInputElement>(null);

  const items = Object.values(st.items);
  const ofKind = useMemo(() => items.filter((it) => kind === "all" || it.kind === kind), [items, kind]);
  const kindCounts = useMemo(() => Object.fromEntries(KINDS.map(([k]) => [k, items.filter((it) => k === "all" || it.kind === k).length])), [items]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map(([f]) => [f, ofKind.filter((it) => match(it, f)).length])), [ofKind]);
  const due = items.filter((it) => it.srs && it.srs.due <= Date.now());
  const list = useMemo(() => {
    const n = q.trim().toLowerCase();
    const out = ofKind.filter((it) => match(it, filter) && (!n || it.key.includes(n) || it.meaning.toLowerCase().includes(n) || it.notes.toLowerCase().includes(n) || it.ctx?.sentence.toLowerCase().includes(n)));
    out.sort((a, b) => (sort === "alpha" ? a.key.localeCompare(b.key) : sort === "status" ? (a.status === -1 ? 9 : a.status) - (b.status === -1 ? 9 : b.status) || b.updated - a.updated : b.updated - a.updated));
    return out;
  }, [ofKind, q, filter, sort]);

  // Musk-page style keys: ↓/↑ open next/prev row (autoplays), Enter replays.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || reviewing) return;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable || document.querySelector(".cp-pop, .sheet-root")) return;
      const shown = list.slice(0, 400);
      if (!shown.length) return;
      const i = shown.findIndex((x) => x.key === open);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = shown[Math.min(shown.length - 1, Math.max(0, i < 0 ? 0 : i + (e.key === "ArrowDown" ? 1 : -1)))];
        setOpen(n.key);
        requestAnimationFrame(() => document.querySelector(`[data-key="${CSS.escape(n.key)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
      } else if (e.key === "Enter" && t.tagName !== "BUTTON" && t.tagName !== "A") {
        e.preventDefault();
        if (i < 0) setOpen(shown[0].key);
        else setReplay(Date.now());
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  const newMusk = musk.filter((m) => !st.items[normalize(m.phrase)]);
  const importMusk = () => {
    for (const m of newMusk)
      reader.upsert(m.phrase, { status: 1 }, { lesson: "musk", title: m.title, sid: 0, sentence: m.sentence, musk: { v: m.videoId, t: m.start } });
    toast(`已导入 ${newMusk.length} 条 Musk 收藏`, "ok");
  };

  const exportJSON = () => {
    const blob = new Blob([reader.exportJSON()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `musk-atlas-corpus-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const importJSON = async (f: File) => {
    try {
      const n = reader.importJSON(await f.text());
      toast(`已合并 ${n} 条`, "ok");
    } catch (e) {
      toast((e as Error).message, "warn");
    }
  };

  return (
    <div className="page rd-page">
      <header className="rd-head">
        <div>
          <p className="rd-eyebrow">语料</p>
          <h1 className="rd-title">我的语料</h1>
        </div>
        <p className="rd-dim rd-head-meta">{items.length} 条 · 阅读和 Musk 里学到的词、短语、句子</p>
      </header>

      <div className="rd-toolbar">
        <label className="rd-search">
          <Search size={17} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索词、释义、笔记、原句" data-testid="corpus-search" />
          {q && (
            <button className="rd-icon" onClick={() => setQ("")} aria-label="清空">
              <X size={15} />
            </button>
          )}
        </label>
        <select className="rd-select" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="排序">
          <option value="recent">最近</option>
          <option value="alpha">A–Z</option>
          <option value="status">等级</option>
        </select>
        <button className="rd-btn rd-btn-primary" disabled={!due.length} onClick={() => setReviewing(true)} data-testid="review-open">
          <GraduationCap size={16} /> 复习 {due.length || ""}
        </button>
      </div>

      <div className="rd-tabs rd-kinds" role="tablist" data-testid="kind-tabs">
        {KINDS.map(([k, label]) => (
          <button key={k} className={kind === k ? "is-on" : ""} onClick={() => setKind(k)} role="tab" aria-selected={kind === k}>
            {label} <small>{kindCounts[k]}</small>
          </button>
        ))}
      </div>

      <div className="rd-filters" role="tablist">
        {FILTERS.map(([f, label]) => (
          <button key={f} className={filter === f ? "is-on" : ""} onClick={() => setFilter(f)} role="tab" aria-selected={filter === f}>
            {label} <small>{counts[f]}</small>
          </button>
        ))}
      </div>

      {!list.length ? (
        <div className="rd-empty rd-empty-lg">
          <p>{items.length ? "没有匹配的条目" : "还没有语料。去阅读里点词、选短语、存句子，就会出现在这里。"}</p>
          {!items.length && (
            <a className="rd-btn rd-btn-primary" href="#/reader">
              去阅读
            </a>
          )}
        </div>
      ) : (
        <ul className="rd-list" data-testid="corpus-list">
          {list.slice(0, 400).map((it) => (
            <CorpusRow key={it.key} it={it} open={open === it.key} replay={open === it.key ? replay : 0} onToggle={() => setOpen(open === it.key ? null : it.key)} />
          ))}
        </ul>
      )}

      <footer className="rd-data">
        <p className="rd-dim">数据只存在这台设备的浏览器里。换设备时先导出 JSON，再在另一台导入（会按更新时间合并）。</p>
        <div>
          <button className="rd-btn" onClick={exportJSON}>
            <Download size={15} /> 导出 JSON
          </button>
          <button className="rd-btn" onClick={() => file.current?.click()}>
            <Upload size={15} /> 导入 JSON
          </button>
          {newMusk.length > 0 && (
            <button className="rd-btn" onClick={importMusk}>
              导入 Musk 收藏 {newMusk.length}
            </button>
          )}
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importJSON(f);
              e.target.value = "";
            }}
          />
        </div>
      </footer>

      <ReviewSheet open={reviewing} onClose={() => setReviewing(false)} />
    </div>
  );
}

function sourceHref(it: Item) {
  if (!it.ctx) return null;
  if (it.ctx.musk) return `#/?q=${encodeURIComponent(it.key)}${it.ctx.sid ? `&c=${it.ctx.sid}` : ""}`;
  return `#/reader?l=${it.ctx.lesson}&s=${it.ctx.sid}`;
}

const STATUSES: [Item["status"], string][] = [
  [1, "新"],
  [2, "认得"],
  [3, "熟悉"],
  [4, "掌握"],
  [5, "已知"],
  [-1, "忽略"],
];

/** Small Apple-style popover anchored inside the row; closes on outside tap / Esc. */
function Pop({ onClose, className = "", children }: { onClose: () => void; className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const t = setTimeout(() => document.addEventListener("pointerdown", down), 0);
    document.addEventListener("keydown", key);
    return () => {
      clearTimeout(t);
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);
  return (
    <div ref={ref} className={`cp-pop ${className}`} role="menu">
      {children}
    </div>
  );
}

export function CorpusRow({ it, open, onToggle, replay = 0 }: { it: Item; open: boolean; onToggle: () => void; replay?: number }) {
  const href = sourceHref(it);
  const s = it.ctx?.sentence ?? "";
  const at = s.toLowerCase().indexOf(it.text.toLowerCase());
  const [menu, setMenu] = useState<"status" | "more" | null>(null);
  const [editing, setEditing] = useState(false);
  const close = useCallback(() => setMenu(null), []);
  return (
    <li className={`rd-row ${open ? "is-open" : ""}`} data-testid="corpus-row" data-key={it.key}>
      <div className="rd-row-main cp-main">
        <span className="cp-anchor">
          <button
            className={`rd-pill st-${it.status} cp-pill`}
            onClick={() => setMenu(menu === "status" ? null : "status")}
            aria-haspopup="menu"
            aria-expanded={menu === "status"}
            aria-label={`等级 ${statusText(it.status)}，点按修改`}
            data-testid="row-status"
          >
            {statusText(it.status)}
          </button>
          {menu === "status" && (
            <Pop onClose={close} className="cp-pop-status">
              {STATUSES.map(([v, l]) => (
                <button
                  key={v}
                  role="menuitemradio"
                  aria-checked={it.status === v}
                  className={`st-${v} ${it.status === v ? "is-on" : ""}`}
                  onClick={() => {
                    reader.upsert(it.text, { status: v });
                    setMenu(null);
                  }}
                  data-testid="status-opt"
                >
                  <b>{v === 5 ? <Check size={15} /> : v === -1 ? <X size={15} /> : v}</b>
                  <small>{l}</small>
                </button>
              ))}
            </Pop>
          )}
        </span>
        <button className="rd-row-body cp-body" onClick={onToggle} aria-expanded={open} data-testid="row-open">
          <b>
            {it.text}
            {it.kind !== "word" && <em>{KIND_LABEL[it.kind]}</em>}
          </b>
          <span className="rd-row-meaning">{it.meaning || <i className="rd-dim">无释义</i>}</span>
          {s && it.kind !== "sentence" && !open && (
            <span className="rd-row-ctx">
              {at >= 0 ? (
                <>
                  {s.slice(0, at)}
                  <mark>{s.slice(at, at + it.text.length)}</mark>
                  {s.slice(at + it.text.length)}
                </>
              ) : (
                s
              )}
            </span>
          )}
        </button>
        <span className="cp-anchor">
          <button className="rd-icon cp-more" onClick={() => setMenu(menu === "more" ? null : "more")} aria-haspopup="menu" aria-label="更多" data-testid="row-more">
            <MoreHorizontal size={18} />
          </button>
          {menu === "more" && (
            <Pop onClose={close} className="cp-pop-more">
              <button role="menuitem" onClick={() => (setMenu(null), setEditing(true))} data-testid="menu-edit">
                <PenLine size={15} /> 编辑释义 / 笔记
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  if (it.srs) reader.removeFromReview(it.key);
                  else reader.addToReview(it.key);
                  toast(it.srs ? "已移出复习" : "已加入复习", "ok");
                }}
                data-testid="menu-review"
              >
                <GraduationCap size={15} /> {it.srs ? "移出复习" : "加入复习"}
              </button>
              {href && (
                <a role="menuitem" href={href} data-testid="menu-source">
                  <CornerUpLeft size={15} /> {it.ctx?.musk ? `Musk 原句 · ${clock(it.ctx.musk.t)}` : `回到《${it.ctx!.title.slice(0, 14)}》`}
                </a>
              )}
              <button
                role="menuitem"
                className="is-danger"
                onClick={() => {
                  setMenu(null);
                  if (confirm(`删除「${it.text.slice(0, 40)}」？`)) reader.remove(it.key);
                }}
                data-testid="menu-delete"
              >
                <Trash2 size={15} /> 删除
              </button>
            </Pop>
          )}
        </span>
      </div>
      {open && (
        <div className="rd-row-detail cp-detail">
          <CorpusPlay it={it} replay={replay} />
        </div>
      )}
      <Sheet open={editing} onClose={() => setEditing(false)} label="编辑释义和笔记" className="rd-sheet">
        <div className="cp-edit">
          <h2>{it.text}</h2>
          <label className="rd-field">
            <span>释义</span>
            <textarea rows={2} value={it.meaning} onChange={(e) => reader.upsert(it.text, { meaning: e.target.value })} data-testid="edit-meaning" />
          </label>
          {editing && <RowMeanings it={it} />}
          <label className="rd-field">
            <span>笔记</span>
            <textarea rows={3} value={it.notes} onChange={(e) => reader.upsert(it.text, { notes: e.target.value })} />
          </label>
          <button className="rd-btn rd-btn-primary" onClick={() => setEditing(false)}>
            完成
          </button>
        </div>
      </Sheet>
    </li>
  );
}

export function ReviewSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const st = useReader();
  const [shown, setShown] = useState(false);
  const due = Object.values(st.items)
    .filter((it) => it.srs && it.srs.due <= Date.now())
    .sort((a, b) => a.srs!.due - b.srs!.due);
  const it = due[0];
  const fresh = it?.srs && it.srs.reps === 0 && it.srs.s === 0;
  const pv = it ? preview(fresh ? undefined : it.srs, Date.now()) : null;
  const grade = (g: Grade) => {
    reader.grade(it.key, g);
    setShown(false);
  };
  return (
    <Sheet open={open} onClose={onClose} label="复习" className="rd-sheet">
      {!it ? (
        <div className="rd-empty rd-empty-lg">
          <p>今天复习完了</p>
          <button className="rd-btn rd-btn-primary" onClick={onClose}>
            好
          </button>
        </div>
      ) : (
        <div className="rd-review">
          <p className="rd-dim">还剩 {due.length}</p>
          <h2>{it.text}</h2>
          {it.ctx && <blockquote>{it.ctx.sentence}</blockquote>}
          {!shown ? (
            <button className="rd-btn rd-btn-primary" onClick={() => setShown(true)}>
              显示释义
            </button>
          ) : (
            <>
              <p className="rd-review-meaning">{it.meaning || "（没有释义）"}</p>
              <MuskSays q={it.key} compact />
              <div className="rd-grades">
                {([
                  [Rating.Again, "忘了"],
                  [Rating.Hard, "模糊"],
                  [Rating.Good, "记得"],
                  [Rating.Easy, "简单"],
                ] as [Grade, string][]).map(([g, l]) => (
                  <button key={g} className="rd-btn" onClick={() => grade(g)}>
                    {l}
                    <small>{pv ? formatInterval(pv[g]) : ""}</small>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}

function RowMeanings({ it }: { it: Item }) {
  const m = useMeanings(it.key);
  return <MeaningList m={m} onPick={(t) => reader.upsert(it.text, { meaning: !it.meaning ? t : it.meaning.includes(t) ? it.meaning : `${it.meaning}；${t}` })} />;
}
