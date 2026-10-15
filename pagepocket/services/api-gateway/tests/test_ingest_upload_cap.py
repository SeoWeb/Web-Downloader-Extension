"""Task 4.4 wiring tests: the ingest route enforces the multipart cap.

The route must (a) reject a declared-oversize body via the content-length
pre-check before reading anything and (b) read HTML + assets through the
bounded reader so an undeclared oversized body raises 413 before being fully
buffered (asserted on a large in-memory stream — the reader stops after the
first chunk, never consuming the whole body).
"""

import asyncio
import io
import os
import types
import unittest
from unittest.mock import MagicMock, patch

import archive_pb2
from fastapi import HTTPException
from routers import archive as archive_routes
from validation import READ_CHUNK_SIZE

_CAP = 64  # tiny cap so tests stay small


class _StreamUpload:
    """UploadFile stand-in: async read(size) over an in-memory stream."""

    def __init__(self, data: bytes, filename="index.html", content_type="text/html"):
        self._buf = io.BytesIO(data)
        self.filename = filename
        self.content_type = content_type

    async def read(self, size: int = -1) -> bytes:
        return self._buf.read(size)

    @property
    def position(self) -> int:
        return self._buf.tell()

    @property
    def length(self) -> int:
        return self._buf.getbuffer().nbytes


class TestIngestUploadCap(unittest.TestCase):
    def setUp(self):
        self.stub = MagicMock()
        self.stub.IngestPage.return_value = archive_pb2.IngestPageResponse(
            success=True, page_id="p1",
        )
        p = patch.object(archive_routes, "archive_stub", return_value=self.stub)
        p.start()
        self.addCleanup(p.stop)
        env = patch.dict(os.environ, {"MAX_UPLOAD_BYTES": str(_CAP)})
        env.start()
        self.addCleanup(env.stop)

    def _request(self, content_length=None):
        headers = {}
        if content_length is not None:
            headers["content-length"] = str(content_length)
        return types.SimpleNamespace(
            state=types.SimpleNamespace(user_id="u1", plan="free"),
            headers=headers,
        )

    def _ingest(self, request, html, assets=()):
        return asyncio.run(archive_routes.ingest_page(
            request,
            url="https://example.com",
            title="T",
            html_content=html,
            extension_job_id="job-1",
            plan="pro",  # ignored (JWT plan is authoritative)
            assets=list(assets),
        ))

    def test_declared_oversize_rejected_before_reading_body(self):
        upload = _StreamUpload(b"x" * 10)
        with self.assertRaises(HTTPException) as cm:
            self._ingest(self._request(content_length=_CAP + 1), upload)
        self.assertEqual(cm.exception.status_code, 413)
        # The pre-check fired before any body buffering.
        self.assertEqual(upload.position, 0)
        self.stub.IngestPage.assert_not_called()

    def test_oversized_body_raises_413_mid_read(self):
        upload = _StreamUpload(b"x" * 2048)  # no declared length, body > cap
        with self.assertRaises(HTTPException) as cm:
            self._ingest(self._request(), upload)
        self.assertEqual(cm.exception.status_code, 413)
        self.stub.IngestPage.assert_not_called()

    def test_large_oversized_body_is_never_fully_buffered(self):
        """Bounded reads: a 5 MB undeclared body dies at the first 1 MB chunk."""
        upload = _StreamUpload(b"x" * (5 * 1024 * 1024))
        with self.assertRaises(HTTPException) as cm:
            self._ingest(self._request(), upload)
        self.assertEqual(cm.exception.status_code, 413)
        self.assertLess(upload.position, upload.length)
        self.assertLessEqual(upload.position, READ_CHUNK_SIZE)

    def test_oversized_asset_rejected(self):
        html = _StreamUpload(b"<html></html>")
        asset = _StreamUpload(b"x" * 2048, filename="a.png", content_type="image/png")
        with self.assertRaises(HTTPException) as cm:
            self._ingest(self._request(), html, assets=[asset])
        self.assertEqual(cm.exception.status_code, 413)
        self.stub.IngestPage.assert_not_called()

    def test_under_cap_ingest_sends_full_body(self):
        html = _StreamUpload(b"<html>ok</html>")
        asset = _StreamUpload(b"png-bytes", filename="a.png", content_type="image/png")
        self._ingest(self._request(content_length=17), html, assets=[asset])
        sent = self.stub.IngestPage.call_args.args[0]
        self.assertEqual(sent.html_content, b"<html>ok</html>")
        self.assertEqual(len(sent.assets), 1)
        self.assertEqual(sent.assets[0].data, b"png-bytes")

    def test_under_cap_ingest_carries_asset_metadata(self):
        """Each asset's filename + content_type from the multipart parts reach
        the built IngestPageRequest (pagepocket-ingest-rest)."""
        html = _StreamUpload(b"<html>ok</html>")
        assets = [
            _StreamUpload(b"png-bytes", filename="a.png", content_type="image/png"),
            _StreamUpload(b"woff2-bytes", filename="font.woff2", content_type="font/woff2"),
            # Missing filename/content_type fall back to the route defaults
            _StreamUpload(b"bare-bytes", filename=None, content_type=None),
        ]
        self._ingest(self._request(content_length=17), html, assets=assets)
        sent = self.stub.IngestPage.call_args.args[0]
        self.assertEqual(
            [(a.filename, a.content_type, a.data) for a in sent.assets],
            [
                ("a.png", "image/png", b"png-bytes"),
                ("font.woff2", "font/woff2", b"woff2-bytes"),
                ("", "application/octet-stream", b"bare-bytes"),
            ],
        )

    def test_413_detail_carries_api_version(self):
        upload = _StreamUpload(b"x" * 2048)
        with self.assertRaises(HTTPException) as cm:
            self._ingest(self._request(), upload)
        self.assertEqual(cm.exception.detail.get("api_version"), "v1")
        self.assertTrue(cm.exception.detail.get("detail"))


if __name__ == "__main__":
    unittest.main()
