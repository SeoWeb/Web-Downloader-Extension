"""Multipage downloads (multipage-download-fixes 6.2–6.4): PageDocument ingest
+ retrieval + export.

Covers the pagepocket-archive-service spec scenarios added by D7: each
PageDocument is stored at ``{user_id}/{page_id}/pages/<path>`` (slash-preserving
keys, same path handling as assets), meta.json records the pages manifest
(path/title/url/content_format), pages bytes count toward ``size_bytes`` and
the quota counters, unsafe page paths are rejected by the same hardening rules
as asset paths, GetPage reports the manifest (empty/tolerant for legacy
pages), and the ZIP export carries the pages/ directory with zero export-side
changes. Legacy ingests without ``pages`` behave exactly as before.
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
from models import UserQuota
from servicer import ArchiveServicer
from sqlalchemy import select

for _name in ("models", "page_processor", "quota", "servicer"):
    sys.modules[_PP_ALIAS + _name] = sys.modules[_name]

HTML = b"<html><head><title>Page</title></head><body><p>Hello World</p></body></html>"
PAGE_MD = b"# About\n\nLinked page markdown body."
PAGE_NESTED_TXT = b"Nested linked page plain text."


class _FakeContext:
    def __init__(self):
        self._code = None
        self._details = None

    def set_code(self, code):
        self._code = code

    def set_details(self, details):
        self._details = details


def _page_doc(path, title="", url="", content_format="", data=b""):
    return archive_pb2.PageDocument(
        path=path, title=title, url=url,
        content_format=content_format, data=data,
    )


def _build_ingest_request(**overrides):
    defaults = {
        "user_id": "u1", "url": "https://example.com", "title": "",
        "html_content": HTML,
        "assets": [], "extension_job_id": "job1", "plan": "free",
    }
    defaults.update(overrides)
    return archive_pb2.IngestPageRequest(**defaults)


class _SqliteServicerTest(unittest.TestCase):
    """Real SQLite DB + mocked R2/search: uploads are inspectable, and the
    inserted Page/UserQuota rows can be read back (same style as
    test_content_documents.py)."""

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
        """Uploaded R2 objects as {key: (data, content_type)} (later calls
        overwrite earlier ones, mirroring R2 put semantics)."""
        return {
            c.args[0]: (c.args[1], c.args[2])
            for c in self.r2.upload.call_args_list
        }

    def _meta(self, page_id, user_id="u1"):
        data, _ct = self._uploads()[f"{user_id}/{page_id}/meta.json"]
        return json.loads(data.decode("utf-8"))

    def _page_row(self, page_id):
        from models import Page
        with db_session(self.engine) as session:
            row = session.execute(
                select(Page).where(Page.id == page_id)
            ).scalar_one()
            # Read the attributes before the session closes (commit expires).
            return {
                "size_bytes": row.size_bytes,
                "r2_key": row.r2_key,
                "title": row.title,
                "user_id": row.user_id,
            }

    def _quota_total_bytes(self, user_id="u1"):
        with db_session(self.engine) as session:
            quota = session.execute(
                select(UserQuota).where(UserQuota.user_id == user_id)
            ).scalar_one()
            return quota.total_bytes


class TestPageDocumentIngest(_SqliteServicerTest):
    """Spec scenarios "Multi-document ingest is stored under pages/" and
    "Pages manifest recorded in meta.json": html + pages/*.md round-trip."""

    def _ingest(self):
        return ArchiveServicer().IngestPage(
            _build_ingest_request(pages=[
                _page_doc("about.md", "About Page", "https://example.com/about",
                          "markdown", PAGE_MD),
                _page_doc("docs/notes.txt", "Notes", "https://example.com/notes",
                          "text", PAGE_NESTED_TXT),
            ]),
            _FakeContext(),
        )

    def test_pages_stored_under_pages_prefix_with_pinned_types(self):
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
                f"u1/{page_id}/meta.json",
                # Slash-preserving keys under pages/ — nested paths kept.
                f"u1/{page_id}/pages/about.md",
                f"u1/{page_id}/pages/docs/notes.txt",
            ]),
        )
        md_data, md_ct = uploads[f"u1/{page_id}/pages/about.md"]
        txt_data, txt_ct = uploads[f"u1/{page_id}/pages/docs/notes.txt"]
        self.assertEqual(md_data, PAGE_MD)  # verbatim — never rewritten
        self.assertEqual(md_ct, "text/markdown; charset=utf-8")
        self.assertEqual(txt_data, PAGE_NESTED_TXT)
        self.assertEqual(txt_ct, "text/plain; charset=utf-8")

    def test_meta_manifest_records_path_title_url_format(self):
        resp = self._ingest()
        meta = self._meta(resp.page_id)
        self.assertEqual(meta["pages"], [
            {
                "path": "about.md",
                "title": "About Page",
                "url": "https://example.com/about",
                "content_format": "markdown",
            },
            {
                "path": "docs/notes.txt",
                "title": "Notes",
                "url": "https://example.com/notes",
                "content_format": "text",
            },
        ])
        # Request-order manifest; main-page fields untouched.
        self.assertEqual(meta["content_formats"], ["html"])

    def test_quota_and_row_size_bytes_include_pages(self):
        resp = self._ingest()
        total = len(HTML) + len(PAGE_MD) + len(PAGE_NESTED_TXT)
        row = self._page_row(resp.page_id)
        self.assertEqual(row["size_bytes"], total)
        self.assertEqual(self._meta(resp.page_id)["size_bytes"], total)
        # The reservation (reserve_quota → confirm_quota) counted pages bytes.
        self.assertEqual(self._quota_total_bytes(), total)

    def test_duplicate_path_last_payload_wins_single_manifest_entry(self):
        """A repeated normalized path stores the last payload (R2 overwrite
        semantics) and one manifest entry."""
        resp = ArchiveServicer().IngestPage(
            _build_ingest_request(pages=[
                _page_doc("dup.md", "First", "https://x/1", "markdown", b"first"),
                _page_doc("./dup.md", "Second", "https://x/2", "markdown", b"second"),
            ]),
            _FakeContext(),
        )
        self.assertTrue(resp.success)
        uploads = self._uploads()
        data, _ct = uploads[f"u1/{resp.page_id}/pages/dup.md"]
        self.assertEqual(data, b"second")
        manifest = self._meta(resp.page_id)["pages"]
        self.assertEqual(len(manifest), 1)
        self.assertEqual((manifest[0]["title"], manifest[0]["url"]), ("Second", "https://x/2"))

    def test_pages_do_not_satisfy_content_requirement(self):
        """pages supplements the main document — a pages-only request is
        still an empty-content reject (same INVALID_ARGUMENT style)."""
        with patch("servicer.reserve_quota") as mock_reserve:
            ctx = _FakeContext()
            resp = ArchiveServicer().IngestPage(
                _build_ingest_request(
                    html_content=b"",
                    pages=[_page_doc("about.md", data=PAGE_MD)],
                ),
                ctx,
            )
        self.assertFalse(resp.success)
        self.assertEqual(ctx._code, grpc.StatusCode.INVALID_ARGUMENT)
        self.r2.upload.assert_not_called()
        mock_reserve.assert_not_called()


class TestPagePathHardening(_SqliteServicerTest):
    """Spec "Archive file path hardening" applied to pages paths: traversal,
    absolute, and empty paths are INVALID_ARGUMENT before anything is
    reserved or uploaded (same helper as GetArchiveFile/ExportPage)."""

    def _reject(self, bad_path):
        with patch("servicer.reserve_quota") as mock_reserve:
            ctx = _FakeContext()
            resp = ArchiveServicer().IngestPage(
                _build_ingest_request(pages=[
                    _page_doc("ok.md", data=PAGE_MD),
                    _page_doc(bad_path, data=b"evil"),
                ]),
                ctx,
            )
        return resp, ctx, mock_reserve

    def test_traversal_rejected(self):
        resp, ctx, mock_reserve = self._reject("../evil.md")
        self.assertEqual(ctx._code, grpc.StatusCode.INVALID_ARGUMENT)
        self.assertFalse(resp.success)
        self.r2.upload.assert_not_called()
        mock_reserve.assert_not_called()

    def test_nested_traversal_rejected(self):
        _resp, ctx, _mock = self._reject("docs/../../evil.md")
        self.assertEqual(ctx._code, grpc.StatusCode.INVALID_ARGUMENT)
        self.r2.upload.assert_not_called()

    def test_absolute_path_rejected(self):
        _resp, ctx, _mock = self._reject("/etc/passwd")
        self.assertEqual(ctx._code, grpc.StatusCode.INVALID_ARGUMENT)
        self.r2.upload.assert_not_called()

    def test_empty_path_rejected(self):
        _resp, ctx, _mock = self._reject("")
        self.assertEqual(ctx._code, grpc.StatusCode.INVALID_ARGUMENT)
        self.r2.upload.assert_not_called()

    def test_rejection_happens_before_any_upload(self):
        """The safe sibling document is NOT uploaded either — the whole
        request fails atomically, nothing reserved, nothing stored."""
        _resp, _ctx, mock_reserve = self._reject("../evil.md")
        self.r2.upload.assert_not_called()
        mock_reserve.assert_not_called()


class TestLegacyIngestWithoutPages(_SqliteServicerTest):
    """Spec scenario "Ingest without pages is unchanged": no pages/ objects,
    no manifest entries, retrievable and exportable exactly as before."""

    def test_html_only_ingest_unchanged_and_reads_empty_pages(self):
        resp = ArchiveServicer().IngestPage(
            _build_ingest_request(title="Legacy"),
            _FakeContext(),
        )
        self.assertTrue(resp.success)
        page_id = resp.page_id

        uploads = self._uploads()
        self.assertEqual(
            sorted(uploads),
            sorted([
                f"u1/{page_id}/index.html",
                f"u1/{page_id}/meta.json",
            ]),
        )
        meta = self._meta(page_id)
        self.assertNotIn("pages", meta)  # no manifest entries
        self.assertEqual(meta["size_bytes"], len(HTML))

        # GetPage tolerates the absent manifest: empty pages list.
        body = MagicMock()
        body.read.return_value = uploads[f"u1/{page_id}/meta.json"][0]
        self.r2.bucket = "b"
        self.r2.client.get_object.return_value = {"Body": body}
        detail = ArchiveServicer().GetPage(
            archive_pb2.GetPageRequest(page_id=page_id, user_id="u1"),
            _FakeContext(),
        )
        self.assertEqual(list(detail.pages), [])
        self.assertEqual(list(detail.content_formats), ["html"])


class TestGetPagePagesManifest(_SqliteServicerTest):
    """Spec scenario "Detail exposes the pages list": GetPage reads the
    manifest from meta.json (one read, tolerant)."""

    def _ingest_with_pages(self):
        return ArchiveServicer().IngestPage(
            _build_ingest_request(pages=[
                _page_doc("about.md", "About Page", "https://example.com/about",
                          "markdown", PAGE_MD),
            ]),
            _FakeContext(),
        )

    def test_detail_reports_pages_manifest(self):
        resp = self._ingest_with_pages()
        page_id = resp.page_id
        body = MagicMock()
        body.read.return_value = self._uploads()[f"u1/{page_id}/meta.json"][0]
        self.r2.bucket = "b"
        self.r2.client.get_object.return_value = {"Body": body}

        detail = ArchiveServicer().GetPage(
            archive_pb2.GetPageRequest(page_id=page_id, user_id="u1"),
            _FakeContext(),
        )
        self.assertEqual(len(detail.pages), 1)
        summary = detail.pages[0]
        self.assertEqual(summary.path, "about.md")
        self.assertEqual(summary.title, "About Page")
        self.assertEqual(summary.url, "https://example.com/about")
        self.assertEqual(summary.content_format, "markdown")
        # Still exactly ONE meta.json read per page read (serves both the
        # formats and the manifest).
        self.r2.client.get_object.assert_called_once_with(
            Bucket="b", Key=f"u1/{page_id}/meta.json",
        )

    def test_unsafe_manifest_path_skipped_not_fatal(self):
        """A corrupted/hand-edited manifest never breaks the page read —
        unsafe entries are skipped, safe ones still surface."""
        resp = self._ingest_with_pages()
        page_id = resp.page_id
        meta = self._meta(page_id)
        meta["pages"].append({"path": "../evil.md", "title": "Evil"})
        body = MagicMock()
        body.read.return_value = json.dumps(meta).encode()
        self.r2.bucket = "b"
        self.r2.client.get_object.return_value = {"Body": body}

        detail = ArchiveServicer().GetPage(
            archive_pb2.GetPageRequest(page_id=page_id, user_id="u1"),
            _FakeContext(),
        )
        self.assertEqual([p.path for p in detail.pages], ["about.md"])

    def test_corrupt_meta_yields_empty_pages_and_format_fallback(self):
        """Unreadable meta.json (legacy/pre-format or storage failure): the
        read degrades — empty pages list, formats fall back to the primary
        object name — never an error."""
        resp = self._ingest_with_pages()
        self.r2.bucket = "b"
        self.r2.client.get_object.side_effect = Exception("boom")

        detail = ArchiveServicer().GetPage(
            archive_pb2.GetPageRequest(page_id=resp.page_id, user_id="u1"),
            _FakeContext(),
        )
        self.assertEqual(list(detail.pages), [])
        self.assertEqual(list(detail.content_formats), ["html"])

    def test_cached_detail_carries_pages_through_json_cache(self):
        """The page detail is cached as JSON: pages entries ride the round
        trip as plain dicts and come back as PageSummary messages."""
        resp = self._ingest_with_pages()
        page_id = resp.page_id
        cached = {
            "id": page_id,
            "user_id": "u1",
            "url": "https://example.com",
            "title": "Legacy",
            "preview_text": "p",
            "size_bytes": 10,
            "extension_job_id": "job1",
            "archived_at": "2026-01-01T00:00:00",
            "content_formats": ["html", "markdown"],
            "pages": [{
                "path": "about.md",
                "title": "About Page",
                "url": "https://example.com/about",
                "content_format": "markdown",
            }],
        }
        with patch("servicer.cache_get", return_value=cached):
            detail = ArchiveServicer().GetPage(
                archive_pb2.GetPageRequest(page_id=page_id, user_id="u1"),
                _FakeContext(),
            )
        self.assertEqual(len(detail.pages), 1)
        self.assertEqual(detail.pages[0].path, "about.md")
        self.assertEqual(detail.pages[0].content_format, "markdown")
        self.r2.client.get_object.assert_not_called()  # served from cache


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


class TestZipExportContainsPages(unittest.TestCase):
    """Spec scenario "Exported zip contains pages/ directory entries": the
    per-page documents ride the existing prefix listing — ExportPage needs no
    pages-specific logic, and the zip mirrors the stored layout."""

    PAGE_PREFIX = "u1/p1/"

    def setUp(self):
        self.engine_patcher = patch("servicer.get_engine", return_value=MagicMock())
        self.engine_patcher.start()
        self.addCleanup(self.engine_patcher.stop)
        self.db_patcher = patch("servicer.db_session")
        self.db_patcher.start()
        self.addCleanup(self.db_patcher.stop)
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
            f"{self.PAGE_PREFIX}meta.json": b'{"title":"Test"}',
            f"{self.PAGE_PREFIX}pages/about.md": PAGE_MD,
            f"{self.PAGE_PREFIX}pages/docs/notes.txt": PAGE_NESTED_TXT,
            # Outside the page prefix — must stay excluded.
            "u1/p1.webp": b"thumbnail-bytes",
        })
        self.svc = ArchiveServicer()
        self.svc.r2 = self.r2

    def _export(self):
        chunks = list(self.svc.ExportPage(
            archive_pb2.ExportPageRequest(page_id="p1", user_id="u1"),
            _FakeContext(),
        ))
        return b"".join(c.data for c in chunks)

    def test_zip_contains_pages_entries_at_relative_names(self):
        blob = self._export()
        with zipfile.ZipFile(io.BytesIO(blob)) as zf:
            self.assertEqual(
                zf.namelist(),
                [
                    "index.html",
                    "meta.json",
                    "pages/about.md",
                    "pages/docs/notes.txt",
                ],
            )
            self.assertIsNone(zf.testzip())
            self.assertEqual(zf.read("pages/about.md"), PAGE_MD)
            self.assertEqual(zf.read("pages/docs/notes.txt"), PAGE_NESTED_TXT)
            self.assertEqual(zf.read("index.html"), HTML)
            self.assertNotIn("u1/p1.webp", zf.namelist())  # thumbnail excluded

    def test_export_is_deterministic(self):
        with zipfile.ZipFile(io.BytesIO(self._export())) as zf1, \
             zipfile.ZipFile(io.BytesIO(self._export())) as zf2:
            self.assertEqual(zf1.namelist(), zf2.namelist())


if __name__ == "__main__":
    unittest.main()
