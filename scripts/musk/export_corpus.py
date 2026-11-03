"""Export musk-corpus SQLite -> public/musk/corpus.json (static, text only).
Usage: python3 scripts/musk/export_corpus.py [/workspace/musk-corpus/corpus.db]"""
import json, re, sqlite3, sys, os
DB = sys.argv[1] if len(sys.argv) > 1 else "/workspace/musk-corpus/corpus.db"
PUB = os.path.join(os.path.dirname(__file__), "../../public")
OUT = os.path.join(PUB, "musk/corpus.json")
TOK = re.compile(r"[a-z]+(?:'[a-z]+)?")
db = sqlite3.connect(DB)
# ECAPA speaker verification (musk-corpus/label_speaker.py): {"<vid>@<startMs>": {"label","score"}}
SPK_PATH = os.path.join(os.path.dirname(DB), "speaker_labels.json")
SPK = json.load(open(SPK_PATH)) if os.path.exists(SPK_PATH) else {}
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
    rel = f"musk/clips/{vid}/{int(round(st * 1000))}.mp4"  # keep in sync with cut_clips.py
    clip = rel if os.path.exists(os.path.join(PUB, rel)) else None
    ver = SPK.get(f"{vid}@{int(round(st * 1000))}", {})
    # k = human turn label (TED subs only); m = voiceprint label musk|uncertain|not_musk; p = cosine score
    sentences.append({"v": vid, "s": round(st, 2), "e": round(en, 2), "t": text, "k": spk, "m": ver.get("label"), "p": ver.get("score"), "w": out, "c": clip})
json.dump({"videos": videos, "forms": forms, "sentences": sentences}, open(OUT, "w"), ensure_ascii=False, separators=(",", ":"))
from collections import Counter
print("voiceprint labels:", dict(Counter(x["m"] for x in sentences)))
print(f"{sum(1 for x in sentences if x['c'])} clips, {len(videos)} videos, {len(sentences)} sentences, {len(forms)} forms, skipped {bad}; {os.path.getsize(OUT)//1024} KB -> {os.path.normpath(OUT)}")
