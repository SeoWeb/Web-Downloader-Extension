"""Text-native downloads (tasks 1.2/1.3): multi-format ingest + reads.

Covers the pagepocket-archive-service spec scenarios: every content document
is stored as its own R2 object (index.html beside index.md/index.txt) with the
pinned content types, meta.json records content_formats (html first), HTML
alone is sanitized/asset-rewritten, size_bytes counts every stored byte,
search/preview text derive from the HTML when present else the text document,
zero-document ingests are rejected exactly like other invalid input, the page
read reports content_formats, the ZIP export carries the new objects, and the
legacy (html-only) behavior is unchanged.
"""

import io
import json
import os
import sys
import unittest
import zipfile
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "shared"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "shared", "proto_generated"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Stub out boto3/botocore before servicer imports them
sys.modules["boto3"] = MagicMock()
sys.modules["botocore"] = MagicMock()
sys.modules["botocore.config"] = MagicMock()

# ---------------------------------------------------------------------------
# Shared per-service module names (same contract as test_archive.py — see the
# note there and tests/conftest.py): register this suite's copies under a
# unique alias so combined multi-suite pytest runs stay isolated.
# ---------------------------------------------------------------------------
_PP_ALIAS = "_ppsvc_archive-service_"
if _PP_ALIAS + "models" not in sys.modules:
    for _name in ("models", "servicer", "quota", "page_processor"):
        sys.modules.pop(_name, None)

import archive_pb2
import grpc
import servicer
from db import Base, db_session
from page_processor import sanitise_and_rewrite
from servicer import ArchiveServicer

for _name in ("models", "page_processor", "quota", "servicer"):
    sys.modules[_PP_ALIAS + _name] = sys.modules[_name]

HTML = b"<html><head><title>Page</title></head><body><p>Hello World</p></body></html>"
MD = b"# Hello World\n\nSome **markdown** body."
TXT = b"Hello World plain text body."


def _build_ingest_request(**overrides):
    defaults = {
        "user_id": "u1", "url": "https://example.com", "title": "",
        "html_content": HTML,
        "assets": [], "extension_job_id": "job1", "plan": "free",
    }
    defaults.update(overrides)
    return archive_pb2.IngestPageRequest(**defaults)


def _doc(content_format, data):
    return archive_pb2.ContentDocument(content_format=content_format, data=data)


class _FakeContext:
    def __init__(self):
        self._code = None
        self._details = None

    def set_code(self, code):
        self._code = code

    def set_details(self, details):
        self._details = details


class _SqliteServicerTest(unittest.TestCase):
    """Real SQLite DB + mocked R2/search: uploads are inspectable, and the
    inserted Page row can be read back (same style as TestPerUserIdempotency
    in test_archive.py)."""

    def setUp(self):
        from sqlalchemy import create_engine as ce
        self.engine = ce("sqlite://")
        Base.metadata.create_all(self.engine)
        self.engine_patcher = patch("servicer.get_engine", return_value=self.engine)
        self.engine_patcher.start()
        self.addCleanup(self.engine_patcher.stop)

        self.r2 = MagicMock()
        self.r2_patcher = patch("servicer.R2Client", return_value=self.r2)
        self.r2_patcher.start()
        self.addCleanup(self.r2_patcher.stop)

        self.search_stub = MagicMock()
        self.search_patcher = patch(
            "servicer._get_search_stub", return_value=self.search_stub
        )
        self.search_patcher.start()
        self.addCleanup(self.search_patcher.stop)

        self.cache_get_patcher = patch("servicer.cache_get", return_value=None)
        self.cache_get_patcher.start()
        self.addCleanup(self.cache_get_patcher.stop)
        self.cache_set_patcher = patch("servicer.cache_set", return_value=None)
        self.cache_set_patcher.start()
        self.addCleanup(self.cache_set_patcher.stop)

    def _uploads(self):
        """Uploaded R2 objects as {key: (data, content_type)}."""
        return {
            c.args[0]: (c.args[1], c.args[2])
            for c in self.r2.upload.call_args_list
        }

    def _meta(self, page_id, user_id="u1"):
        data, _ct = self._uploads()[f"{user_id}/{page_id}/meta.json"]
        return json.loads(data.decode("utf-8"))

    def _page_row(self, page_id):
        from models import Page
        from sqlalchemy import select
        with db_session(self.engine) as session:
            row = session.execute(
                select(Page).where(Page.id == page_id)
            ).scalar_one()
            # Read the attributes before the session closes (commit expires).
            return {
                "size_bytes": row.size_bytes,
                "r2_key": row.r2_key,
                "preview_text": row.preview_text,
                "title": row.title,
                "user_id": row.user_id,
            }


