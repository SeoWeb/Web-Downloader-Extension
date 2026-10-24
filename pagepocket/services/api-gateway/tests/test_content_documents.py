"""Text-native downloads (tasks 2.1/2.2): text content parts on REST ingest
and text formats on the read/serving paths.

Covers the pagepocket-ingest-rest spec scenarios: optional `markdown_content`
and `text_content` file parts map into the RPC's content_documents (plain
bytes, sharing the cumulative upload cap), absence preserves today's behavior
exactly, the ingest response and `GET /pages/{id}` carry `content_formats`,
and the file-serving route emits the pinned text content types with the same
sandbox CSP header set.
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
from serving import SANDBOX_CSP, content_type_for_path

_CAP = 64  # tiny cap so tests stay small (mirrors test_ingest_upload_cap.py)


class _StreamUpload:
    """UploadFile stand-in: async read(size) over an in-memory stream."""

    def __init__(self, data: bytes, filename="index.html", content_type="text/html"):
        self._buf = io.BytesIO(data)
        self.filename = filename
        self.content_type = content_type

    async def read(self, size: int = -1) -> bytes:
        return self._buf.read(size)


def _request(content_length=None, user_id="u1"):
    headers = {}
    if content_length is not None:
        headers["content-length"] = str(content_length)
    return types.SimpleNamespace(
        state=types.SimpleNamespace(user_id=user_id, plan="free"),
        headers=headers,
    )


class TestIngestContentDocuments(unittest.TestCase):
    """`POST /pages/ingest` text parts → content_documents (D1/D5)."""

    def setUp(self):
        self.stub = MagicMock()
        self.stub.IngestPage.return_value = archive_pb2.IngestPageResponse(
            success=True, page_id="p1",
            content_formats=["html", "markdown", "text"],
        )
        p = patch.object(archive_routes, "archive_stub", return_value=self.stub)
        p.start()
        self.addCleanup(p.stop)
        env = patch.dict(os.environ, {"MAX_UPLOAD_BYTES": str(_CAP)})
        env.start()
        self.addCleanup(env.stop)

    def _ingest(self, request, html, markdown=None, text=None, assets=()):
        return asyncio.run(archive_routes.ingest_page(
            request,
            url="https://example.com",
            title="T",
            html_content=html,
            markdown_content=markdown,
            text_content=text,
            extension_job_id="job-1",
            plan="pro",  # ignored (JWT plan is authoritative)
            assets=list(assets),
        ))

    def test_multi_part_ingest_forwards_content_documents(self):
        """Spec scenario "REST multi-format ingest": html + markdown + text
        parts are all forwarded; the response echoes content_formats."""
        md = _StreamUpload(b"# md body", filename="index.md",
                           content_type="text/markdown")
        txt = _StreamUpload(b"plain body", filename="index.txt",
                            content_type="text/plain")
        resp = self._ingest(
            _request(content_length=_CAP),
            _StreamUpload(b"<html>ok</html>"),
            markdown=md, text=txt,
        )
        sent = self.stub.IngestPage.call_args.args[0]
        self.assertEqual(sent.html_content, b"<html>ok</html>")
        self.assertEqual(
            [(d.content_format, d.data) for d in sent.content_documents],
            [("markdown", b"# md body"), ("text", b"plain body")],
        )
        self.assertEqual(
            resp["content_formats"], ["html", "markdown", "text"],
        )
        self.assertTrue(resp["success"])

    def test_text_only_push_forwards_empty_html_with_documents(self):
        """HTML off (D5): an EMPTY html part plus a markdown part is forwarded
        as-is — the service rejects zero-document pushes, not empty HTML."""
        self.stub.IngestPage.return_value = archive_pb2.IngestPageResponse(
            success=True, page_id="p2", content_formats=["markdown"],
        )
        resp = self._ingest(
            _request(content_length=_CAP),
            _StreamUpload(b""),
            markdown=_StreamUpload(b"# only md", filename="index.md"),
        )
        sent = self.stub.IngestPage.call_args.args[0]
        self.assertEqual(sent.html_content, b"")
        self.assertEqual(
            [(d.content_format, d.data) for d in sent.content_documents],
            [("markdown", b"# only md")],
        )
        self.assertEqual(resp["content_formats"], ["markdown"])

    def test_legacy_single_part_unchanged(self):
        """Spec scenario "Legacy ingest unchanged": no text parts → no
        content_documents, request succeeds exactly as before."""
        self.stub.IngestPage.return_value = archive_pb2.IngestPageResponse(
            success=True, page_id="p1",
        )
        resp = self._ingest(
            _request(content_length=_CAP),
            _StreamUpload(b"<html>ok</html>"),
        )
        sent = self.stub.IngestPage.call_args.args[0]
        self.assertEqual(list(sent.content_documents), [])
        self.assertEqual(sent.html_content, b"<html>ok</html>")
        self.assertEqual(resp["content_formats"], [])

    def test_empty_text_part_carries_no_document(self):
        self._ingest(
            _request(content_length=_CAP),
            _StreamUpload(b"<html>ok</html>"),
            markdown=_StreamUpload(b"", filename="index.md"),
        )
        sent = self.stub.IngestPage.call_args.args[0]
        self.assertEqual(list(sent.content_documents), [])

    def test_text_parts_share_the_cumulative_cap(self):
        """Each part is under the cap, but html + md + txt exceed it → 413
        before forwarding upstream (same shared cap as assets, D2)."""
        with self.assertRaises(HTTPException) as cm:
            self._ingest(
                _request(content_length=_CAP),
                _StreamUpload(b"x" * 40),
                markdown=_StreamUpload(b"y" * 20, filename="index.md"),
                text=_StreamUpload(b"z" * 20, filename="index.txt"),
            )
        self.assertEqual(cm.exception.status_code, 413)
        self.stub.IngestPage.assert_not_called()

    def test_oversized_markdown_part_rejected(self):
        with self.assertRaises(HTTPException) as cm:
            self._ingest(
                _request(content_length=_CAP),
                _StreamUpload(b"<html></html>"),
                markdown=_StreamUpload(b"y" * 2048, filename="index.md"),
            )
        self.assertEqual(cm.exception.status_code, 413)
        self.stub.IngestPage.assert_not_called()

    def test_text_parts_within_cap_forwarded_with_assets(self):
        md = _StreamUpload(b"y" * 10, filename="index.md")
        asset = _StreamUpload(b"png", filename="a.png", content_type="image/png")
        self._ingest(
            _request(content_length=_CAP),
            _StreamUpload(b"x" * 40),
            markdown=md, assets=[asset],
        )
        sent = self.stub.IngestPage.call_args.args[0]
        self.assertEqual(sent.content_documents[0].data, b"y" * 10)
        self.assertEqual(sent.assets[0].data, b"png")


class TestPageDetailContentFormats(unittest.TestCase):
    """`GET /pages/{id}` carries content_formats (D1)."""

    def test_detail_carries_formats(self):
        stub = MagicMock()
        stub.GetPage.return_value = archive_pb2.PageResponse(
            id="p1", user_id="u1", url="https://example.com", title="T",
            content_formats=["html", "markdown"],
        )
        with patch.object(archive_routes, "archive_stub", return_value=stub):
            resp = asyncio.run(archive_routes.get_page(_request(), "p1"))
        self.assertEqual(resp["content_formats"], ["html", "markdown"])

    def test_detail_legacy_page_has_empty_formats(self):
        stub = MagicMock()
        stub.GetPage.return_value = archive_pb2.PageResponse(id="p1", user_id="u1")
        with patch.object(archive_routes, "archive_stub", return_value=stub):
            resp = asyncio.run(archive_routes.get_page(_request(), "p1"))
        self.assertEqual(resp["content_formats"], [])


class TestTextFileServingHeaders(unittest.TestCase):
    """`GET /pages/{id}/f/index.md|index.txt`: pinned text content types with
    the same sandbox CSP header set (D6 pre-work; archived-html-serving)."""

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

    def test_markdown_served_with_sandbox_headers(self):
        resp = self._serve(b"# md", "text/markdown; charset=utf-8", "index.md")
        self.assertEqual(resp.headers["content-type"], "text/markdown; charset=utf-8")
        self.assertEqual(resp.headers["content-security-policy"], SANDBOX_CSP)
        self.assertNotIn("allow-same-origin", resp.headers["content-security-policy"])
        self.assertEqual(resp.headers["x-content-type-options"], "nosniff")
        # Referrer-Policy stays an HTML-only header (serving.sandbox_headers).
        self.assertNotIn("referrer-policy", resp.headers)

    def test_plain_text_served_with_sandbox_headers(self):
        resp = self._serve(b"txt", "text/plain; charset=utf-8", "index.txt")
        self.assertEqual(resp.headers["content-type"], "text/plain; charset=utf-8")
        self.assertEqual(resp.headers["content-security-policy"], SANDBOX_CSP)
        self.assertEqual(resp.headers["x-content-type-options"], "nosniff")

    def test_text_types_pinned_to_utf8_when_stored_type_lacks_it(self):
        resp = self._serve(b"# md", "text/markdown", "index.md")
        self.assertEqual(resp.headers["content-type"], "text/markdown; charset=utf-8")
        resp = self._serve(b"txt", "text/plain", "index.txt")
        self.assertEqual(resp.headers["content-type"], "text/plain; charset=utf-8")

    def test_missing_type_derived_from_shared_map(self):
        resp = self._serve(b"# md", "", "index.md")
        self.assertEqual(resp.headers["content-type"], "text/markdown; charset=utf-8")
        resp = self._serve(b"txt", "", "index.txt")
        self.assertEqual(resp.headers["content-type"], "text/plain; charset=utf-8")

    def test_content_type_map_covers_text_formats(self):
        self.assertEqual(content_type_for_path("index.md"), "text/markdown; charset=utf-8")
        self.assertEqual(content_type_for_path("index.txt"), "text/plain; charset=utf-8")
        # Unchanged for everything else.
        self.assertEqual(content_type_for_path("index.html"), "text/html; charset=utf-8")
        self.assertEqual(content_type_for_path("a.bin"), "application/octet-stream")


if __name__ == "__main__":
    unittest.main()
