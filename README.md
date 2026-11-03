# Musk Atlas

Search a word or phrase → see every moment Elon Musk says it → play the clip from that second (YouTube embed).

Live: https://yuanzhevc-stack.github.io/musk-atlas/

- Corpus: text + word timestamps only (`public/musk/corpus.json`), built from YouTube captions / faster-whisper. Videos stay on YouTube; rights belong to their uploaders.
- Re-export corpus: `python3 scripts/musk/export_corpus.py /path/to/corpus.db`
- Dev: `npm ci && npm run dev` · Pages build: `ATLAS_BASE=/musk-atlas/ npm run build`

## Credits & license

Personal-use adaptation of [Word Atlas 词光](https://github.com/designfuchen/word-atlas) by @designfuchen.

- Code: MIT (see `LICENSE`).
- Word-list text in `public/atlas/` (index/entries): **Word Atlas contributors — [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)**, modified (illustrations, recordings and sound effects removed; text only). See `CONTENT_LICENSE.md`.
- Original README kept as `README.word-atlas.md`.