class TestMultiFormatRoundTrip(_SqliteServicerTest):
    """Spec scenario "Formats stored and reported": html + md + txt ingest."""

    def _ingest(self):
        return ArchiveServicer().IngestPage(
            _build_ingest_request(
                content_documents=[_doc("markdown", MD), _doc("text", TXT)],
            ),
            _FakeContext(),
        )

    def test_three_documents_stored_with_pinned_types(self):
        ctx = _FakeContext()
        resp = self._ingest()
        self.assertIsNone(ctx._code)
        self.assertTrue(resp.success)

        uploads = self._uploads()
        page_id = resp.page_id
        self.assertEqual(
            sorted(uploads),
            sorted([
                f"u1/{page_id}/index.html",
                f"u1/{page_id}/index.md",
                f"u1/{page_id}/index.txt",
                f"u1/{page_id}/meta.json",
            ]),
        )
        html_data, html_ct = uploads[f"u1/{page_id}/index.html"]
        md_data, md_ct = uploads[f"u1/{page_id}/index.md"]
        txt_data, txt_ct = uploads[f"u1/{page_id}/index.txt"]
        self.assertEqual(html_ct, "text/html; charset=utf-8")
        self.assertEqual(md_ct, "text/markdown; charset=utf-8")
        self.assertEqual(txt_ct, "text/plain; charset=utf-8")
        # HTML sanitized (nothing to strip here, but it went through the
        # processor), text documents stored verbatim.
        self.assertEqual(html_data, sanitise_and_rewrite(HTML, {})[0])
        self.assertEqual(md_data, MD)
        self.assertEqual(txt_data, TXT)

    def test_meta_json_records_formats_and_full_size(self):
        resp = self._ingest()
        meta = self._meta(resp.page_id)
        self.assertEqual(meta["content_formats"], ["html", "markdown", "text"])
        self.assertEqual(
            meta["size_bytes"], len(HTML) + len(MD) + len(TXT),
        )

    def test_response_and_page_row(self):
        resp = self._ingest()
        self.assertEqual(resp.content_formats, ["html", "markdown", "text"])
        row = self._page_row(resp.page_id)
        self.assertEqual(row["size_bytes"], len(HTML) + len(MD) + len(TXT))
        self.assertTrue(row["r2_key"].endswith("/index.html"))
        # Search/preview text extracted from the HTML (not the text docs).
        self.assertIn("Hello World", row["preview_text"])
        sent = self.search_stub.IndexPage.call_args.args[0]
        self.assertIn("Hello World", sent.body_text)
        self.assertNotIn("markdown", sent.body_text)

    def test_detail_read_reports_formats_from_meta(self):
        resp = self._ingest()
        page_id = resp.page_id
        # Serve the stored meta.json from the mocked R2 client.
        body = MagicMock()
        body.read.return_value = self._uploads()[f"u1/{page_id}/meta.json"][0]
        self.r2.bucket = "b"
        self.r2.client.get_object.return_value = {"Body": body}

        ctx = _FakeContext()
        detail = ArchiveServicer().GetPage(
            archive_pb2.GetPageRequest(page_id=page_id, user_id="u1"), ctx,
        )
        self.assertIsNone(ctx._code)
        self.assertEqual(
            list(detail.content_formats), ["html", "markdown", "text"],
        )
        self.r2.client.get_object.assert_called_once_with(
            Bucket="b", Key=f"u1/{page_id}/meta.json",
        )


