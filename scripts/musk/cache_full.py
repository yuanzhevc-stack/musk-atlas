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
import urllib.parse
import urllib.request

MIN_BYTES = 2_000_000
MIN_SECONDS = 20
# workers.dev Browser Integrity Check blocks the default Python urllib agent
# with error 1010 before the Worker runs. Cloudflare's workers.dev docs say to
# send a descriptive application User-Agent, and that it does not need to be a browser.
# https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
APP_USER_AGENT = "musk-atlas-cache/1.0 (+https://yuanzhevc-stack.github.io/musk-atlas/)"
WORKER_HOST = "musk-atlas-tts.yuanzhevc.workers.dev"
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


# Hard cap: nothing taller than 720p. Prefer H.264 + AAC, MP4, and 30fps.
# A shorter stream is allowed. If the source has no video at or below 720p,
# yt-dlp fails and the job is reported failed. There is no 1080p fallback
# and no --recode-video.
MANUAL_FORMAT = (
    "bv*[height<=720][fps<=30][vcodec^=avc1][ext=mp4]+ba[acodec^=mp4a][ext=m4a]"
    "/bv*[height<=720][fps<=30][vcodec^=avc1]+ba[acodec^=mp4a]"
    "/bv*[height<=720][ext=mp4]+ba[ext=m4a]"
    "/b[height<=720][ext=mp4]"
    "/bv*[height<=720]+ba[acodec^=mp4a]/b[height<=720]"
)
CAPABILITY_SCOPE = "manual-only"
CAPABILITY_POLICY = "lte-720"
CAPABILITY_MAX_HEIGHT = 720


def worker_is_manual_720(body: object) -> bool:
    if not isinstance(body, dict):
        return False
    return body.get("scope") == CAPABILITY_SCOPE and body.get("maxHeight") == CAPABILITY_MAX_HEIGHT and body.get("policy") == CAPABILITY_POLICY


def run_mode(argv: list[str]) -> str:
    """The bulk loop stays paused. Only an explicit --manual run claims pasted-link jobs."""
    if "--manual" not in argv:
        return "paused"
    return "manual-loop" if "--loop" in argv else "manual-once"


def ytdlp_command(video_id: str, target: str) -> list[str]:
    return [
        "yt-dlp",
        "--no-playlist",
        "--no-cache-dir",
        "--retries",
        "2",
        "-f",
        MANUAL_FORMAT,
        "-S",
        "res:720,fps:30,vcodec:h264,acodec:aac,ext:mp4",
        "--merge-output-format",
        "mp4",
        "--postprocessor-args",
        "Merger+ffmpeg:-c copy -movflags +faststart",
        "-o",
        target,
        f"https://www.youtube.com/watch?v={video_id}",
    ]


def probe_media(path: str) -> dict:
    """Measured picture. Missing fields stay missing; this never fills in 720p."""
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,avg_frame_rate", "-of", "json", path],
        text=True,
    )
    data = json.loads(out)
    info: dict = {}
    for stream in data.get("streams") or []:
        if stream.get("codec_type") == "video" and "height" not in info:
            if stream.get("codec_name"):
                info["vcodec"] = stream["codec_name"]
            if isinstance(stream.get("width"), int):
                info["width"] = stream["width"]
            if isinstance(stream.get("height"), int):
                info["height"] = stream["height"]
            rate = str(stream.get("avg_frame_rate") or "")
            if "/" in rate:
                num, den = rate.split("/", 1)
                if num.isdigit() and den.isdigit() and int(den) > 0:
                    info["fps"] = round(int(num) / int(den), 3)
        elif stream.get("codec_type") == "audio" and "acodec" not in info and stream.get("codec_name"):
            info["acodec"] = stream["codec_name"]
    return info


