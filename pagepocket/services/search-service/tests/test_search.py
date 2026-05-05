"""Search service unit tests."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from servicer import _make_snippet


class TestSnippet(unittest.TestCase):
    def test_basic_snippet(self):
        body = "This is a long text about machine learning and AI technology."
        snippet = _make_snippet(body, "machine learning", 240)
        self.assertIn("machine learning", snippet)

    def test_no_match_returns_prefix(self):
        body = "Hello world"
        snippet = _make_snippet(body, "xyz", 240)
        self.assertEqual(snippet, "Hello world")

    def test_short_body(self):
        body = "Hi"
        snippet = _make_snippet(body, "hi", 240)
        self.assertIn("Hi", snippet)


if __name__ == "__main__":
    unittest.main()
