import io
import os
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stdout
from unittest import mock

import cache_full
import seed_full
from cache_full import APP_USER_AGENT, MANUAL_FORMAT, WORKER_HOST, classify_ytdlp, dependency_problem, failure_code, parse_progress, post, put_part, run_mode, upload_via_worker, worker_is_manual_720, worker_request, ytdlp_command

SECRET = "unit-secret-not-real"
BASE = f"https://{WORKER_HOST}"


class Response:
    def __init__(self, body: bytes):
        self.body = body

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class Classify(unittest.TestCase):
    def test_refusal_is_not_a_success(self):
        self.assertEqual(classify_ytdlp(1, "ERROR: Sign in to confirm you’re not a bot"), "refused")
        self.assertEqual(classify_ytdlp(1, "login required"), "refused")

    def test_other_errors_stay_failures(self):
        self.assertEqual(classify_ytdlp(1, "HTTP Error 404"), "failed")
        self.assertEqual(classify_ytdlp(0, ""), "downloaded")
        self.assertEqual(failure_code("ERROR: [youtube] HTTP Error 403"), "http-403")
        self.assertEqual(failure_code("ERROR: challenge solver requires yt-dlp-ejs"), "ejs-missing")
        self.assertEqual(parse_progress("[download]  45.0% of 10.00MiB at 1.00MiB/s ETA 00:05"), (int(10 * 1024 * 1024 * 0.45), int(10 * 1024 * 1024)))
        self.assertEqual(parse_progress("no progress here"), None)
        self.assertEqual(dependency_problem(ytdlp=True, ffmpeg=True, ffprobe=True, deno=True, ejs=False), "ejs-missing")
        self.assertEqual(dependency_problem(ytdlp=True, ffmpeg=True, ffprobe=True, deno=False, ejs=True), "deno-missing")
        self.assertIsNone(dependency_problem(ytdlp=True, ffmpeg=True, ffprobe=True, deno=True, ejs=True))