def worker_request(url: str, secret: str, method: str, data: bytes | None, content_type: str | None, timeout: int) -> dict:
    """Call this Worker's own cache API. The User-Agent identifies the app; it is not a browser."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != WORKER_HOST:
        raise RuntimeError("refusing a request that is not the cache worker")
    headers = {
        "User-Agent": APP_USER_AGENT,
        "Authorization": f"Bearer {secret}",
    }
    if content_type:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode())


def require_manual_worker(worker: str, secret: str) -> bool:
    """Fail closed before any claim. An old Worker has no capability route and must not be asked for a job."""
    try:
        body = worker_request(worker.rstrip("/") + "/full/capability", secret, "GET", None, None, 30)
    except Exception as exc:
        print(f"Worker capability check failed closed, no job was claimed: {exc}", file=sys.stderr)
        return False
    if not worker_is_manual_720(body):
        print("Worker is not the manual-only <=720 build. No job was claimed.", file=sys.stderr)
        return False
    return True


def post(url: str, secret: str, payload: dict) -> dict:
    return worker_request(url, secret, "POST", json.dumps(payload).encode(), "application/json", 60)


def put_part(url: str, secret: str, video_id: str, upload_id: str, part: int, chunk: bytes, last: bool) -> str:
    target = f"{url}/full/upload/part?v={video_id}&uploadId={upload_id}&part={part}&last={'1' if last else '0'}"
    return worker_request(target, secret, "PUT", chunk, None, 300)["etag"]


def upload_via_worker(worker: str, secret: str, video_id: str, path: str, size: int, duration: float, media: dict | None = None) -> dict:
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
        {"v": video_id, "uploadId": upload_id, "parts": parts, "bytes": size, "duration": duration, **(media or {})},
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
        proc = subprocess.run(ytdlp_command(video_id, target), capture_output=True, text=True)
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
        try:
            media = probe_media(target)
        except (subprocess.CalledProcessError, ValueError, json.JSONDecodeError):
            media = {}
        height = media.get("height")
        if not isinstance(height, int) or height <= 0 or height > CAPABILITY_MAX_HEIGHT:
            reason = "above-720" if isinstance(height, int) and height > CAPABILITY_MAX_HEIGHT else "unmeasured-height"
            post(worker.rstrip("/") + "/full/result", secret, {"v": video_id, "outcome": "failed", "bytes": size, "duration": duration, "error": reason, **media})
            print(f"rejected {reason} height={height}")
            return 3
        if size < MIN_BYTES or duration < MIN_SECONDS:
            post(worker.rstrip("/") + "/full/result", secret, {"v": video_id, "outcome": "failed", "bytes": size, "duration": duration, "error": "not-a-full-video", **media})
            print(f"rejected size={size} duration={duration}")
            return 3
        try:
            upload_via_worker(worker, secret, video_id, target, size, duration, media)
        except Exception as exc:
            post(worker.rstrip("/") + "/full/result", secret, {"v": video_id, "outcome": "failed", "error": str(exc)[:180]})
            print(exc)
            return 4
        post(worker.rstrip("/") + "/full/result", secret, {"v": video_id, "outcome": "ready", "bytes": size, "duration": duration, **media})
        print(f"ready {video_id} bytes={size} duration={duration} height={media.get('height')} vcodec={media.get('vcodec')}")
        return 0


def main() -> int:
    worker = os.environ.get("CACHE_WORKER_URL", "")
    secret = os.environ.get("CACHE_JOB_SECRET", "")
    if not worker or not secret:
        print("CACHE_WORKER_URL and CACHE_JOB_SECRET are required. This script does not download without them.", file=sys.stderr)
        return 1
    mode = run_mode(sys.argv)
    if mode == "paused":
        print(
            "Bulk cache stays paused. This process does not claim queued jobs. "
            "After the Worker that only claims origin=manual is deployed, a later start is: "
            "python3 cache_full.py --manual   or   python3 cache_full.py --manual --loop. "
            "Leave pipeline.stop and USER_PAUSED in place.",
            file=sys.stderr,
        )
        return 0
    if shutil.which("yt-dlp") is None or shutil.which("ffprobe") is None:
        print("yt-dlp and ffprobe must be installed on the machine that runs this.", file=sys.stderr)
        return 1
    if not require_manual_worker(worker, secret):
        return 3
    while True:
        code = run_once(worker, secret)
        if mode != "manual-loop":
            return code
        time.sleep(60 if code == 0 else 30)


if __name__ == "__main__":
    raise SystemExit(main())
