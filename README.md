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
- **Sentence TTS** (`src/reader/tts.ts`): ▶ before each sentence, 「连续播放」 (key `p`) highlights the sentence being read and turns pages, speed 0.75–1.5× (`playbackRate`, pitch preserved). Audio is the **xAI TTS stock voice `rex`** (a preset male English voice — no voice cloning, no Musk reference audio) via the Cloudflare Worker `workers/tts` (`https://musk-atlas-tts.yuanzhevc.workers.dev`): the xAI key is a Worker secret, allowed origins are GitHub Pages plus Vite on `localhost` / `127.0.0.1` ports `5188` and `5189`, text ≤ 600 chars, MP3s cached in R2 `musk-atlas-clips/tts/<sha256>.mp3` (repeats are free), daily budget 200k new chars (≈ $3 at $15 / 1M chars). Falls back to the browser's speech synthesis. While reading, learning words/phrases (level 1–4) with verified Musk clips get a 「听 Musk 原声」 chip (never spliced into the TTS). Deploy: `cd workers/tts && npx wrangler deploy` (+ `wrangler secret put XAI_API_KEY`).

## 快速查词（顶部「词库」/ ⌘K）

The palette used to search only the Word Atlas lesson list (`searchAtlas`). A word can be missing there and still be a normal dictionary word. `overhear` is in the bundled ECDICT (`public/dict/`, 675,534 entries) and is not in the lesson list, so the old palette stopped at 没有找到 and never opened the dictionary. Missing Musk clips are a separate fact and do not hide the entry.

The same field now:

- **English** (case and extra spaces ignored): exact ECDICT lookup, one prefix shard on demand. Inflections use the lemma (`overheard` → `overhear`, `looked at` → `look at`). The card shows the gloss with zero clips, and says so. A shard/manifest failure is not reported as “no such word”. If ECDICT has no row, online English definitions and en→zh machine translation are shown with the labels 英英 / 机器翻译. If those fail too, the card says the online lookup did not connect.
- **Chinese** (automatic, no mode switch): `POST /express` on the existing TTS Worker asks the existing xAI chat model for one expression, a short Chinese usage boundary, one bilingual example, and up to three alternatives. The card does not call that expression the universally most idiomatic translation. Alternatives stay collapsed. 「补充情境」 sends the extra line and asks again. Pronunciation reuses browser speech synthesis; 「加入语料库」 uses the existing corpus store and does not overwrite an item that is already saved. If the Worker is old, missing, rate-limited, or unreachable, the card says which of those happened. Literal zh→en MT is behind 「查看机器直译（仅供参考）」 and is never presented as the suggestion.

English lookup works as soon as this frontend is published (the dictionary shards are already in `public/dict/`). Chinese suggestions also need the Worker deploy below. `XAI_API_KEY` stays a Worker secret. Nothing in the frontend, logs, or this repo stores it.

### Deploy `/express` (do this yourself; not done from the app)

Same Worker, same secret, no new vendor. From `workers/tts`:

```bash
npx wrangler deploy
```

The key is already `wrangler secret put XAI_API_KEY` if TTS works. Optional vars, both defaulted in code when unset:

- `XAI_CHAT_MODEL` — default `grok-4.20-0309-non-reasoning` (chat completions, `max_tokens` 400). This is not the TTS voice. If xAI rejects that id, set the var to another chat model on the same key.
- `EXPRESS_DAILY` — default `200` new model calls per UTC day. Repeats are stored in R2 at `express/v1/<sha256>.json` and do not count. This budget is separate from TTS `DAILY_CHARS`. A single isolate also refuses more than 12 calls a minute from one IP.

Input is rejected unless it contains Chinese, is at most 120 characters (context 80), and the body is at most 4 KB. Model output that is not the JSON shape becomes an error, not a made-up card. Queries and the API key are not logged.
- **Review**: `reader.addToReview(key)` attaches an FSRS card (`src/store/srs.ts`); 「复习」 on the corpus page grades due items. Separate from the Word Atlas daily path (`store.cards`).

## Credits & license

Personal-use adaptation of [Word Atlas 词光](https://github.com/designfuchen/word-atlas) by @designfuchen.

- Code: MIT (see `LICENSE`).
- Word-list text in `public/atlas/` (index/entries): **Word Atlas contributors — [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)**, modified (illustrations, recordings and sound effects removed; text only). See `CONTENT_LICENSE.md`.
- Offline dictionary in `public/dict/`: [ECDICT](https://github.com/skywind3000/ECDICT) by skywind3000 — MIT, trimmed; lemma list from ECDICT `lemma.en.txt`.
- Original README kept as `README.word-atlas.md`.