class WorkerClient(unittest.TestCase):
    def assert_app_request(self, req, method):
        self.assertEqual(req.get_method(), method)
        self.assertEqual(req.get_header("User-agent"), APP_USER_AGENT)
        self.assertNotIn("Mozilla", APP_USER_AGENT)
        self.assertNotIn("Safari", APP_USER_AGENT)
        self.assertNotIn("Chrome", APP_USER_AGENT)
        self.assertEqual(req.get_header("Authorization"), f"Bearer {SECRET}")
        self.assertEqual(urllib_host(req.full_url), WORKER_HOST)

    def test_upload_claim_and_result_identify_this_app(self):
        seen = []

        def fake_urlopen(req, timeout=0):
            seen.append(req)
            path = req.full_url
            if "/full/upload/part" in path:
                body = b'{"etag":"part-etag"}'
            elif "/full/upload/start" in path:
                body = b'{"uploadId":"upload-1"}'
            elif path.endswith("/full/claim"):
                body = b'{"job":null}'
            else:
                body = b'{"status":"ready"}'
            return Response(body)

        with tempfile.NamedTemporaryFile() as handle:
            handle.write(b"abc")
            handle.flush()
            buf = io.StringIO()
            with mock.patch.object(cache_full.urllib.request, "urlopen", fake_urlopen), redirect_stdout(buf):
                upload_via_worker(BASE, SECRET, "s9mczdODqzo", handle.name, 3, 114)
                post(BASE + "/full/claim", SECRET, {})
                post(BASE + "/full/result", SECRET, {"v": "s9mczdODqzo", "outcome": "ready", "bytes": 3, "duration": 114})
                put_part(BASE, SECRET, "s9mczdODqzo", "upload-1", 1, b"abc", True)
        methods = [req.get_method() for req in seen]
        paths = [req.full_url.split(WORKER_HOST, 1)[1].split("?", 1)[0] for req in seen]
        self.assertEqual(paths, ["/full/upload/start", "/full/upload/part", "/full/progress", "/full/upload/complete", "/full/claim", "/full/result", "/full/upload/part"])
        self.assertEqual(methods, ["POST", "PUT", "POST", "POST", "POST", "POST", "PUT"])
        for req in seen:
            self.assert_app_request(req, req.get_method())
        self.assertNotIn(SECRET, buf.getvalue())

    def test_youtube_download_command_caps_720p_without_a_transcode(self):
        command = ytdlp_command("s9mczdODqzo", "/tmp/s9mczdODqzo.mp4")
        joined = " ".join(command)
        self.assertEqual(command[0], "yt-dlp")
        self.assertIn(MANUAL_FORMAT, command)
        self.assertIn("height<=720", MANUAL_FORMAT)
        self.assertNotIn("height>720", MANUAL_FORMAT)
        self.assertNotIn("height>720", joined)
        self.assertIn("fps<=30", MANUAL_FORMAT)
        self.assertIn("vcodec^=avc1", MANUAL_FORMAT)
        self.assertIn("acodec^=mp4a", MANUAL_FORMAT)
        self.assertIn("res:720,fps:30,vcodec:h264,acodec:aac,ext:mp4", command)
        self.assertIn("Merger+ffmpeg:-c copy -movflags +faststart", command)
        self.assertIn("--newline", command)
        self.assertNotIn("--cookies", command)
        self.assertNotIn("--proxy", command)
        self.assertNotIn("--user-agent", command)
        self.assertNotIn("--add-header", command)
        self.assertNotIn("Mozilla", joined)
        self.assertNotIn(APP_USER_AGENT, joined)
        self.assertIn("https://www.youtube.com/watch?v=s9mczdODqzo", command)

    def test_old_worker_handshake_is_closed(self):
        self.assertTrue(worker_is_manual_720({"scope": "manual-only", "maxHeight": 720, "policy": "lte-720", "preferFps": 30}))
        self.assertFalse(worker_is_manual_720({}))
        self.assertFalse(worker_is_manual_720({"error": "not-found"}))
        self.assertFalse(worker_is_manual_720({"scope": "manual-only", "maxHeight": 1080, "policy": "lte-720"}))
        self.assertFalse(worker_is_manual_720("manual-only"))

    def test_plain_startup_does_not_claim(self):
        self.assertEqual(run_mode(["cache_full.py"]), "paused")
        self.assertEqual(run_mode(["cache_full.py", "--loop"]), "paused")
        self.assertEqual(run_mode(["cache_full.py", "--manual"]), "manual-once")
        self.assertEqual(run_mode(["cache_full.py", "--manual", "--loop"]), "manual-loop")

    def test_helper_refuses_any_other_host(self):
        with self.assertRaises(RuntimeError):
            worker_request("https://www.youtube.com/watch?v=s9mczdODqzo", SECRET, "POST", b"{}", "application/json", 5)

    def test_seed_uses_the_shared_worker_upload(self):
        with open(seed_full.__file__, encoding="utf-8") as handle:
            source = handle.read()
        self.assertIn("upload_via_worker", source)
        self.assertNotIn("urllib", source)
        self.assertNotIn("Mozilla", source)
        self.assertNotIn("User-Agent", source)


def urllib_host(url: str):
    return cache_full.urllib.parse.urlparse(url).hostname


class LiveEdge(unittest.TestCase):
    def test_app_user_agent_reaches_the_worker_without_a_secret(self):
        if os.environ.get("CACHE_SKIP_LIVE") == "1":
            self.skipTest("live edge check disabled")
        try:
            worker_request(BASE + "/full/claim", "", "POST", b"{}", "application/json", 30)
            self.fail("unauthenticated claim returned a body")
        except urllib.error.HTTPError as exc:
            body = exc.read()
            self.assertEqual(exc.code, 401)
            self.assertIn(b"unauthorized", body)
            self.assertNotIn(b"1010", body)


if __name__ == "__main__":
    unittest.main()
