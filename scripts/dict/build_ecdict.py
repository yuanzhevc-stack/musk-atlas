#!/usr/bin/env python3
"""Build public/dict/ from ECDICT (https://github.com/skywind3000/ECDICT, MIT).
Usage: python3 scripts/dict/build_ecdict.py /path/to/ecdict.csv /path/to/lemma.en.txt
Output: public/dict/manifest.json + public/dict/<prefix>.json shards
  shard = {"w": {key: [phonetic, zh, en]}, "l": {inflected form: lemma}}
Trims: unranked capitalised headwords, non-ASCII/digit headwords, >40 chars, web-only ([网络]) phrases without rank, long glosses."""
import csv, json, os, re, sys, shutil
from collections import defaultdict

src, lemma_txt = sys.argv[1], sys.argv[2]
out = os.path.join(os.path.dirname(__file__), "../../public/dict")
OK = re.compile(r"^[a-z][a-z' .\-]*[a-z.]$|^[a-z]$")
MAX_SHARD = 400_000

def clean_zh(t: str) -> str:
    lines = [l.strip() for l in t.split("\\n") if l.strip()]
    main = [l for l in lines if not l.startswith("[网络]")]
    lines = main or lines
    s = "\n".join(lines)
    return s[:160]

def clean_en(d: str) -> str:
    lines = [l.strip() for l in d.split("\\n") if l.strip()][:2]
    return "\n".join(l[:140] for l in lines)

entries = {}
forms = {}
rank = {}
for r in csv.DictReader(open(src, encoding="utf-8")):
    w = r["word"].strip()
    k = re.sub(r"\s+", " ", w.lower().replace("\u2019", "'"))
    if len(k) > 40 or not OK.match(k):
        continue
    zh = r["translation"].strip()
    if not zh:
        continue
    ranked = any(r[f] not in ("", "0") for f in ("bnc", "frq", "collins", "oxford")) or bool(r["tag"])
    if " " in k and zh.startswith("[网络]") and "\\n" not in zh and not ranked:
        continue  # web-only phrase gloss, mostly noise
    if w != k and not ranked and w[:1].isupper():
        continue  # unranked proper nouns / abbreviations
    if k in entries and w != k and entries[k][3]:
        continue  # keep the lowercase headword over a capitalised duplicate
    en = clean_en(r["definition"]) if ranked else ""
    entries[k] = [r["phonetic"].strip() if ranked or " " not in k else "", clean_zh(zh)[: 160 if ranked else 70], en, w == k]
    for part in r["exchange"].split("/"):
        if part.startswith("0:") and " " not in k:
            forms[k] = part[2:].lower()
        elif len(part) > 2 and part[1] == ":" and part[0] in "pdi3sm r":
            f = part[2:].lower()
            if f != k and " " not in k:
                forms.setdefault(f, k)
for line in open(lemma_txt, encoding="utf-8"):
    if line.startswith(";") or "->" not in line:
        continue
    a, b = line.split("->")
    lem = a.split("/")[0].strip().lower()
    for f in b.split(","):
        f = f.strip().lower()
        if f and f != lem and lem in entries:
            forms[f] = lem
forms = {f: l for f, l in forms.items() if l in entries and f != l}

def pref(k, n):
    s = re.sub(r"[^a-z]", "", k)[:n]
    return s.ljust(n, "_")

# adaptive sharding: 2-letter prefix, split to 3/4 letters when too big
def size(ks):
    return sum(len(json.dumps([k] + entries[k][:3], ensure_ascii=False).encode()) for k in ks)
keys = sorted(set(entries) | set(forms))
groups = defaultdict(list)
for k in keys:
    groups[pref(k, 2)].append(k)
final = {}
stack = [(p, ks, 2) for p, ks in groups.items()]
while stack:
    p, ks, n = stack.pop()
    if n < 5 and size([k for k in ks if k in entries]) > MAX_SHARD:
        sub = defaultdict(list)
        for k in ks:
            sub[pref(k, n + 1)].append(k)
        stack += [(q, v, n + 1) for q, v in sub.items()]
    else:
        final[p] = ks
shutil.rmtree(out, ignore_errors=True)
os.makedirs(out)
total = 0
for p, ks in final.items():
    data = {"w": {k: entries[k][:3] for k in ks if k in entries}, "l": {k: forms[k] for k in ks if k in forms}}
    s = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    open(os.path.join(out, f"{p}.json"), "w", encoding="utf-8").write(s)
    total += len(s.encode())
man = {"version": 1, "source": "ECDICT (MIT) https://github.com/skywind3000/ECDICT", "n": len(entries), "forms": len(forms), "shards": sorted(final)}
json.dump(man, open(os.path.join(out, "manifest.json"), "w"), separators=(",", ":"))
print(f"entries {len(entries)} forms {len(forms)} shards {len(final)} bytes {total/1e6:.1f}MB")
