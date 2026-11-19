#!/usr/bin/env python3
"""Download one full YouTube lesson and store it on the existing R2 bucket.

This runs on a machine the parent starts. It is not a Cloudflare Worker and not
this cloud VM. It does not use cookies, proxies, or a private YouTube client.

Environment:
  CACHE_WORKER_URL   https://musk-atlas-tts.yuanzhevc.workers.dev
  CACHE_JOB_SECRET   same value as `wrangler secret put CACHE_JOB_SECRET`
  The machine also needs `yt-dlp`, `ffmpeg`, `ffprobe`, and `npx wrangler` logged into
  the account that owns bucket musk-atlas-clips.

YouTube refusing the download is reported as refused and is not retried here.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request

MIN_BYTES = 2_000_000
MIN_SECONDS = 20
REFUSED_MARKS = ("sign in to confirm", "not a bot", "login required", "confirm you’re not a bot", "confirm you're not a bot")


def classify_ytdlp(code: int, text: str) -> str:
    low = text.lower()
    if any(mark in low for mark in REFUSED_MARKS):
        return "refused"
    if code == 0:
        return "downloaded"
    return "failed"


def ffprobe_duration(path: str) -> float:
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
        text=True,
    )
    return float(out.strip())


def post(url: str, secret: str, payload: dict) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read().decode())


def upload(bucket: str, video_id: str, path: str) -> None:
    wrangler = shutil.which("wrangler") or shutil.which("npx")
    if not wrangler:
        raise RuntimeError("uploader-missing")
    cmd = [wrangler] if shutil.which("wrangler") else ["npx", "wrangler"]
    cmd += ["r2", "object", "put", f"{bucket}/full/{video_id}.mp4", "--file", path, "--content-type", "video/mp4", "--remote"]
    subprocess.check_call(cmd)


def run_once(worker: str, secret: str, bucket: str = "musk-atlas-clips") -> int:
    claimed = post(worker.rstrip("/") + "/full/claim", secret, {})
    job = claimed.get("job")
    if not job:
        print("no queued full-video job")
        return 0
    video_id = str(job.get("v") or "")
    if len(video_id) != 11 or "/" in video_id or "." in video_id:
        print("refusing a job that is not a youtube id")
        return 1
    with tempfile.TemporaryDirectory(prefix="full-cache-") as tmp:
        target = os.path.join(tmp, f"{video_id}.mp4")
        proc = subprocess.run(
            [
                "yt-dlp",
                "--no-playlist",
                "--no-cache-dir",
                "--retries",
                "2",
                "-f",
                "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
                "-o",
                target,
                f"https://www.youtube.com/watch?v={video_id}",
            ],
            capture_output=True,
            text=True,
        )
        text = (proc.stdout or "") + "\n" + (proc.stderr or "")
        kind = classify_ytdlp(proc.returncode, text)
        if kind != "downloaded" or not os.path.isfile(target) or target.endswith(".part"):
            post(worker.rstrip("/") + "/full/result", secret, {"v": video_id, "outcome": "refused" if kind == "refused" else "failed", "error": text[-180:]})
            print(kind)
            return 2
        size = os.path.getsize(target)
        try:
            duration = ffprobe_duration(target)
        except (subprocess.CalledProcessError, ValueError):
            duration = 0
        if size < MIN_BYTES or duration < MIN_SECONDS:
            post(worker.rstrip("/") + "/full/result", secret, {"v": video_id, "outcome": "failed", "bytes": size, "duration": duration, "error": "not-a-full-video"})
            print(f"rejected size={size} duration={duration}")
            return 3
        try:
            upload(bucket, video_id, target)
        except (RuntimeError, subprocess.CalledProcessError) as exc:
            post(worker.rstrip("/") + "/full/result", secret, {"v": video_id, "outcome": "failed", "error": str(exc)[:180]})
            print(exc)
            return 4
        post(worker.rstrip("/") + "/full/result", secret, {"v": video_id, "outcome": "ready", "bytes": size, "duration": duration})
        print(f"ready {video_id} bytes={size} duration={duration}")
        return 0


def main() -> int:
    worker = os.environ.get("CACHE_WORKER_URL", "")
    secret = os.environ.get("CACHE_JOB_SECRET", "")
    if not worker or not secret:
        print("CACHE_WORKER_URL and CACHE_JOB_SECRET are required. This script does not download without them.", file=sys.stderr)
        return 1
    if shutil.which("yt-dlp") is None or shutil.which("ffprobe") is None:
        print("yt-dlp and ffprobe must be installed on the machine that runs this.", file=sys.stderr)
        return 1
    return run_once(worker, secret)


if __name__ == "__main__":
    raise SystemExit(main())
