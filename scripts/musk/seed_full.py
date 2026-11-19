#!/usr/bin/env python3
"""Upload the five already-complete box videos through the Worker.

Does not download YouTube and does not touch Dan Koe (d5RKW3WSEb0) or any .part file.
Requires CACHE_WORKER_URL and CACHE_JOB_SECRET. The R2 credential stays on the Worker.
If the secret is not set yet, this prints ffprobe metadata and uploads nothing.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

from cache_full import MIN_BYTES, MIN_SECONDS, ffprobe_duration, upload_via_worker

ROOT = os.environ.get("MUSK_VIDEO_DIR", "/workspace/musk-corpus/video")
IDS = ("n1j0yHOxcL0", "zIwLWfaAg-8", "cdZZpaB2kDM", "x3tlVE_QXm4", "s9mczdODqzo")


def main() -> int:
    rows = []
    for video_id in IDS:
        path = os.path.join(ROOT, f"{video_id}.mp4")
        if not os.path.isfile(path) or path.endswith(".part"):
            rows.append({"v": video_id, "status": "missing"})
            continue
        size = os.path.getsize(path)
        try:
            duration = ffprobe_duration(path)
        except (subprocess.CalledProcessError, ValueError):
            rows.append({"v": video_id, "status": "unreadable", "bytes": size})
            continue
        if size < MIN_BYTES or duration < MIN_SECONDS:
            rows.append({"v": video_id, "status": "not-full", "bytes": size, "duration": duration})
            continue
        rows.append({"v": video_id, "status": "measured", "bytes": size, "duration": duration, "path": path})
    print(json.dumps([{k: v for k, v in row.items() if k != "path"} for row in rows], indent=2))
    worker = os.environ.get("CACHE_WORKER_URL", "")
    secret = os.environ.get("CACHE_JOB_SECRET", "")
    if not worker or not secret:
        print("CACHE_JOB_SECRET is not set, so nothing was uploaded and nothing was marked ready.", file=sys.stderr)
        return 2
    for row in rows:
        if row["status"] != "measured":
            continue
        upload_via_worker(worker, secret, row["v"], row["path"], row["bytes"], row["duration"])
        row["status"] = "uploaded"
        print(f"uploaded {row['v']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
