"""Export musk-corpus SQLite -> public/musk/corpus.json (static, text only).
Usage: python3 scripts/musk/export_corpus.py [/workspace/musk-corpus/corpus.db]"""
import json, re, sqlite3, sys, os
DB = sys.argv[1] if len(sys.argv) > 1 else "/workspace/musk-corpus/corpus.db"
OUT = os.path.join(os.path.dirname(__file__), "../../public/musk/corpus.json")
TOK = re.compile(r"[a-z]+(?:'[a-z]+)?")
db = sqlite3.connect(DB)
videos = {}
for vid, title, channel, dur, src in db.execute("SELECT id,title,channel,duration,source FROM video"):
    videos[vid] = {"title": title, "channel": channel or "", "duration": dur, "source": src, "speaker": False}
sentences, forms, bad = [], {}, 0
for sid, vid, st, en, text, spk in db.execute("SELECT id,video,start,end,text,speaker FROM sentence ORDER BY video,start"):
    toks = db.execute("SELECT lemma,form,start,end FROM token WHERE sentence=? ORDER BY rowid", (sid,)).fetchall()
    spans = list(TOK.finditer(text.lower().replace("\u2019", "'")))
    if len(spans) != len(toks):
        bad += 1
        continue
    out = []
    for (lemma, form, ts, te), m in zip(toks, spans):
        forms[form] = lemma
        out.append([lemma, round(ts, 2), round(te, 2), m.start(), m.end()])
    if spk: videos[vid]["speaker"] = True
    sentences.append({"v": vid, "s": round(st, 2), "e": round(en, 2), "t": text, "k": spk, "w": out})
json.dump({"videos": videos, "forms": forms, "sentences": sentences}, open(OUT, "w"), ensure_ascii=False, separators=(",", ":"))
print(f"{len(videos)} videos, {len(sentences)} sentences, {len(forms)} forms, skipped {bad}; {os.path.getsize(OUT)//1024} KB -> {os.path.normpath(OUT)}")
