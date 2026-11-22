/** The panel under the video. Each mode does the work its label names. */
import { useEffect, useMemo, useState } from "react";
import { Rating, preview } from "../store/srs";
import { reader, type Item } from "./model";
import { checkCloze, checkWords, clozePieces, personalCards, type DeskMode } from "./lessonDesk";

const MISSING = "没有取到译文。在线翻译没有返回，这里不会编造。";

export function LessonPractice({
  mode,
  sentence,
  translation,
  lessonId,
  items,
  keys,
  revealed,
  onReveal,
}: {
  mode: DeskMode;
  sentence: string;
  translation: string;
  lessonId: string;
  items: Record<string, Item>;
  keys: ReadonlySet<string>;
  revealed: boolean;
  onReveal: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [clozeTyped, setClozeTyped] = useState<string[]>([]);
  const [checked, setChecked] = useState(false);
  const [cardAt, setCardAt] = useState(0);
  const [cardShown, setCardShown] = useState(false);
  const cloze = useMemo(() => clozePieces(sentence), [sentence]);
  useEffect(() => {
    setTyped("");
    setClozeTyped([]);
    setChecked(false);
    setCardShown(false);
  }, [sentence, mode]);
  const cards = useMemo(() => personalCards(Object.values(items), lessonId, keys), [items, lessonId, keys]);
  const card = cards[Math.min(cardAt, Math.max(0, cards.length - 1))];

  if (mode === "dictation") {
    const result = checked ? checkWords(sentence, typed) : null;
    return (
      <div className="desk-practice" data-testid="desk-dictation">
        <p className="desk-practice-label">听写 · 对照原句的词，不是评分模型</p>
        {revealed ? <p className="desk-sentence">{sentence}</p> : <p className="desk-hidden">原句已隐藏</p>}
        <textarea value={typed} onChange={(e) => { setTyped(e.target.value); setChecked(false); }} rows={3} aria-label="听写" data-testid="dictation-input" />
        <div className="desk-practice-actions">
          <button type="button" onClick={() => setChecked(true)} data-testid="dictation-check">对照</button>
          <button type="button" onClick={onReveal} data-testid="dictation-reveal">{revealed ? "原句已显示" : "显示原句"}</button>
        </div>
        {result && (
          <p className="desk-check" data-testid="dictation-result">
            {result.correct}/{result.total} 个词按顺序一致{result.same ? "，整句一致。" : "。"}
            {result.expected.map((word, i) => (
              <span key={`${word}-${i}`} className={result.matches[i] ? "is-ok" : "is-miss"}>{word} </span>
            ))}
          </p>
        )}
      </div>
    );
  }

  if (mode === "cloze") {
    const result = checked ? checkCloze(cloze.answers, clozeTyped) : null;
    return (
      <div className="desk-practice" data-testid="desk-cloze">
        <p className="desk-practice-label">挖空 · 空出来的是句中原词</p>
        {cloze.answers.length === 0 ? <p>这一句没有可以挖掉的实词。</p> : null}
        <p className="desk-sentence">
          {cloze.pieces.map((piece, i) =>
            piece.kind === "text" ? (
              <span key={i}>{piece.text}</span>
            ) : (
              <input
                key={i}
                className="desk-blank"
                aria-label={`填空 ${piece.text.length} 个字母`}
                value={clozeTyped[cloze.pieces.slice(0, i).filter((p) => p.kind === "blank").length] ?? ""}
                onChange={(e) => {
                  const n = cloze.pieces.slice(0, i).filter((p) => p.kind === "blank").length;
                  setClozeTyped((prev) => {
                    const next = prev.slice();
                    next[n] = e.target.value;
                    return next;
                  });
                  setChecked(false);
                }}
                data-testid="cloze-input"
              />
            ),
          )}
        </p>
        <div className="desk-practice-actions">
          <button type="button" onClick={() => setChecked(true)} data-testid="cloze-check">对照</button>
          <button type="button" onClick={onReveal} data-testid="cloze-reveal">{revealed ? "答案已显示" : "显示答案"}</button>
        </div>
        {revealed && <p data-testid="cloze-answers">{cloze.answers.join(" · ") || "没有挖空。"}</p>}
        {result && <p data-testid="cloze-result">{result.correct}/{result.total} 个空按顺序一致{result.same ? "，全部一致。" : "。"}</p>}
      </div>
    );
  }

  if (mode === "zh2en") {
    const missing = !translation || translation === MISSING;
    const result = checked && !missing ? checkWords(sentence, typed) : null;
    return (
      <div className="desk-practice" data-testid="desk-zh2en">
        <p className="desk-practice-label">中译英 · 用已有译文出题</p>
        {missing ? (
          <p data-testid="zh2en-missing">没有译文，不能出题，也不会给一个编造的分数。</p>
        ) : (
          <>
            <p className="desk-sentence">{translation}</p>
            <textarea value={typed} onChange={(e) => { setTyped(e.target.value); setChecked(false); }} rows={3} aria-label="英文回答" data-testid="zh2en-input" />
            <div className="desk-practice-actions">
              <button type="button" onClick={() => setChecked(true)} data-testid="zh2en-check">对照原句</button>
              <button type="button" onClick={onReveal} data-testid="zh2en-reveal">{revealed ? "原句已显示" : "显示原句"}</button>
            </div>
            {revealed && <p className="desk-sentence">{sentence}</p>}
            {result && <p data-testid="zh2en-result">{result.correct}/{result.total} 个词按顺序一致{result.same ? "，整句一致。" : "。"}</p>}
          </>
        )}
      </div>
    );
  }

  if (mode === "cards") {
    if (!card) return <p className="desk-practice" data-testid="desk-cards-empty">这节课还没有收入语料库的词。点字幕里的词可以保存，这里不会放示例卡片。</p>;
    const item = items[card.key];
    const waits = item?.srs ? preview(item.srs, Date.now()) : null;
    const label = (ms: number) => (ms < 60_000 ? "不到 1 分钟" : ms < 3_600_000 ? `${Math.round(ms / 60_000)} 分钟` : ms < 86_400_000 ? `${Math.round(ms / 3_600_000)} 小时` : `${Math.round(ms / 86_400_000)} 天`);
    return (
      <div className="desk-practice" data-testid="desk-cards">
        <p className="desk-practice-label">词卡 · {cardAt + 1}/{cards.length} · 用已保存的词和 FSRS</p>
        <p className="desk-sentence">{cardShown ? card.text : card.meaning || "这个词还没有写下中文。"}</p>
        <div className="desk-practice-actions">
          <button type="button" onClick={() => setCardShown((v) => !v)} data-testid="card-reveal">{cardShown ? "已显示" : "显示词"}</button>
          {!card.hasSrs && <button type="button" onClick={() => reader.addToReview(card.key)} data-testid="card-add">加入复习</button>}
          {card.hasSrs && waits && (
            <>
              <button type="button" onClick={() => reader.grade(card.key, Rating.Again)}>重来 · {label(waits[Rating.Again])}</button>
              <button type="button" onClick={() => reader.grade(card.key, Rating.Good)} data-testid="card-good">记得 · {label(waits[Rating.Good])}</button>
            </>
          )}
          <button type="button" onClick={() => { setCardAt((n) => (n + 1) % cards.length); setCardShown(false); }} disabled={cards.length < 2}>下一张</button>
        </div>
      </div>
    );
  }

  return null;
}