class TestTextOnlyIngest(_SqliteServicerTest):
    """Spec scenario "Text-only page searchable" (D1/D4)."""

    def _ingest_markdown_only(self):
        return ArchiveServicer().IngestPage(
            _build_ingest_request(html_content=b"", content_documents=[
                _doc("markdown", MD),
            ]),
            _FakeContext(),
        )

    def test_markdown_only_page_stored_without_html(self):
        resp = self._ingest_markdown_only()
        self.assertTrue(resp.success)
        self.assertEqual(resp.content_formats, ["markdown"])

        uploads = self._uploads()
        page_id = resp.page_id
        self.assertNotIn(f"u1/{page_id}/index.html", uploads)
        data, ct = uploads[f"u1/{page_id}/index.md"]
        self.assertEqual(data, MD)
        self.assertEqual(ct, "text/markdown; charset=utf-8")
        meta = self._meta(page_id)
        self.assertEqual(meta["content_formats"], ["markdown"])
        self.assertEqual(meta["size_bytes"], len(MD))

        row = self._page_row(page_id)
        self.assertTrue(row["r2_key"].endswith("/index.md"))
        self.assertEqual(row["size_bytes"], len(MD))
        # Preview + search text derive from the markdown document itself.
        self.assertTrue(row["preview_text"].startswith("# Hello World"))
        sent = self.search_stub.IndexPage.call_args.args[0]
        self.assertIn("Some **markdown** body.", sent.body_text)

    def test_plain_text_only_page(self):
        resp = ArchiveServicer().IngestPage(
            _build_ingest_request(html_content=b"", content_documents=[
                _doc("text", TXT),
            ]),
            _FakeContext(),
        )
        self.assertEqual(resp.content_formats, ["text"])
        uploads = self._uploads()
        data, ct = uploads[f"u1/{resp.page_id}/index.txt"]
        self.assertEqual(data, TXT)
        self.assertEqual(ct, "text/plain; charset=utf-8")
        self.assertNotIn(f"u1/{resp.page_id}/index.md", uploads)
        self.assertTrue(self._page_row(resp.page_id)["r2_key"].endswith("/index.txt"))

    def test_html_via_content_documents_is_sanitized(self):
        """A content_documents html entry (empty html_content) is the primary
        document: sanitized like any other index.html."""
        dirty = b"<html><body><script>alert(1)</script><p>Hi</p></body></html>"
        resp = ArchiveServicer().IngestPage(
            _build_ingest_request(html_content=b"", content_documents=[
                _doc("html", dirty),
            ]),
            _FakeContext(),
        )
        self.assertEqual(resp.content_formats, ["html"])
        data, ct = self._uploads()[f"u1/{resp.page_id}/index.html"]
        self.assertEqual(ct, "text/html; charset=utf-8")
        self.assertNotIn(b"alert(1)", data)
        self.assertIn(b"<p>Hi</p>", data)


class TestEmptyContentRejected(_SqliteServicerTest):
    """Spec scenario "Empty content rejected": no document at all is invalid
    input — the same INVALID_ARGUMENT path as the extension_job_id guard."""

    def _reject(self, request):
        ctx = _FakeContext()
        resp = ArchiveServicer().IngestPage(request, ctx)
        return resp, ctx

    def test_no_html_and_no_documents_rejected(self):
        with patch("servicer.reserve_quota") as mock_reserve:
            resp, ctx = self._reject(
                _build_ingest_request(html_content=b""),
            )
        self.assertFalse(resp.success)
        self.assertEqual(ctx._code, grpc.StatusCode.INVALID_ARGUMENT)
        self.assertTrue(ctx._details)
        self.r2.upload.assert_not_called()
        mock_reserve.assert_not_called()  # nothing reserved for invalid input

    def test_only_empty_document_payloads_rejected(self):
        _resp, ctx = self._reject(
            _build_ingest_request(
                html_content=b"",
                content_documents=[_doc("markdown", b"")],
            ),
        )
        self.assertEqual(ctx._code, grpc.StatusCode.INVALID_ARGUMENT)
        self.r2.upload.assert_not_called()

    def test_unknown_format_rejected(self):
        _resp, ctx = self._reject(
            _build_ingest_request(
                html_content=b"",
                content_documents=[_doc("epub", b"book-bytes")],
            ),
        )
        self.assertEqual(ctx._code, grpc.StatusCode.INVALID_ARGUMENT)
        self.assertIn("content_format", ctx._details)
        self.r2.upload.assert_not_called()

    def test_html_plus_empty_part_still_ingests(self):
        """An empty text part contributes nothing but the page still stores."""
        resp, ctx = self._reject(
            _build_ingest_request(content_documents=[_doc("text", b"")]),
        )
        self.assertIsNone(ctx._code)
        self.assertTrue(resp.success)
        self.assertEqual(resp.content_formats, ["html"])
        self.assertNotIn(f"u1/{resp.page_id}/index.txt", self._uploads())


