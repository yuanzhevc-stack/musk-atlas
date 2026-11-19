import unittest
from cache_full import classify_ytdlp

class Classify(unittest.TestCase):
    def test_refusal_is_not_a_success(self):
        self.assertEqual(classify_ytdlp(1, "ERROR: Sign in to confirm you’re not a bot"), "refused")
        self.assertEqual(classify_ytdlp(1, "login required"), "refused")

    def test_other_errors_stay_failures(self):
        self.assertEqual(classify_ytdlp(1, "HTTP Error 404"), "failed")
        self.assertEqual(classify_ytdlp(0, ""), "downloaded")

if __name__ == "__main__":
    unittest.main()
