"""Cut one mp4 clip per corpus sentence (start-0.3s .. end+0.3s) for native in-page playback.
Usage: python3 scripts/musk/cut_clips.py [corpus.db] [video_dir]
Output: public/musk/clips/<videoId>/<startMs>.mp4 (H.264 main + AAC mono, 360p, faststart). Skips existing files."""
import os, sqlite3, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
DB = sys.argv[1] if len(sys.argv) > 1 else "/workspace/musk-corpus/corpus.db"
VDIR = sys.argv[2] if len(sys.argv) > 2 else "/workspace/musk-corpus/video"
OUT = os.path.join(os.path.dirname(__file__), "../../public/musk/clips")
PAD = 0.3
CRF = os.environ.get("CLIP_CRF", "31")

def clip_rel(vid, start):  # keep in sync with export_corpus.py
    return f"musk/clips/{vid}/{int(round(start * 1000))}.mp4"

def cut(job):
    src, dst, s, d = job
    if os.path.exists(dst): return "skip"
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = dst + ".tmp.mp4"
    r = subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", f"{s:.2f}", "-i", src, "-t", f"{d:.2f}",
        "-vf", "scale=-2:360,fps=25", "-c:v", "libx264", "-profile:v", "main", "-preset", "veryfast", "-crf", CRF,
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", "-ac", "1", "-movflags", "+faststart", tmp], capture_output=True)
    if r.returncode: return "fail " + r.stderr.decode()[:200]
    os.replace(tmp, dst); return "ok"

db = sqlite3.connect(DB)
jobs = []
for vid, st, en in db.execute("SELECT video,start,end FROM sentence ORDER BY video,start"):
    src = os.path.join(VDIR, f"{vid}.mp4")
    if not os.path.exists(src): continue
    s = max(0, st - PAD)
    jobs.append((src, os.path.join(OUT, "..", "..", clip_rel(vid, st)), s, en + PAD - s))
with ThreadPoolExecutor(os.cpu_count() or 4) as ex:
    res = list(ex.map(cut, jobs))
from collections import Counter
print(Counter(r.split()[0] for r in res), [r for r in res if r.startswith("fail")][:3])