class TestLegacyHtmlOnlyIngest(_SqliteServicerTest):
    """Spec scenario "Old pusher unaffected": a request without
    content_documents behaves exactly like today."""

    def test_html_only_unchanged(self):
        resp = ArchiveServicer().IngestPage(
            _build_ingest_request(
                title="T",
                assets=[archive_pb2.Asset(
                    filename="a.png", content_type="image/png", data=b"png",
                )],
            ),
            _FakeContext(),
        )
        self.assertTrue(resp.success)
        self.assertEqual(resp.content_formats, ["html"])

        uploads = self._uploads()
        page_id = resp.page_id
        self.assertEqual(
            sorted(uploads),
            sorted([
                f"u1/{page_id}/assets/a.png",
                f"u1/{page_id}/index.html",
                f"u1/{page_id}/meta.json",
            ]),
        )
        html_data, html_ct = uploads[f"u1/{page_id}/index.html"]
        self.assertEqual(html_ct, "text/html; charset=utf-8")
        self.assertEqual(html_data, sanitise_and_rewrite(HTML, {})[0])

        meta = self._meta(page_id)
        self.assertEqual(meta["content_formats"], ["html"])
        self.assertEqual(meta["size_bytes"], len(HTML) + 3)  # html + asset

        row = self._page_row(page_id)
        self.assertEqual(row["size_bytes"], len(HTML) + 3)
        self.assertTrue(row["r2_key"].endswith("/index.html"))

    def test_legacy_detail_defaults_to_html(self):
        """A pre-text page (meta without the key / R2 miss) reads as HTML."""
        from models import Page
        from sqlalchemy import create_engine as ce

        engine = ce("sqlite://")
        Base.metadata.create_all(engine)
        with patch("servicer.get_engine", return_value=engine), \
             patch("servicer.cache_get", return_value=None), \
             patch("servicer.cache_set", return_value=None):
            with db_session(engine) as session:
                session.add(Page(id="old-1", user_id="u1", url="https://x",
                                 title="Old", r2_key="u1/old-1/index.html"))
            self.r2.bucket = "b"
            self.r2.client.get_object.side_effect = Exception("NoSuchKey")

            ctx = _FakeContext()
            detail = ArchiveServicer().GetPage(
                archive_pb2.GetPageRequest(page_id="old-1", user_id="u1"), ctx,
            )
        self.assertIsNone(ctx._code)
        self.assertEqual(list(detail.content_formats), ["html"])

    def test_text_only_detail_falls_back_to_primary_object(self):
        """Meta.json unreadable for a text-only page: the page row's primary
        object name (index.md) resolves the formats."""
        from models import Page
        from sqlalchemy import create_engine as ce

        engine = ce("sqlite://")
        Base.metadata.create_all(engine)
        with patch("servicer.get_engine", return_value=engine), \
             patch("servicer.cache_get", return_value=None), \
             patch("servicer.cache_set", return_value=None):
            with db_session(engine) as session:
                session.add(Page(id="txt-1", user_id="u1", url="https://x",
                                 title="Txt", r2_key="u1/txt-1/index.md"))
            self.r2.bucket = "b"
            self.r2.client.get_object.side_effect = Exception("boom")

            detail = ArchiveServicer().GetPage(
                archive_pb2.GetPageRequest(page_id="txt-1", user_id="u1"),
                _FakeContext(),
            )
        self.assertEqual(list(detail.content_formats), ["markdown"])


class _MissingObjectError(Exception):
    """Stand-in for an R2 NoSuchKey failure in the fake client."""


class TestRetryPendingIndexingTextOnly(_SqliteServicerTest):
    """A text-only page whose ingest-time indexing failed is re-indexed from
    its stored text document — never left pending forever."""

    def test_retry_reads_index_md_when_no_html(self):
        with patch("servicer._get_search_stub", return_value=None):
            resp = ArchiveServicer().IngestPage(
                _build_ingest_request(html_content=b"", content_documents=[
                    _doc("markdown", MD),
                ]),
                _FakeContext(),
            )
        row = self._page_row(resp.page_id)
        self.assertTrue(row["r2_key"].endswith("/index.md"))
        from models import Page
        from sqlalchemy import select
        with db_session(self.engine) as session:
            pending_row = session.execute(
                select(Page).where(Page.id == resp.page_id)
            ).scalar_one()
            self.assertFalse(pending_row.search_indexed)

        # Search is back up; R2 serves the stored objects (index.html misses,
        # index.md holds the page's text).
        self.r2.bucket = "b"

        def _get_object(Bucket=None, Key=None):
            uploads = self._uploads()
            if Key not in uploads:
                raise _MissingObjectError(Key)
            body = MagicMock()
            body.read.return_value = uploads[Key][0]
            return {"Body": body}

        self.r2.client.get_object.side_effect = _get_object

        result = ArchiveServicer().RetryPendingIndexing(
            archive_pb2.RetryPendingIndexingRequest(limit=10), _FakeContext(),
        )
        self.assertEqual((result.retried, result.succeeded), (1, 1))
        sent = self.search_stub.IndexPage.call_args.args[0]
        self.assertIn("Some **markdown** body.", sent.body_text)


