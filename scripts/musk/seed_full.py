#!/usr/bin/env python3
"""Seed already-complete full videos into R2. Does not download YouTube.

Only these five ids, and only if /workspace/musk-corpus/video/{id}.mp4 exists,
is a real file (not a .part), and ffprobe says it is at least 20 seconds and 2 MB.
Dan Koe (d5RKW3WSEb0) is intentionally absent. Incomplete parts are ignored.

Upload uses `wrangler r2 object put` against bucket musk-atlas-clips.
This does not mark a lesson ready. Ready still requires the Worker secret
and a size check. If wrangler is not logged in, the script prints metadata and exits.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys

ROOT = os.environ.get("MUSK_VIDEO_DIR", "/workspace/musk-corpus/video")
BUCKET = "musk-atlas-clips"
IDS = ("n1j0yHOxcL0", "zIwLWfaAg-8", "cdZZpaB2kDM", "x3tlVE_QXm4", "s9mczdODqzo")
MIN_BYTES = 2_000_000
MIN_SECONDS = 20


def probe(path: str) -> float:
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
        text=True,
    )
    return float(out.strip())


def main() -> int:
    if shutil.which("ffprobe") is None:
        print("ffprobe is required", file=sys.stderr)
        return 1
    rows = []
    for video_id in IDS:
        if video_id == "d5RKW3WSEb0" or ".part" in video_id:
            continue
        path = os.path.join(ROOT, f"{video_id}.mp4")
        if not os.path.isfile(path) or path.endswith(".part"):
            rows.append({"v": video_id, "status": "missing"})
            continue
        size = os.path.getsize(path)
        try:
            duration = probe(path)
        except (subprocess.CalledProcessError, ValueError):
            rows.append({"v": video_id, "status": "unreadable", "bytes": size})
            continue
        if size < MIN_BYTES or duration < MIN_SECONDS:
            rows.append({"v": video_id, "status": "not-full", "bytes": size, "duration": duration})
            continue
        rows.append({"v": video_id, "status": "measured", "bytes": size, "duration": duration, "path": path})
    print(json.dumps(rows, indent=2))
    uploadable = [r for r in rows if r["status"] == "measured"]
    if not uploadable:
        print("no local full file to upload", file=sys.stderr)
        return 2
    if shutil.which("wrangler") is None and shutil.which("npx") is None:
        print("wrangler is not installed; metadata only, nothing uploaded", file=sys.stderr)
        return 3
    who = subprocess.run(["wrangler", "whoami"] if shutil.which("wrangler") else ["npx", "wrangler", "whoami"], capture_output=True, text=True)
    if who.returncode != 0:
        print("wrangler is not logged in and R2_API_TOKEN is not used by this script; nothing uploaded", file=sys.stderr)
        print(who.stderr[-400:], file=sys.stderr)
        return 4
    for row in uploadable:
        cmd = ["wrangler"] if shutil.which("wrangler") else ["npx", "wrangler"]
        cmd += ["r2", "object", "put", f"{BUCKET}/full/{row['v']}.mp4", "--file", row["path"], "--content-type", "video/mp4", "--remote"]
        subprocess.check_call(cmd)
        row["status"] = "uploaded"
    print(json.dumps(rows, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
