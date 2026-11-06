/** Result card inside the existing ⌘K field. English uses ECDICT; Chinese asks /express. No extra page. */
import { Plus, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";
import { dictGloss, lookupEnglish, type EnglishResult, type LookupView } from "../reader/englishLookup";
import { translateToEn, speak } from "../reader/dict";
import { normalize, reader, useReader } from "../reader/model";
import { muskLookup, type MuskResult } from "../reader/MuskSays";
import { classifyQuery } from "../reader/query";
import { suggestExpression, type SuggestError, type Suggestion } from "../reader/suggest";
import { toast } from "./Toast";

const ZH_ERROR: Record<SuggestError, string> = {
  unreachable: "表达建议服务没有响应。可能是网络、跨域，或线上还是旧的语音服务。英文词典不依赖这项。",
  unconfigured: "表达建议还没启用。需要在现有语音服务上部署 /express，密钥仍只放在服务端。在此之前，这里不会把机器直译当成地道说法。",
  unavailable: "表达建议暂时不可用，请稍后再试。英文查词不依赖它。",
  rate: "今天的表达建议额度用完了，请明天再试。",
  timeout: "表达建议超时了，请再试一次。",
  invalid: "这次没有拿到可用的说法。可以换种中文说法，或稍后再试。",
  forbidden: "这个页面的来源不在语音服务的允许列表里。",
  too_long: "这句话太长了，请缩短到一两句再试。",
};

function missText(key: string, dictDown: boolean, onlineDown: boolean) {
  if (dictDown && onlineDown) return `「${key}」的离线词典没有加载成功，在线释义也没拿到。请稍后再试。这不是「语料里没有这个词」。`;
  if (dictDown) return `离线词典这次没打开，在线释义也没有结果。`;
  if (onlineDown) return `词典里没有「${key}」。在线释义没有连上。`;
  return `词典和在线来源都没有「${key}」。`;
}

function SaveButton({ text, meaning, notes, sentence, disabled }: { text: string; meaning: string; notes: string; sentence: string; disabled?: boolean }) {
  const items = useReader().items;
  const key = normalize(text);
  if (!key) return null;
  if (items[key])
    return (
      <a className="ql-btn" href="#/corpus" data-testid="quick-saved">
        已在语料库
      </a>
    );
  return (
    <button
      type="button"
      className="ql-btn is-primary"
      data-testid="quick-save"
      disabled={disabled}
      onClick={() => {
        reader.upsert(
          text,
          { status: 1, meaning: meaning.slice(0, 180), notes: notes.slice(0, 240) },
          { lesson: "lookup", title: "快速查词", sid: 0, sentence: (sentence || text).slice(0, 240) },
        );
        toast("已加入语料库", "ok");
      }}
    >
      <Plus size={15} /> 加入语料库
    </button>
  );
}

function SpeakButton({ text, disabled }: { text: string; disabled?: boolean }) {
  return (
    <button type="button" className="ql-btn" data-testid="quick-speak" aria-label={`发音 ${text}`} disabled={disabled} onClick={() => speak(text)}>
      <Volume2 size={15} /> 发音
    </button>
  );
}

function MuskLine({ q }: { q: string }) {
  const [st, setSt] = useState<MuskResult | "load" | "err">("load");
  useEffect(() => {
    let live = true;
    muskLookup(q, 1).then(
      (r) => live && setSt(r),
      () => live && setSt("err"),
    );
    return () => {
      live = false;
    };
  }, [q]);
  if (st === "load") return <p className="ql-musk">正在查 Musk 语料…</p>;
  if (st === "err") return <p className="ql-musk" data-testid="quick-musk">语料索引没有打开。上面的释义不依赖语料。</p>;
  if (st.hits.length)
    return (
      <p className="ql-musk" data-testid="quick-musk">
        语料里有可播放的原片。{" "}
        <a href={`#/?q=${encodeURIComponent(q)}`}>去看原片</a>
      </p>
    );
  if (st.musk > 0)
    return (
      <p className="ql-musk" data-testid="quick-musk">
        语料里有 {st.musk} 句已确认，但原片还没挂上，这里不播放。
      </p>
    );
  return (
    <p className="ql-musk" data-testid="quick-musk">
      语料里没有可播放的 Musk 原片。上面的释义不依赖语料。
    </p>
  );
}

function SenseList({ view }: { view: LookupView }) {
  return (
    <ul className="ql-senses">
      {view.senses.map((s, i) => (
        <li key={`${s.src}${i}`} data-testid="quick-sense">
          <span>{s.text}</span>
          <em>{s.src}</em>
        </li>
      ))}
    </ul>
  );
}

function EnglishPane({ word }: { word: string }) {
  const [state, setState] = useState<EnglishResult | "loading">("loading");
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      lookupEnglish(word).then((r) => live && setState(r));
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [word]);
  if (state === "loading")
    return (
      <div className="ql-card" data-testid="quick-card" aria-busy="true">
        <p className="ql-status" data-testid="quick-status">
          正在查词典…
        </p>
      </div>
    );
  if (state.kind === "miss" || state.kind === "empty") {
    const text = state.kind === "miss" ? missText(state.key, state.dictDown, state.onlineDown) : "请输入英文单词或短语。";
    return (
      <div className="ql-card" data-testid="quick-card">
        <p className="ql-status" data-testid="quick-status">
          {text}
        </p>
      </div>
    );
  }
  const view = state.view;
  const kicker = state.via === "dict" ? "离线词典" : state.dictDown ? "在线释义 · 离线词典没打开" : "在线释义 · 离线词典没有这一条";
  const notes = view.senses
    .filter((s) => s.src !== "词典")
    .map((s) => s.text)
    .join("\n");
  return (
    <div className="ql-card" data-testid="quick-card">
      <p className="ql-kicker">{kicker}</p>
      <h3 className="ql-word" lang="en" data-testid="quick-headword">
        {view.headword}
      </h3>
      {view.ipa && <p className="ql-ipa">音标 {view.ipa}</p>}
      {view.formNote && (
        <p className="ql-note" data-testid="quick-form">
          {view.formNote}
        </p>
      )}
      <SenseList view={view} />
      <div className="ql-actions">
        <SpeakButton text={view.headword} />
        <SaveButton text={view.headword} meaning={view.meaning} notes={notes} sentence={view.headword} />
      </div>
      {view.headword.split(" ").length <= 4 && <MuskLine q={view.headword} />}
    </div>
  );
}

