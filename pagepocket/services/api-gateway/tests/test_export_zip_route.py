"""Page ZIP export route tests (add-page-export-zip 3.2–3.3).

Route behavior: 404 for unknown/foreign pages (GetPage ownership upstream),
401 without a token (middleware), application/zip + attachment
Content-Disposition on success, streamed body equals the fake service's
chunks, and classified 5xx when the service errors (never a partial 200).
Also pins the filename sanitization rules (unicode, control chars, empty).
"""

import asyncio
import importlib.util
import os
import sys
import types
import unittest
from unittest.mock import MagicMock, patch

import archive_pb2
import grpc
from fastapi import HTTPException
from routers import archive as archive_routes


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


async def _collect(response):
    return b"".join([chunk async for chunk in response.body_iterator])


def _erroring_iterator(exc):
    def _it():
        raise exc
        yield  # pragma: no cover — makes this a generator
    return _it()


class TestExportZipRoute(unittest.TestCase):
    def setUp(self):
        self.stub = MagicMock()
        p = patch.object(archive_routes, "archive_stub", return_value=self.stub)
        p.start()
        self.addCleanup(p.stop)
        self.stub.GetPage.return_value = archive_pb2.PageResponse(
            id="p1", user_id="u1", title="My Page",
        )

    def _set_chunks(self, *chunks):
        self.stub.ExportPage.return_value = iter(
            [archive_pb2.ExportPageChunk(data=c) for c in chunks]
        )

    def test_success_streams_zip_with_headers(self):
        self._set_chunks(b"PK\x03\x04-half", b"-and-half")

        resp = asyncio.run(archive_routes.export_page_zip(_request(), "p1"))

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.media_type, "application/zip")
        self.assertEqual(resp.headers["content-type"], "application/zip")
        self.assertTrue(resp.headers["content-disposition"].startswith("attachment"))
        self.assertIn('filename="My Page.zip"', resp.headers["content-disposition"])
        # No Content-Length (unknown upfront; chunked transfer is fine — D4).
        self.assertNotIn("content-length", resp.headers)
        # Assembled streamed body == the bytes the fake service yielded.
        body = asyncio.run(_collect(resp))
        self.assertEqual(body, b"PK\x03\x04-half-and-half")

    def test_ownership_checked_via_get_page_before_export(self):
        self._set_chunks(b"x")
        asyncio.run(archive_routes.export_page_zip(_request("u1"), "p1"))

        get_req = self.stub.GetPage.call_args.args[0]
        self.assertEqual(get_req.page_id, "p1")
        self.assertEqual(get_req.user_id, "u1")
        export_req = self.stub.ExportPage.call_args.args[0]
        self.assertEqual(export_req.page_id, "p1")
        self.assertEqual(export_req.user_id, "u1")
        # Explicit deadline on every outbound call (gRPC transport discipline).
        self.assertEqual(self.stub.ExportPage.call_args.kwargs.get("timeout"), 300)

    def test_unknown_page_404_and_no_export_call(self):
        self.stub.GetPage.side_effect = _FakeRpcError(grpc.StatusCode.NOT_FOUND, "Page not found")

        with self.assertRaises(HTTPException) as cm:
            asyncio.run(archive_routes.export_page_zip(_request(), "missing"))

        self.assertEqual(cm.exception.status_code, 404)
        self.assertEqual(self.stub.ExportPage.call_count, 0)

    def test_foreign_page_404_and_no_export_call(self):
        """GetPage NOT_FOUNDs cross-user ids upstream; gateway surfaces 404
        unchanged (no existence leak) and never opens an export stream."""
        self.stub.GetPage.side_effect = _FakeRpcError(grpc.StatusCode.NOT_FOUND, "Page not found")

        with self.assertRaises(HTTPException) as cm:
            asyncio.run(archive_routes.export_page_zip(_request("attacker"), "p1"))

        self.assertEqual(cm.exception.status_code, 404)
        self.assertEqual(self.stub.ExportPage.call_count, 0)

    def test_service_unavailable_maps_to_503(self):
        self.stub.ExportPage.side_effect = _FakeRpcError(
            grpc.StatusCode.UNAVAILABLE, "Storage error",
        )

        with self.assertRaises(HTTPException) as cm:
            asyncio.run(archive_routes.export_page_zip(_request(), "p1"))

        self.assertEqual(cm.exception.status_code, 503)
        self.assertEqual(cm.exception.headers.get("Retry-After"), "30")

    def test_first_chunk_failure_maps_to_5xx_not_partial_200(self):
        """An error raised while pulling the FIRST chunk must still become a
        real HTTP status (the response has not started yet)."""
        self.stub.ExportPage.return_value = _erroring_iterator(
            _FakeRpcError(grpc.StatusCode.DEADLINE_EXCEEDED, "upstream hung"),
        )

        with self.assertRaises(HTTPException) as cm:
            asyncio.run(archive_routes.export_page_zip(_request(), "p1"))

        self.assertEqual(cm.exception.status_code, 503)
        self.assertEqual(cm.exception.headers.get("Retry-After"), "5")

    def test_missing_file_classified_not_found_maps_to_404(self):
        self.stub.ExportPage.return_value = _erroring_iterator(
            _FakeRpcError(grpc.StatusCode.NOT_FOUND, "Storage error"),
        )

        with self.assertRaises(HTTPException) as cm:
            asyncio.run(archive_routes.export_page_zip(_request(), "p1"))

        self.assertEqual(cm.exception.status_code, 404)