# ---------------------------------------------------------------------------
# ZIP export: the new index.md/index.txt objects ride along naturally.
# ---------------------------------------------------------------------------

class _FakeBody:
    """Minimal boto3 StreamingBody: read(amt) semantics for copyfileobj."""

    def __init__(self, data: bytes):
        self._data = data
        self._pos = 0

    def read(self, amt=None):
        if amt is None or amt < 0:
            out = self._data[self._pos:]
            self._pos = len(self._data)
            return out
        out = self._data[self._pos:self._pos + amt]
        self._pos += len(out)
        return out

    def close(self):
        pass


class _FakeR2:
    """Fake R2Client: prefix listing + per-key reads over an in-memory dict."""

    def __init__(self, objects):
        self.bucket = "test-bucket"
        self.objects = objects
        paginator = MagicMock()
        paginator.paginate = self._paginate
        self.client = MagicMock()
        self.client.get_paginator.return_value = paginator
        self.client.get_object = self._get_object

    def _paginate(self, Bucket=None, Prefix=None, **_kwargs):
        keys = sorted(k for k in self.objects if k.startswith(Prefix))
        yield {"Contents": [{"Key": k} for k in keys]}

    def _get_object(self, Bucket=None, Key=None):
        return {"Body": _FakeBody(self.objects[Key]), "ContentType": "application/octet-stream"}


class TestZipExportIncludesTextFormats(unittest.TestCase):
    PAGE_PREFIX = "u1/p1/"

    def setUp(self):
        self.engine_patcher = patch("servicer.get_engine", return_value=MagicMock())
        self.engine_patcher.start()
        self.addCleanup(self.engine_patcher.stop)
        self.db_patcher = patch("servicer.db_session")
        self.db_patcher.start()
        self.addCleanup(self.db_patcher.stop)
        # Patched so the constructor never builds the real R2 client; the
        # fake is then installed directly (same style as test_export_page.py).
        self.r2_cls_patcher = patch("servicer.R2Client")
        self.r2_cls_patcher.start()
        self.addCleanup(self.r2_cls_patcher.stop)

        page = MagicMock()
        page.id = "p1"
        page.user_id = "u1"
        mock_session = MagicMock()
        mock_session.execute.return_value.scalar_one_or_none.return_value = page
        servicer.db_session.return_value.__enter__ = lambda s: mock_session
        servicer.db_session.return_value.__exit__ = lambda s, *a: None

        self.r2 = _FakeR2({
            f"{self.PAGE_PREFIX}index.html": HTML,
            f"{self.PAGE_PREFIX}index.md": MD,
            f"{self.PAGE_PREFIX}index.txt": TXT,
            f"{self.PAGE_PREFIX}meta.json": b'{"title":"Test"}',
        })
        self.svc = ArchiveServicer()
        self.svc.r2 = self.r2

    def test_zip_contains_all_content_documents(self):
        chunks = list(self.svc.ExportPage(
            archive_pb2.ExportPageRequest(page_id="p1", user_id="u1"),
            _FakeContext(),
        ))
        blob = b"".join(c.data for c in chunks)
        with zipfile.ZipFile(io.BytesIO(blob)) as zf:
            self.assertEqual(
                zf.namelist(),
                [
                    "index.html",
                    "meta.json",
                    "index.md",
                    "index.txt",
                ],
            )
            self.assertIsNone(zf.testzip())
            self.assertEqual(zf.read("index.md"), MD)
            self.assertEqual(zf.read("index.txt"), TXT)
            self.assertEqual(zf.read("index.html"), HTML)


if __name__ == "__main__":
    unittest.main()