function ChinesePane({ q }: { q: string }) {
  const [context, setContext] = useState("");
  const [pending, setPending] = useState(true);
  const [result, setResult] = useState<Suggestion | null>(null);
  const [error, setError] = useState<SuggestError | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [literal, setLiteral] = useState<string | null | "loading" | "fail">(null);
  const [gloss, setGloss] = useState<{ ipa: string; zh: string; down: boolean } | null>(null);

  useEffect(() => {
    let live = true;
    setPending(true);
    setError(null);
    setPicked(null);
    const ctx = context.trim();
    const timer = setTimeout(() => {
      suggestExpression(q, ctx).then((r) => {
        if (!live) return;
        setPending(false);
        if (r.ok) setResult(r.data);
        else setError(r.error);
      });
    }, 360);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, context]);

  const shown = result && picked !== null ? result.alternatives[picked] : result?.primary;
  useEffect(() => {
    if (!shown) return;
    let live = true;
    dictGloss(shown.expression).then((g) => live && setGloss(g));
    return () => {
      live = false;
    };
  }, [shown]);

  const loadLiteral = () => {
    setLiteral("loading");
    translateToEn(context.trim() ? `${q}（${context.trim()}）` : q).then((t) => setLiteral(t || "fail"));
  };

  if (!result && pending)
    return (
      <div className="ql-card" data-testid="quick-card" aria-busy="true">
        <p className="ql-status" data-testid="quick-status">
          在想一个贴合的英文说法…
        </p>
      </div>
    );
  if (!result && error)
    return (
      <div className="ql-card" data-testid="quick-card">
        <p className="ql-status" data-testid="quick-status">
          {ZH_ERROR[error]}
        </p>
        <button type="button" className="ql-btn" data-testid="quick-mt" onClick={loadLiteral}>
          查看机器直译（仅供参考）
        </button>
        {literal === "loading" && <p className="ql-mt">正在取机器直译…</p>}
        {literal && literal !== "loading" && literal !== "fail" && (
          <p className="ql-mt" data-testid="quick-literal">
            机器直译，不是说法建议：{literal}
          </p>
        )}
        {literal === "fail" && <p className="ql-mt">机器直译没有返回。</p>}
        <ContextField value={context} onChange={setContext} />
      </div>
    );
  if (!result || !shown) return null;
  const example = "example" in shown ? shown.example : undefined;
  const notes = example ? `${example.en}\n${example.zh}` : "";
  return (
    <div className="ql-card" data-testid="quick-card" aria-busy={pending}>
      <p className="ql-kicker">{picked === null ? "一种贴合的说法" : "备选说法"}</p>
      <h3 className="ql-word" lang="en" data-testid="quick-headword">
        {shown.expression}
      </h3>
      {gloss?.ipa && <p className="ql-ipa">音标 {gloss.ipa}</p>}
      <p className="ql-usage" lang="zh" data-testid="quick-usage">
        {shown.usage}
      </p>
      {example && (
        <div className="ql-ex" data-testid="quick-example">
          <span lang="en">{example.en}</span>
          <span lang="zh">{example.zh}</span>
        </div>
      )}
      {gloss && !gloss.down && gloss.zh && <p className="ql-dict">词典：{gloss.zh}</p>}
      {gloss && !gloss.down && !gloss.zh && <p className="ql-src">离线词典没有这条原文。上面的用法是模型写的，不是词典义。</p>}
      {gloss?.down && <p className="ql-src">离线词典没加载成功，所以上面没有附词典义。</p>}
      <div className="ql-actions">
        <SpeakButton text={shown.expression} disabled={pending} />
        <SaveButton text={shown.expression} meaning={shown.usage} notes={notes} sentence={example?.en || shown.expression} disabled={pending} />
        {picked !== null && (
          <button type="button" className="ql-btn" onClick={() => setPicked(null)}>
            回到首选
          </button>
        )}
      </div>
      <p className="ql-src">来自表达建议（模型）。只针对当前这句{context.trim() ? "和情境" : ""}，不是放之四海的唯一答案。</p>
      {pending && <p className="ql-note">正在按新的情境重想，先别保存这一条。</p>}
      {error && <p className="ql-note">{ZH_ERROR[error]} 仍显示上一条。</p>}
      {result.alternatives.length > 0 && picked === null && (
        <details className="ql-alts">
          <summary>其他说法 · {result.alternatives.length}</summary>
          <ul>
            {result.alternatives.map((alt, i) => (
              <li key={alt.expression} className="ql-alt" data-testid="quick-alt">
                <div>
                  <b lang="en">{alt.expression}</b>
                  <span>{alt.usage}</span>
                </div>
                <button type="button" className="ql-btn" onClick={() => setPicked(i)}>
                  用这个
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <ContextField value={context} onChange={setContext} />
      {!pending && shown.expression.split(" ").length <= 4 && <MuskLine q={shown.expression} />}
    </div>
  );
}

function ContextField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="ql-ctx">
      <span>补充情境</span>
      <input value={value} maxLength={80} placeholder="例如：听到一首歌" data-testid="quick-context" onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export function QuickLookup({ raw }: { raw: string }) {
  if (raw.trim().length > 160)
    return (
      <div className="ql-card" data-testid="quick-card">
        <p className="ql-status" data-testid="quick-status">
          请缩短到一两句。
        </p>
      </div>
    );
  const kind = classifyQuery(raw);
  if (kind.kind === "zh") return <ChinesePane key={kind.q} q={kind.q} />;
  if (kind.kind === "en") return <EnglishPane key={kind.key} word={kind.key} />;
  return (
    <div className="ql-card" data-testid="quick-card">
      <p className="ql-status" data-testid="quick-status">
        请输入英文单词，或一句中文。
      </p>
    </div>
  );
}
