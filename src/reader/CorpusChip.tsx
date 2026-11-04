/** Musk page -> 我的语料库: shows the query's corpus status, or adds it with the Musk sentence as context. */
import type { Hit } from "../musk/corpus";
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
