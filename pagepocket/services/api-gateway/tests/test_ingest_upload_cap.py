"""Task 4.4 + 1.5 wiring tests: the ingest route enforces the upload bounds.

Per part (task 4.4): a declared-oversize body is rejected via the
content-length pre-check before anything is read, and every part is read
through the bounded reader so an undeclared oversized body raises 413 before
being fully buffered (asserted on a large in-memory stream — the reader stops
after the first chunk, never consuming the whole body).

Cumulative (task 1.5 / D2): html + Σ assets share ONE cap — a missing
declared Content-Length is a 400, the running counter 413s as soon as the sum
exceeds the cap, and the asset-count cap (MAX_INGEST_ASSETS) rejects part
floods.
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

    # -- declared-length pre-check (task 4.4 + 1.5) --

    def test_declared_oversize_rejected_before_reading_body(self):
        upload = _StreamUpload(b"x" * 10)
        with self.assertRaises(HTTPException) as cm:
            self._ingest(self._request(content_length=_CAP + 1), upload)
        self.assertEqual(cm.exception.status_code, 413)
        # The pre-check fired before any body buffering.
        self.assertEqual(upload.position, 0)
        self.stub.IngestPage.assert_not_called()

    def test_missing_content_length_rejected_with_400(self):
        """Task 1.5: chunked bodies without a declared length are rejected for
        ingest — the cumulative bound cannot be enforced while streaming."""
        upload = _StreamUpload(b"<html></html>")
        with self.assertRaises(HTTPException) as cm:
            self._ingest(self._request(content_length=None), upload)
        self.assertEqual(cm.exception.status_code, 400)
        self.assertEqual(upload.position, 0)  # nothing was read
        self.stub.IngestPage.assert_not_called()

    def test_garbage_content_length_rejected_with_400(self):
        upload = _StreamUpload(b"<html></html>")
        with self.assertRaises(HTTPException) as cm:
            self._ingest(self._request(content_length="not-a-number"), upload)
        self.assertEqual(cm.exception.status_code, 400)
        self.stub.IngestPage.assert_not_called()

    # -- bounded per-part reads (task 4.4) --

    def test_oversized_body_raises_413_mid_read(self):
        """A lying Content-Length (≤ cap) with a bigger body still 413s."""
        upload = _StreamUpload(b"x" * 2048)
        with self.assertRaises(HTTPException) as cm:
            self._ingest(self._request(content_length=_CAP), upload)
        self.assertEqual(cm.exception.status_code, 413)
        self.stub.IngestPage.assert_not_called()

    def test_large_oversized_body_is_never_fully_buffered(self):
        """Bounded reads: a 5 MB undeclared body dies at the first 1 MB chunk."""
        upload = _StreamUpload(b"x" * (5 * 1024 * 1024))
        with self.assertRaises(HTTPException) as cm:
            self._ingest(self._request(content_length=_CAP), upload)
        self.assertEqual(cm.exception.status_code, 413)
        self.assertLess(upload.position, upload.length)
        self.assertLessEqual(upload.position, READ_CHUNK_SIZE)

    def test_oversized_asset_rejected(self):
        html = _StreamUpload(b"<html></html>")
        asset = _StreamUpload(b"x" * 2048, filename="a.png", content_type="image/png")
        with self.assertRaises(HTTPException) as cm:
            self._ingest(self._request(content_length=_CAP), html, assets=[asset])
        self.assertEqual(cm.exception.status_code, 413)
        self.stub.IngestPage.assert_not_called()

    # -- cumulative bound (task 1.5 / D2) --

    def test_cumulative_bytes_over_cap_rejected(self):
        """Each part is under the per-part cap, but html + Σ assets exceed it
        → 413 before forwarding upstream."""
        html = _StreamUpload(b"x" * 40)
        a1 = _StreamUpload(b"y" * 20, filename="a.png", content_type="image/png")
        a2 = _StreamUpload(b"z" * 20, filename="b.png", content_type="image/png")
        with self.assertRaises(HTTPException) as cm:
            self._ingest(self._request(content_length=_CAP), html, assets=[a1, a2])
        self.assertEqual(cm.exception.status_code, 413)
        self.stub.IngestPage.assert_not_called()

    def test_cumulative_counter_stops_early(self):
        """The second asset may only consume what is left of the shared cap —
        a huge tail asset is cut off at the first bounded chunk, never fully
        buffered (the first MB is the rejection chunk, not 5 MB)."""
        html = _StreamUpload(b"x" * 40)
        a1 = _StreamUpload(b"y" * 20, filename="a.png", content_type="image/png")
        a2 = _StreamUpload(b"z" * (5 * 1024 * 1024), filename="b.png", content_type="image/png")
        with self.assertRaises(HTTPException):
            self._ingest(self._request(content_length=_CAP), html, assets=[a1, a2])
        self.assertLessEqual(a2.position, READ_CHUNK_SIZE)
        self.assertLess(a2.position, a2.length)
        self.stub.IngestPage.assert_not_called()

    def test_cumulative_within_cap_forwards_unchanged(self):
        html = _StreamUpload(b"x" * 40)
        a1 = _StreamUpload(b"y" * 10, filename="a.png", content_type="image/png")
        self._ingest(self._request(content_length=_CAP), html, assets=[a1])
        sent = self.stub.IngestPage.call_args.args[0]
        self.assertEqual(sent.html_content, b"x" * 40)
        self.assertEqual(sent.assets[0].data, b"y" * 10)

    # -- asset-count cap (task 1.5 / MAX_INGEST_ASSETS) --

    def test_too_many_assets_rejected_with_413(self):
        env = patch.dict(os.environ, {"MAX_INGEST_ASSETS": "3"})
        env.start()
        self.addCleanup(env.stop)
        html = _StreamUpload(b"<html></html>")
        assets = [
            _StreamUpload(b"d", filename=f"{i}.png", content_type="image/png")
            for i in range(4)
        ]
        with self.assertRaises(HTTPException) as cm:
            self._ingest(self._request(content_length=_CAP), html, assets=assets)
        self.assertEqual(cm.exception.status_code, 413)
        self.stub.IngestPage.assert_not_called()

    def test_asset_count_at_limit_passes(self):
        env = patch.dict(os.environ, {"MAX_INGEST_ASSETS": "3"})
        env.start()
        self.addCleanup(env.stop)
        html = _StreamUpload(b"<html></html>")
        assets = [
            _StreamUpload(b"d", filename=f"{i}.png", content_type="image/png")
            for i in range(3)
        ]
        self._ingest(self._request(content_length=_CAP), html, assets=assets)
        self.stub.IngestPage.assert_called_once()

    # -- request shape --

    def test_under_cap_ingest_sends_full_body(self):
        html = _StreamUpload(b"<html>ok</html>")
        asset = _StreamUpload(b"png-bytes", filename="a.png", content_type="image/png")
        self._ingest(self._request(content_length=_CAP), html, assets=[asset])
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
        self._ingest(self._request(content_length=_CAP), html, assets=assets)
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
            self._ingest(self._request(content_length=_CAP), upload)
        self.assertEqual(cm.exception.detail.get("api_version"), "v1")
        self.assertTrue(cm.exception.detail.get("detail"))

    def test_ingest_runs_on_the_dedicated_executor(self):
        """Task 1.3: the ingest stub call is dispatched via the bounded-pool
        ``run_ingest`` helper, not the shared ``run_in_threadpool``."""
        import ingest_pool

        # The route module must use the executor's helper (import identity,
        # not a local reimplementation).
        self.assertIs(archive_routes.run_ingest, ingest_pool.run_ingest)

        calls = []

        async def spy(func, *args, **kwargs):
            calls.append(func)
            return func(*args, **kwargs)

        html = _StreamUpload(b"<html>ok</html>")
        with patch.object(archive_routes, "run_ingest", side_effect=spy):
            self._ingest(self._request(content_length=_CAP), html)
        self.assertEqual(calls, [self.stub.IngestPage])


if __name__ == "__main__":
    unittest.main()
