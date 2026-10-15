"""Task 7.1 wiring tests: sandbox headers on every gateway file-serving route.

Both serving routes (routers/archive.py get_page_file and routers/share.py
get_share_file) must emit the identical header set from serving.sandbox_headers:
CSP sandbox (no allow-same-origin), nosniff, pinned Content-Type, and
Referrer-Policy on HTML — while keeping Cache-Control. Also pins the
consistency sweep: on these routes only NOT_FOUND falls back to the assets/
prefix; every other gRPC failure routes through handle_grpc_error
(deadline → 503, quota → 402, size → 413, rate → 429).
"""

import asyncio
import types
import unittest
from unittest.mock import MagicMock, patch

import archive_pb2
import grpc
import share_pb2
from fastapi import HTTPException
from routers import archive as archive_routes
from routers import share as share_routes
from serving import SANDBOX_CSP


class _FakeRpcError(grpc.RpcError):
    def __init__(self, code, details="fake"):
        self._code = code
        self._details = details

    def code(self):
        return self._code

    def details(self):
        return self._details


def _request(user_id="u1"):
    return types.SimpleNamespace(
        state=types.SimpleNamespace(user_id=user_id, plan="free"),
        headers={},
    )


class TestArchiveFileHeaders(unittest.TestCase):
    def setUp(self):
        self.stub = MagicMock()
        p = patch.object(archive_routes, "archive_stub", return_value=self.stub)
        p.start()
        self.addCleanup(p.stop)

    def _serve(self, data, content_type, path):
        self.stub.GetArchiveFile.return_value = archive_pb2.ArchiveFileResponse(
            data=data, content_type=content_type,
        )
        return asyncio.run(archive_routes.get_page_file(_request(), "p1", path))

    def test_html_carries_full_sandbox_set(self):
        resp = self._serve(b"<html></html>", "text/html; charset=utf-8", "index.html")
        self.assertEqual(resp.headers["content-security-policy"], SANDBOX_CSP)
        self.assertNotIn("allow-same-origin", resp.headers["content-security-policy"])
        self.assertEqual(resp.headers["x-content-type-options"], "nosniff")
        self.assertEqual(resp.headers["referrer-policy"], "no-referrer")
        self.assertEqual(resp.headers["content-type"], "text/html; charset=utf-8")
        self.assertIn("cache-control", resp.headers)

    def test_html_charset_pinned_when_stored_type_lacks_it(self):
        resp = self._serve(b"<html></html>", "text/html", "index.html")
        self.assertEqual(resp.headers["content-type"], "text/html; charset=utf-8")
        self.assertEqual(resp.headers["referrer-policy"], "no-referrer")

    def test_binary_asset_carries_nosniff_and_pinned_type(self):
        resp = self._serve(b"png-bytes", "image/png", "assets/logo.png")
        self.assertEqual(resp.headers["x-content-type-options"], "nosniff")
        self.assertEqual(resp.headers["content-security-policy"], SANDBOX_CSP)
        self.assertEqual(resp.headers["content-type"], "image/png")
        self.assertNotIn("referrer-policy", resp.headers)

    def test_missing_type_derived_from_shared_map(self):
        resp = self._serve(b"body{}", "", "assets/style.css")
        self.assertEqual(resp.headers["content-type"], "text/css; charset=utf-8")
        resp = self._serve(b"?", "", "assets/blob.unknownext")
        self.assertEqual(resp.headers["content-type"], "application/octet-stream")

    def test_missing_file_still_tries_assets_prefix_then_404(self):
        self.stub.GetArchiveFile.side_effect = [
            _FakeRpcError(grpc.StatusCode.NOT_FOUND),
            archive_pb2.ArchiveFileResponse(data=b"x", content_type="text/html"),
        ]
        resp = asyncio.run(archive_routes.get_page_file(_request(), "p1", "index.html"))
        self.assertEqual(resp.body, b"x")
        second = self.stub.GetArchiveFile.call_args_list[1].args[0]
        self.assertEqual(second.file_path, "assets/index.html")

    def test_deadline_is_503_not_masked_as_404(self):
        self.stub.GetArchiveFile.side_effect = _FakeRpcError(grpc.StatusCode.DEADLINE_EXCEEDED)
        with self.assertRaises(HTTPException) as cm:
            asyncio.run(archive_routes.get_page_file(_request(), "p1", "index.html"))
        self.assertEqual(cm.exception.status_code, 503)
        self.assertEqual(cm.exception.headers.get("Retry-After"), "5")
        self.assertEqual(self.stub.GetArchiveFile.call_count, 1)  # no assets retry

    def test_quota_is_402_on_file_route(self):
        self.stub.GetArchiveFile.side_effect = _FakeRpcError(
            grpc.StatusCode.RESOURCE_EXHAUSTED, "Monthly page limit reached",
        )
        with self.assertRaises(HTTPException) as cm:
            asyncio.run(archive_routes.get_page_file(_request(), "p1", "index.html"))
        self.assertEqual(cm.exception.status_code, 402)


