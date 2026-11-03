"""Two-pass ECAPA verification. pass1: cosine to Musk voiceprint (TED2017 first-half Musk turns).
pass2 (per video): if >=5 confident anchors, add video-local Musk centroid; score=max(global, local).
Label: musk if score>=HI and dur>=MIN_DUR; not_musk if score<LO; else uncertain."""
import json, sys, numpy as np
HI, LO, MIN_DUR = float(sys.argv[1]) if len(sys.argv) > 1 else 0.45, 0.25, 1.2
d = np.load("embeds.npz"); K, E = list(d["keys"]), d["embs"]; M = json.load(open("embeds_meta.json")); c = np.load("centroid.npy")
S1 = E @ c; S = S1.copy()
for vid in {m["video"] for m in M}:
    ids = [i for i, m in enumerate(M) if m["video"] == vid]
    anc = [i for i in ids if S1[i] >= 0.5 and M[i]["dur"] >= 2]
    if len(anc) >= 5:
        lc = E[anc].mean(0); lc /= np.linalg.norm(lc)
        for i in ids: S[i] = max(S1[i], E[i] @ lc)
def lab(i):
    if M[i]["dur"] < MIN_DUR: return "uncertain"  # too short for a reliable voiceprint
    if S[i] >= HI: return "musk"
    if S[i] < LO: return "not_musk"
    return "uncertain"
L = [lab(i) for i in range(len(M))]
out = {K[i]: {"label": L[i], "score": round(float(S[i]), 3)} for i in range(len(M))}
json.dump(out, open("speaker_labels.json", "w"))
# eval TED2017 held-out half (human turn labels)
def ev(ids, gt):
    tp = sum(L[i] == "musk" and gt(i) for i in ids); fp = sum(L[i] == "musk" and not gt(i) for i in ids)
    pos = sum(gt(i) for i in ids); unc = sum(L[i] == "uncertain" for i in ids)
    fn_hard = sum(L[i] == "not_musk" and gt(i) for i in ids)
    return f"n={len(ids)} pos={pos} P={tp/max(tp+fp,1):.3f} R={tp/pos:.3f} (musk={tp+fp} fp={fp}, uncertain={unc}, musk->not_musk={fn_hard})"
ted = [i for i, m in enumerate(M) if m["video"] == "zIwLWfaAg-8" and m["start"] >= 1225 and m["gt"] in ("musk", "host")]
print("TED2017 held-out:", ev(ted, lambda i: M[i]["gt"] == "musk"))
mus = {13.3,23.0,27.6,32.8,48.3,63.6,97.9,103.2,108.8,118.3,125.2,136.4,140.7,155.2,159.7,165.7,248.5}
non = {4.6,36.7,77.5,80.0,95.4,147.0,179.8,183.3,188.8,192.7,195.7,198.3,220.7,224.4,230.7}
x = [i for i, m in enumerate(M) if m["video"] == "x3tlVE_QXm4" and round(m["start"], 1) in mus | non]
print("McLaren1999 hand:", ev(x, lambda i: round(M[i]["start"], 1) in mus))
from collections import Counter
print("all:", Counter(L)); 
for v in sorted({m["video"] for m in M}): print(v, Counter(L[i] for i, m in enumerate(M) if m["video"] == v))
