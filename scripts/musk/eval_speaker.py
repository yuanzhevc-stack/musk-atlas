import json, numpy as np
d = np.load("embeds.npz"); K, E = d["keys"], d["embs"]; M = json.load(open("embeds_meta.json"))
ted = [i for i, m in enumerate(M) if m["video"] == "zIwLWfaAg-8"]
print("gt values", {M[i]["gt"] for i in ted})
half = 1225
train = [i for i in ted if M[i]["gt"] == "musk" and M[i]["start"] < half and M[i]["dur"] >= 3]
test = [i for i in ted if M[i]["start"] >= half and M[i]["gt"] in ("musk", "host")]
c = E[train].mean(0); c /= np.linalg.norm(c)
S = E @ c
print("train", len(train), "test", len(test), "test musk", sum(M[i]["gt"] == "musk" for i in test))
def pr(ids, t):
    tp = sum(S[i] >= t and M[i]["gt"] == "musk" for i in ids); fp = sum(S[i] >= t and M[i]["gt"] != "musk" for i in ids)
    pos = sum(M[i]["gt"] == "musk" for i in ids)
    return tp / max(tp + fp, 1), tp / pos, tp, fp
for t in np.arange(0.2, 0.75, 0.05):
    p, r, tp, fp = pr(test, t); p2, r2, *_ = pr([i for i in test if M[i]["dur"] >= 1.5], t)
    print(f"t={t:.2f} P={p:.3f} R={r:.3f} tp={tp} fp={fp} | dur>=1.5 P={p2:.3f} R={r2:.3f}")
for g in ("musk", "host"):
    v = [S[i] for i in test if M[i]["gt"] == g]; print(g, np.percentile(v, [5, 25, 50, 75, 95]).round(2))
for vid in sorted({m["video"] for m in M}):
    v = np.array([S[i] for i, m in enumerate(M) if m["video"] == vid]); print(vid, len(v), np.percentile(v, [5, 25, 50, 75, 95]).round(2))
np.save("centroid.npy", c)