class TestShareFileHeaders(unittest.TestCase):
    def setUp(self):
        self.share_stub = MagicMock()
        self.archive_stub = MagicMock()
        p1 = patch.object(share_routes, "share_stub", return_value=self.share_stub)
        p2 = patch.object(share_routes, "archive_stub", return_value=self.archive_stub)
        p1.start()
        p2.start()
        self.addCleanup(p1.stop)
        self.addCleanup(p2.stop)
        self.share_stub.ValidateToken.return_value = share_pb2.ValidateShareResponse(
            valid=True, page_id="p1", owner_user_id="owner-u1",
        )

    def _serve(self, data, content_type, path):
        self.archive_stub.GetArchiveFile.return_value = archive_pb2.ArchiveFileResponse(
            data=data, content_type=content_type,
        )
        return asyncio.run(share_routes.get_share_file("tok", path))

    def test_html_carries_full_sandbox_set(self):
        resp = self._serve(b"<html></html>", "text/html; charset=utf-8", "index.html")
        self.assertEqual(resp.headers["content-security-policy"], SANDBOX_CSP)
        self.assertNotIn("allow-same-origin", resp.headers["content-security-policy"])
        self.assertEqual(resp.headers["x-content-type-options"], "nosniff")
        self.assertEqual(resp.headers["referrer-policy"], "no-referrer")
        self.assertEqual(resp.headers["content-type"], "text/html; charset=utf-8")
        self.assertIn("cache-control", resp.headers)

    def test_binary_asset_carries_nosniff_and_pinned_type(self):
        resp = self._serve(b"gif-bytes", "image/gif", "assets/cat.gif")
        self.assertEqual(resp.headers["x-content-type-options"], "nosniff")
        self.assertEqual(resp.headers["content-security-policy"], SANDBOX_CSP)
        self.assertEqual(resp.headers["content-type"], "image/gif")
        self.assertNotIn("referrer-policy", resp.headers)

    def test_missing_type_derived_from_shared_map(self):
        resp = self._serve(b"woff2-bytes", "", "assets/font.woff2")
        self.assertEqual(resp.headers["content-type"], "font/woff2")

    def test_invalid_token_still_404(self):
        self.share_stub.ValidateToken.return_value = share_pb2.ValidateShareResponse(valid=False)
        with self.assertRaises(HTTPException) as cm:
            asyncio.run(share_routes.get_share_file("bad", "index.html"))
        self.assertEqual(cm.exception.status_code, 404)

    def test_deadline_is_503_not_masked_as_404(self):
        self.archive_stub.GetArchiveFile.side_effect = _FakeRpcError(
            grpc.StatusCode.DEADLINE_EXCEEDED,
        )
        with self.assertRaises(HTTPException) as cm:
            asyncio.run(share_routes.get_share_file("tok", "index.html"))
        self.assertEqual(cm.exception.status_code, 503)
        self.assertEqual(cm.exception.headers.get("Retry-After"), "5")

    def test_rate_limit_is_429_on_share_file_route(self):
        self.archive_stub.GetArchiveFile.side_effect = _FakeRpcError(
            grpc.StatusCode.RESOURCE_EXHAUSTED, "rate limit exceeded",
        )
        with self.assertRaises(HTTPException) as cm:
            asyncio.run(share_routes.get_share_file("tok", "index.html"))
        self.assertEqual(cm.exception.status_code, 429)


if __name__ == "__main__":
    unittest.main()
