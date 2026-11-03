"""ECAPA speaker embeddings per corpus sentence -> similarity to a Musk voiceprint.
Writes speaker_scores.json: {"<video>@<startMs>": {"score":float,"dur":float}} and embeds.npz."""
import json, sqlite3, subprocess, sys, numpy as np, torch
from speechbrain.inference.speaker import EncoderClassifier
enc = EncoderClassifier.from_hparams(source="speechbrain/spkrec-ecapa-voxceleb", savedir="models/ecapa", run_opts={"device": "cpu"})
torch.set_num_threads(8)
db = sqlite3.connect("corpus.db")
def load(vid):
    pcm = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", f"video/{vid}.mp4", "-f", "s16le", "-ac", "1", "-ar", "16000", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(pcm, np.int16).astype(np.float32) / 32768
keys, embs, meta = [], [], []
for (vid,) in db.execute("SELECT id FROM video"):
    try: a = load(vid)
    except Exception as e: print("skip", vid, e); continue
    rows = db.execute("SELECT start,end,text,speaker FROM sentence WHERE video=? ORDER BY start", (vid,)).fetchall()
    for st, en, text, spk in rows:
        seg = a[int(st * 16000): int(en * 16000)]
        if len(seg) < 16000 * 0.5: seg = np.pad(seg, (0, 8000 - len(seg))) if len(seg) < 8000 else seg
        with torch.no_grad():
            e = enc.encode_batch(torch.from_numpy(seg.copy()).unsqueeze(0)).squeeze().numpy()
        keys.append(f"{vid}@{int(round(st*1000))}"); embs.append(e / np.linalg.norm(e))
        meta.append({"video": vid, "start": st, "end": en, "dur": en - st, "gt": spk, "text": text})
    print(vid, len(rows), flush=True)
np.savez("embeds.npz", keys=np.array(keys), embs=np.array(embs))
json.dump(meta, open("embeds_meta.json", "w"))
