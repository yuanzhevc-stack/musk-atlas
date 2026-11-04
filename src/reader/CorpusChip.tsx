/** Musk page -> 我的语料库: shows the query's corpus status, or adds it with the Musk sentence as context. */
import { Quote } from "lucide-react";
import type { Hit } from "../musk/corpus";
import { toast } from "../ui/Toast";
import { muskContext } from "./MuskText";
import { normalize, reader, useReader } from "./model";

export function CorpusChip({ q, hit }: { q: string; hit?: Hit }) {
  const st = useReader();
  const key = normalize(q);
  if (!key) return null;
  const it = st.items[key];
  if (it)
    return (
      <a className="rd-chip" href="#/corpus" data-testid="corpus-chip">
        语料库 · {it.status === 5 ? "已知" : it.status === -1 ? "忽略" : `等级 ${it.status}`}
      </a>
    );
  return (
    <button
      className="rd-chip"
      data-testid="corpus-add"
      onClick={() =>
        reader.upsert(q.trim(), { status: 1 }, hit ? muskContext(hit.sentence, hit.video?.title ?? hit.sentence.v) : undefined)
      }
    >
      + 加入语料库
    </button>
  );
}

/** Save the whole Musk sentence to 语料 as a 句子 item (toggle). */
export function KeepSentence({ hit, size = 18 }: { hit: Hit; size?: number }) {
  const st = useReader();
  const key = normalize(hit.sentence.t);
  if (key.split(" ").length < 2) return null;
  const on = st.items[key]?.kind === "sentence";
  return (
    <button
      className={`icon-btn keep-sent ${on ? "is-on" : ""}`}
      aria-label={on ? "移出语料" : "存整句到语料"}
      title={on ? "移出语料" : "存整句到语料"}
      data-testid="keep-musk"
      onClick={(e) => {
        e.stopPropagation();
        const saved = reader.toggleSentence(hit.sentence.t, muskContext(hit.sentence, hit.video?.title ?? hit.sentence.v));
        toast(saved ? "已存为句子" : "已移出语料", "ok");
      }}
    >
      <Quote size={size} fill={on ? "currentColor" : "none"} />
    </button>
  );
}
