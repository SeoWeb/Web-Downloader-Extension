"""Unit tests for the shared archived-content serving headers (task 7.1, gateway part).

The gateway routes that serve archived bytes today (routers/archive.py,
routers/share.py) are wired by their owning agent; these tests pin the shared
helper's contract so every serving route emits an identical sandboxing header
set (spec: archived-html-serving).
"""

import unittest

from serving import (
    SANDBOX_CSP,
    content_type_for_path,
    pin_content_type,
    sandbox_headers,
)
from starlette.responses import Response


class TestSandboxHeaders(unittest.TestCase):
    def test_html_response_carries_full_sandbox_set(self):
        headers = sandbox_headers("text/html; charset=utf-8")
        self.assertEqual(headers["Content-Security-Policy"], SANDBOX_CSP)
        self.assertEqual(SANDBOX_CSP, "sandbox allow-popups allow-forms")
        # The sandbox deliberately excludes allow-same-origin.
        self.assertNotIn("allow-same-origin", SANDBOX_CSP)
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(headers["Referrer-Policy"], "no-referrer")
        self.assertEqual(headers["Content-Type"], "text/html; charset=utf-8")

    def test_asset_response_has_no_referrer_policy_requirement(self):
        headers = sandbox_headers("image/png")
        self.assertEqual(headers["Content-Security-Policy"], SANDBOX_CSP)
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertNotIn("Referrer-Policy", headers)

    def test_html_charset_is_pinned(self):
        self.assertEqual(pin_content_type("text/html"), "text/html; charset=utf-8")
        self.assertEqual(
            pin_content_type("Text/HTML"),
            "text/html; charset=utf-8",
        )

    def test_empty_content_type_falls_back_to_octet_stream(self):
        self.assertEqual(pin_content_type(""), "application/octet-stream")
        self.assertEqual(pin_content_type(None), "application/octet-stream")

    def test_existing_charset_preserved(self):
        self.assertEqual(
            pin_content_type("text/html; charset=iso-8859-1"),
            "text/html; charset=iso-8859-1",
        )

    def test_explicit_header_wins_over_media_type_in_response(self):
        """Pinned Content-Type must survive Starlette's media_type logic."""
        resp = Response(
            content=b"<html></html>",
            media_type="text/plain",  # a wrong sniffed type must not leak
            headers=sandbox_headers("text/html; charset=utf-8"),
        )
        self.assertEqual(resp.headers["content-type"], "text/html; charset=utf-8")
        self.assertEqual(resp.headers["content-security-policy"], SANDBOX_CSP)
        self.assertEqual(resp.headers["x-content-type-options"], "nosniff")
        self.assertEqual(resp.headers["referrer-policy"], "no-referrer")


class TestContentTypeForPath(unittest.TestCase):
    def test_html_path(self):
        self.assertEqual(content_type_for_path("index.html"), "text/html; charset=utf-8")
        self.assertEqual(content_type_for_path("a/b/index.HTML"), "text/html; charset=utf-8")

    def test_asset_paths(self):
        self.assertEqual(content_type_for_path("assets/style.css"), "text/css; charset=utf-8")
        self.assertEqual(content_type_for_path("img/photo.jpg"), "image/jpeg")
        self.assertEqual(content_type_for_path("font.woff2"), "font/woff2")

    def test_unknown_extension_pinned_to_octet_stream(self):
        self.assertEqual(content_type_for_path("weird.unknownext"), "application/octet-stream")
        self.assertEqual(content_type_for_path("noext"), "application/octet-stream")


if __name__ == "__main__":
    unittest.main()
