import { Download, GraduationCap, Search, Trash2, Upload, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { clock } from "../musk/corpus";
import { useVocab } from "../musk/vocab";
import { normalize, reader, useReader, type Item } from "../reader/model";
import { MuskSays } from "../reader/MuskSays";
import { Rating, formatInterval, preview, type Grade } from "../store/srs";
import { Sheet } from "../ui/Sheet";
import { toast } from "../ui/Toast";
import { StatusPicker, ToolTabs } from "./Reader";

type Filter = "learning" | "phrase" | "review" | "known" | "ignored" | "all";
const FILTERS: [Filter, string][] = [
  ["learning", "学习中"],
  ["phrase", "短语"],
  ["review", "复习"],
  ["known", "已知"],
  ["ignored", "忽略"],
  ["all", "全部"],
];
const match = (it: Item, f: Filter) =>
  f === "all"
    ? true
    : f === "learning"
      ? it.status >= 1 && it.status <= 4
      : f === "phrase"
        ? it.kind === "phrase" && it.status !== -1
        : f === "review"
          ? !!it.srs
          : f === "known"
            ? it.status === 5
            : it.status === -1;

const statusText = (s: Item["status"]) => (s === 5 ? "已知" : s === -1 ? "忽略" : `${s}`);

export function CorpusPage() {
  const st = useReader();
  const musk = useVocab();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("learning");
  const [sort, setSort] = useState<"recent" | "alpha" | "status">("recent");
  const [open, setOpen] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const items = Object.values(st.items);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map(([f]) => [f, items.filter((it) => match(it, f)).length])), [items]);
  const due = items.filter((it) => it.srs && it.srs.due <= Date.now());
  const list = useMemo(() => {
    const n = q.trim().toLowerCase();
    const out = items.filter((it) => match(it, filter) && (!n || it.key.includes(n) || it.meaning.toLowerCase().includes(n) || it.notes.toLowerCase().includes(n) || it.ctx?.sentence.toLowerCase().includes(n)));
    out.sort((a, b) => (sort === "alpha" ? a.key.localeCompare(b.key) : sort === "status" ? (a.status === -1 ? 9 : a.status) - (b.status === -1 ? 9 : b.status) || b.updated - a.updated : b.updated - a.updated));
    return out;
  }, [items, q, filter, sort]);

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
          <p className="rd-eyebrow">阅读</p>
          <h1 className="rd-title">我的语料库</h1>
        </div>
        <ToolTabs on="corpus" />
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

      <div className="rd-filters" role="tablist">
        {FILTERS.map(([f, label]) => (
          <button key={f} className={filter === f ? "is-on" : ""} onClick={() => setFilter(f)} role="tab" aria-selected={filter === f}>
            {label} <small>{counts[f]}</small>
          </button>
        ))}
      </div>

      {!list.length ? (
        <div className="rd-empty rd-empty-lg">
          <p>{items.length ? "没有匹配的条目" : "还没有词。去课程里点词、选短语，就会出现在这里。"}</p>
          {!items.length && (
            <a className="rd-btn rd-btn-primary" href="#/reader">
              去阅读
            </a>
          )}
        </div>
      ) : (
        <ul className="rd-list" data-testid="corpus-list">
          {list.slice(0, 400).map((it) => (
            <CorpusRow key={it.key} it={it} open={open === it.key} onToggle={() => setOpen(open === it.key ? null : it.key)} />
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
  if (it.ctx.musk) return `#/?q=${encodeURIComponent(it.key)}`;
  return `#/reader?l=${it.ctx.lesson}&s=${it.ctx.sid}`;
}

function CorpusRow({ it, open, onToggle }: { it: Item; open: boolean; onToggle: () => void }) {
  const href = sourceHref(it);
  const s = it.ctx?.sentence ?? "";
  const at = s.toLowerCase().indexOf(it.text.toLowerCase());
  return (
    <li className={`rd-row ${open ? "is-open" : ""}`} data-testid="corpus-row">
      <button className="rd-row-main" onClick={onToggle}>
        <span className={`rd-pill st-${it.status}`}>{statusText(it.status)}</span>
        <span className="rd-row-body">
          <b>
            {it.text}
            {it.kind === "phrase" && <em>短语</em>}
          </b>
          <span className="rd-row-meaning">{it.meaning || <i className="rd-dim">无释义</i>}</span>
          {s && (
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
        </span>
      </button>
      {open && (
        <div className="rd-row-detail">
          <StatusPicker value={it.status} onChange={(st) => reader.upsert(it.text, { status: st })} />
          <label className="rd-field">
            <span>释义</span>
            <textarea rows={2} value={it.meaning} onChange={(e) => reader.upsert(it.text, { meaning: e.target.value })} />
          </label>
          <label className="rd-field">
            <span>笔记</span>
            <textarea rows={2} value={it.notes} onChange={(e) => reader.upsert(it.text, { notes: e.target.value })} />
          </label>
          <div className="rd-row-actions">
            {href && (
              <a className="rd-btn" href={href}>
                {it.ctx?.musk ? `Musk 原句 · ${clock(it.ctx.musk.t)}` : `回到《${it.ctx!.title.slice(0, 18)}》`}
              </a>
            )}
            <button className="rd-btn" onClick={() => (it.srs ? reader.removeFromReview(it.key) : reader.addToReview(it.key))}>
              <GraduationCap size={15} /> {it.srs ? "移出复习" : "加入复习"}
            </button>
            <button className="rd-btn rd-btn-danger" onClick={() => reader.remove(it.key)} aria-label="删除">
              <Trash2 size={15} />
            </button>
          </div>
          <MuskSays q={it.key} compact />
        </div>
      )}
    </li>
  );
}

function ReviewSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
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
