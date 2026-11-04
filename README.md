# Musk Atlas

Search a word or phrase → see every moment Elon Musk says it → play the clip from that second (YouTube embed).

Live: https://yuanzhevc-stack.github.io/musk-atlas/

- Corpus: text + word timestamps only (`public/musk/corpus.json`), built from YouTube captions / faster-whisper. Videos stay on YouTube; rights belong to their uploaders.
- Re-export corpus: `python3 scripts/musk/export_corpus.py /path/to/corpus.db`
- Dev: `npm ci && npm run dev` · Pages build: `ATLAS_BASE=/musk-atlas/ npm run build`

## Reader / 我的语料库 (LingQ-style)

Routes: `#/reader` (lesson library, `#/reader?l=<lessonId>&s=<sentenceIdx>` opens a lesson at a sentence) · `#/corpus` (My Corpus).

- Import a lesson (title, optional source URL, pasted text). Text is split into paragraphs → sentences → word tokens, paged at ~220 words.
- Word colours as in LingQ: blue = new (not in corpus), yellow 1–4 fading = learning, known = no highlight, ignored = no highlight. Saved phrases get a yellow underline.
- Click a word → side panel (desktop ≥960px) / bottom sheet (phone, iPad portrait). Meanings (`src/reader/dict.ts`), shown as tappable suggestions with a source label: bundled offline **ECDICT** (`public/dict/`, sharded by prefix, one ≤400 KB shard per lookup, lemma/inflection aware: looks→look; rebuild with `python3 scripts/dict/build_ecdict.py ecdict.csv lemma.en.txt`) → Word Atlas lexicon → machine translation for phrases / misses (MyMemory, then Google gtx, 5 s timeout) → [dictionaryapi.dev](https://dictionaryapi.dev) English. Cached in memory + localStorage `musk-atlas:meaning:v1`. Saving with an empty meaning fills in the first suggestion. Editable meaning + notes, status 1–4 / known / ignore. TTS via the browser's speech synthesis (no recorded audio shipped).
- Phrases: mouse-drag or Shift-click a second word; on touch use 「向前/向后扩展」.
- Keys: `←/→` next/prev blue-or-yellow word · `b` next blue · `1–4` level · `k` known · `x` ignore · `h` edit meaning · `↑/↓ Enter` pick a hint · `s` speak · `m` play Musk · `Shift+←/→` page · `+/-` font size · `Esc` close. 「本页读完」 marks all remaining blue words on the page known and turns the page.

### Data model and integration points

All in `src/reader/model.ts`, stored in localStorage key `musk-atlas:reader:v1` (**per device/browser** — use 导出/导入 JSON on the corpus page to move between devices; import merges by `updated`).

```ts
Item { key, text, kind: "word"|"phrase", status: 1|2|3|4|5|-1, meaning, notes,
       ctx?: { lesson, title, sid, sentence, musk?: { v, t } }, created, updated, srs?: CardState }
```

- `key = normalize(text)`: lowercase, straight apostrophes, single spaces. This is the join key with Musk.
- **Reader/Corpus → Musk**: `src/reader/MuskSays.tsx` calls `candidates(key)` + `materialize()` from `src/musk/corpus.ts` (sharded index in `public/musk/index/`, word-prefix files `l/<xx>.json`, lemmatized there), verified-Musk sentences first (falls back to "uncertain", never `not_musk`), and plays them with the shared `ClipPlayer` (clips on R2). Shown in the reader panel, each corpus row, and review cards. 「全部 ›」 opens `#/?q=<key>`.
- **Musk → Corpus**: the Musk search page shows a `CorpusChip` (`src/reader/CorpusChip.tsx`): the query's corpus status, or 「+ 加入语料库」 with the current Musk sentence as context (`ctx.lesson = "musk"`, `ctx.musk = {v, t}`). The corpus page can also import the existing Musk phrasebook (`src/musk/vocab.ts`).
- **Interactive Musk text**: every Musk transcript line (search results, the big stage sentence, 「Musk 怎么说」 rows) is rendered by `src/reader/MuskText.tsx` with LingQ tints; tap a word / drag or ⇧-click a phrase (touch: tap + 「向后扩展」) opens the floating card `src/reader/GlobalCard.tsx` (selection store `src/reader/select.ts`). Saved items get `ctx.musk = {v, t, ms}` + `sid` = sentence id; the corpus link `#/?q=<key>&c=<sid>` reopens that exact clip. Tapping words never plays the row; the ▶ button / empty space does.
- **Review**: `reader.addToReview(key)` attaches an FSRS card (`src/store/srs.ts`); 「复习」 on the corpus page grades due items. Separate from the Word Atlas daily path (`store.cards`).

## Credits & license

Personal-use adaptation of [Word Atlas 词光](https://github.com/designfuchen/word-atlas) by @designfuchen.

- Code: MIT (see `LICENSE`).
- Word-list text in `public/atlas/` (index/entries): **Word Atlas contributors — [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)**, modified (illustrations, recordings and sound effects removed; text only). See `CONTENT_LICENSE.md`.
- Offline dictionary in `public/dict/`: [ECDICT](https://github.com/skywind3000/ECDICT) by skywind3000 — MIT, trimmed; lemma list from ECDICT `lemma.en.txt`.
- Original README kept as `README.word-atlas.md`.
