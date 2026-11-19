#!/usr/bin/env python3
"""Download one full YouTube lesson and store it on the existing R2 bucket.

This runs on a machine the parent starts. It is not a Cloudflare Worker and not
this cloud VM. It does not use cookies, proxies, or a private YouTube client.

Environment:
  CACHE_WORKER_URL   https://musk-atlas-tts.yuanzhevc.workers.dev
  CACHE_JOB_SECRET   same value as `wrangler secret put CACHE_JOB_SECRET`
  The machine also needs `yt-dlp`, `ffmpeg`, and `ffprobe`.
  Upload uses the Worker, so wrangler and R2_API_TOKEN are not required.

YouTube refusing the download is reported as refused and is not retried here.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
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


def put_part(url: str, secret: str, video_id: str, upload_id: str, part: int, chunk: bytes, last: bool) -> str:
    target = f"{url}/full/upload/part?v={video_id}&uploadId={upload_id}&part={part}&last={'1' if last else '0'}"
    req = urllib.request.Request(target, data=chunk, headers={"Authorization": f"Bearer {secret}"}, method="PUT")
    with urllib.request.urlopen(req, timeout=300) as res:
        return json.loads(res.read().decode())["etag"]


def upload_via_worker(worker: str, secret: str, video_id: str, path: str, size: int, duration: float) -> dict:
    """Authenticated multipart upload through the Worker R2 binding. The R2 credential stays on the Worker."""
    base = worker.rstrip("/")
    opened = post(base + "/full/upload/start", secret, {"v": video_id})
    upload_id = opened["uploadId"]
    part_size = 8 * 1024 * 1024
    parts = []
    with open(path, "rb") as handle:
        number = 1
        while True:
            chunk = handle.read(part_size)
            if not chunk:
                break
            etag = put_part(base, secret, video_id, upload_id, number, chunk, handle.tell() >= size)
            parts.append({"partNumber": number, "etag": etag})
            number += 1
    return post(
        base + "/full/upload/complete",
        secret,
        {"v": video_id, "uploadId": upload_id, "parts": parts, "bytes": size, "duration": duration},
    )


def run_once(worker: str, secret: str) -> int:
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
            upload_via_worker(worker, secret, video_id, target, size, duration)
        except Exception as exc:
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
    loop = "--loop" in sys.argv
    while True:
        code = run_once(worker, secret)
        if not loop:
            return code
        time.sleep(60 if code == 0 else 30)


if __name__ == "__main__":
    raise SystemExit(main())