class TestExportZipAuth(unittest.TestCase):
    """Auth + rate class are inherited — no route-specific configuration."""

    @classmethod
    def setUpClass(cls):
        main_path = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "main.py"))
        spec = importlib.util.spec_from_file_location("api_gateway_main_export_zip", main_path)
        module = importlib.util.module_from_spec(spec)
        sys.modules["api_gateway_main_export_zip"] = module
        spec.loader.exec_module(module)
        cls.main = module

    def test_no_token_401_before_route(self):
        from fastapi.testclient import TestClient

        with TestClient(self.main.app) as client:
            r = client.get("/api/v1/archive/pages/p1/zip")
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json(), {"detail": "Invalid token", "api_version": "v1"})


class TestZipContentDisposition(unittest.TestCase):
    """Filename sanitization rules (D4): strip control chars/quotes/path
    separators, collapse whitespace, keep unicode via RFC 5987, fall back to
    page-{page_id}.zip when the title is unusable."""

    def test_plain_ascii_title(self):
        self.assertEqual(
            archive_routes._zip_content_disposition("My Page", "p1"),
            'attachment; filename="My Page.zip"',
        )

    def test_control_chars_and_quotes_stripped(self):
        self.assertEqual(
            archive_routes._zip_content_disposition("My\x01\x02 Page\x7f", "p1"),
            'attachment; filename="My Page.zip"',
        )
        self.assertEqual(
            archive_routes._zip_content_disposition('Weird "Title" Here', "p1"),
            'attachment; filename="Weird Title Here.zip"',
        )

    def test_path_separators_never_traversal(self):
        self.assertEqual(
            archive_routes._zip_content_disposition("../../etc/passwd", "p1"),
            'attachment; filename="etc passwd.zip"',
        )

    def test_whitespace_collapsed_and_dots_trimmed(self):
        self.assertEqual(
            archive_routes._zip_content_disposition("  Spaced\t\nOut  ", "p1"),
            'attachment; filename="Spaced Out.zip"',
        )
        self.assertEqual(
            archive_routes._zip_content_disposition("...hidden name...", "p1"),
            'attachment; filename="hidden name.zip"',
        )

    def test_unicode_title_uses_rfc5987(self):
        value = archive_routes._zip_content_disposition("Café — Notizen", "p1")
        # Plain filename= stays pure ASCII (header-safe)...
        self.assertIn('filename="page-p1.zip"', value)
        self.assertFalse(value.split("filename=")[1].startswith('"Caf'))
        # ...and the unicode name travels pct-encoded in filename*.
        self.assertIn("filename*=UTF-8''", value)
        self.assertIn("Caf%C3%A9", value)
        self.assertNotIn("ü", value)  # nothing non-ASCII in the raw header

    def test_empty_title_falls_back_to_page_id(self):
        self.assertEqual(
            archive_routes._zip_content_disposition("", "p1"),
            'attachment; filename="page-p1.zip"',
        )

    def test_unusable_title_falls_back_to_page_id(self):
        for unusable in ("   ", "...", "\x00\x01\x02", '"', "//", "..//.."):
            self.assertEqual(
                archive_routes._zip_content_disposition(unusable, "abc-123"),
                'attachment; filename="page-abc-123.zip"',
                unusable,
            )


if __name__ == "__main__":
    unittest.main()
