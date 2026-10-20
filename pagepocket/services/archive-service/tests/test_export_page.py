"""ExportPage unit tests (add-page-export-zip 2.1–2.3).

Covers the Page ZIP Export + Export Authorization scenarios: the ZIP mirrors
the storage prefix (index.html, assets/**, meta.json — thumbnail excluded),
entry order is deterministic, paths stay relative/offline-renderable, export
works without any manifest, chunks respect the 512 KB bound, missing and
foreign pages are indistinguishable NOT_FOUNDs, and R2 failures surface the
existing classified statuses.
"""

import io
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
from servicer import ArchiveServicer

for _name in ("models", "page_processor", "quota", "servicer"):
    sys.modules[_PP_ALIAS + _name] = sys.modules[_name]

USER_ID = "u1"
PAGE_ID = "p1"
PAGE_PREFIX = f"{USER_ID}/{PAGE_ID}/"
CHUNK_LIMIT = 512 * 1024  # spec "Streaming bounds" maximum


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

    def __init__(self, objects, list_error=None, read_error=None):
        self.bucket = "test-bucket"
        self.objects = objects
        self.list_error = list_error
        self.read_error = read_error
        self.read_keys = []
        self.list_prefixes = []
        paginator = MagicMock()
        paginator.paginate = self._paginate
        self.client = MagicMock()
        self.client.get_paginator.return_value = paginator
        self.client.get_object = self._get_object

    def _paginate(self, Bucket=None, Prefix=None, **_kwargs):
        self.list_prefixes.append(Prefix)
        if self.list_error is not None:
            raise self.list_error
        keys = sorted(k for k in self.objects if k.startswith(Prefix))
        yield {"Contents": [{"Key": k} for k in keys]}

    def _get_object(self, Bucket=None, Key=None):
        self.read_keys.append(Key)
        if self.read_error is not None:
            raise self.read_error
        return {"Body": _FakeBody(self.objects[Key]), "ContentType": "application/octet-stream"}


class _FakeContext:
    def __init__(self):
        self._code = None
        self._details = None

    def set_code(self, code):
        self._code = code

    def set_details(self, details):
        self._details = details


def _make_page(page_id=PAGE_ID, user_id=USER_ID):
    page = MagicMock()
    page.id = page_id
    page.user_id = user_id
    return page


class _ExportPageTestBase(unittest.TestCase):
    """Servicer with mocked engine/db_session/R2Client kept active per test
    (same patcher style as TestReliableSearchIndexing in test_archive.py)."""

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

        self.mock_session = MagicMock()
        self.mock_session.execute.return_value.scalar_one_or_none.return_value = None
        servicer.db_session.return_value.__enter__ = lambda s: self.mock_session
        servicer.db_session.return_value.__exit__ = lambda s, *a: None

        self.svc = ArchiveServicer()

    def set_db_page(self, page_or_none):
        self.mock_session.execute.return_value.scalar_one_or_none.return_value = page_or_none

    def set_r2(self, r2):
        self.svc.r2 = r2

    def _export(self, page_id=PAGE_ID, user_id=USER_ID):
        ctx = _FakeContext()
        chunks = list(self.svc.ExportPage(
            archive_pb2.ExportPageRequest(page_id=page_id, user_id=user_id), ctx,
        ))
        return ctx, chunks


def _objects_with_thumbnail(big_asset=None):
    """Standard page prefix + the thumbnail that must NEVER be included."""
    objects = {
        f"{PAGE_PREFIX}index.html": b"<html><body>saved page</body></html>",
        f"{PAGE_PREFIX}meta.json": b'{"title":"Test","url":"https://example.com"}',
        f"{PAGE_PREFIX}assets/a.jpg": big_asset or b"\xff\xd8\xff-jpeg-bytes",
        f"{PAGE_PREFIX}assets/pages/linked.html": b"<html>linked page</html>",
        # Outside the page prefix — excluded naturally (D2), but present in
        # the store so a naive implementation could pick it up.
        f"{USER_ID}/{PAGE_ID}.webp": b"thumbnail-bytes",
    }
    return objects


class TestExportPageZip(_ExportPageTestBase):
    def setUp(self):
        super().setUp()
        self.asset = os.urandom(1200 * 1024)  # incompressible → multi-chunk ZIP
        self.set_db_page(_make_page())
        self.r2 = _FakeR2(_objects_with_thumbnail(big_asset=self.asset))
        self.set_r2(self.r2)

    def test_zip_mirrors_prefix_with_deterministic_order(self):
        ctx, chunks = self._export()

        self.assertIsNone(ctx._code)
        blob = b"".join(c.data for c in chunks)
        with zipfile.ZipFile(io.BytesIO(blob)) as zf:
            # D3 order: index.html, meta.json, then assets sorted by key.
            self.assertEqual(
                zf.namelist(),
                [
                    "index.html",
                    "meta.json",
                    "assets/a.jpg",
                    "assets/pages/linked.html",
                ],
            )
            self.assertIsNone(zf.testzip())  # valid, uncorrupted archive
            self.assertEqual(zf.read("index.html"), b"<html><body>saved page</body></html>")
            self.assertEqual(zf.read("meta.json").startswith(b'{"title":"Test"'), True)
            self.assertEqual(zf.read("assets/a.jpg"), self.asset)
            self.assertEqual(zf.read("assets/pages/linked.html"), b"<html>linked page</html>")

        # Deterministic across exports (same page, no changes).
        ctx2, chunks2 = self._export()
        blob2 = b"".join(c.data for c in chunks2)
        self.assertIsNone(ctx2._code)
        with zipfile.ZipFile(io.BytesIO(blob)) as zf1, zipfile.ZipFile(io.BytesIO(blob2)) as zf2:
            self.assertEqual(zf1.namelist(), zf2.namelist())

    def test_thumbnail_and_foreign_prefix_excluded(self):
        self._export()

        # The thumbnail was never read, and no read/list escaped the prefix.
        self.assertNotIn(f"{USER_ID}/{PAGE_ID}.webp", self.r2.read_keys)
        self.assertTrue(all(k.startswith(PAGE_PREFIX) for k in self.r2.read_keys))
        self.assertEqual(self.r2.list_prefixes, [PAGE_PREFIX])

    def test_paths_are_relative_and_offline_renderable(self):
        _ctx, chunks = self._export()
        blob = b"".join(c.data for c in chunks)
        with zipfile.ZipFile(io.BytesIO(blob)) as zf:
            for name in zf.namelist():
                # Relative paths preserved exactly — extracted index.html
                # resolves assets/… offline, unmodified.
                self.assertFalse(name.startswith("/"), name)
                self.assertFalse(name.startswith(PAGE_PREFIX), name)
                self.assertFalse(name.startswith(f"{USER_ID}/"), name)
                self.assertNotIn("..", name.split("/"))
            # index.html sits at the archive root, next to assets/.
            self.assertIn("index.html", zf.namelist())

    def test_works_without_manifest(self):
        """Any pre-change page (no manifest anywhere) exports via listing."""
        self.set_r2(_FakeR2({
            f"{PAGE_PREFIX}index.html": b"<html>old page</html>",
            f"{PAGE_PREFIX}assets/legacy.png": b"png",
        }))

        ctx, chunks = self._export()

        self.assertIsNone(ctx._code)
        blob = b"".join(c.data for c in chunks)
        with zipfile.ZipFile(io.BytesIO(blob)) as zf:
            self.assertEqual(zf.namelist(), ["index.html", "assets/legacy.png"])
            self.assertEqual(zf.read("index.html"), b"<html>old page</html>")

    def test_chunks_respect_512kb_bound(self):
        _ctx, chunks = self._export()

        self.assertGreater(len(chunks), 1)  # the big asset forces several chunks
        for chunk in chunks:
            self.assertLessEqual(len(chunk.data), CHUNK_LIMIT)
        # Bound comes from the shared constant, not a local literal.
        self.assertEqual(servicer._EXPORT_CHUNK_BYTES, CHUNK_LIMIT)

    def test_spool_and_zip64_settings_match_design(self):
        """D3: the spool spills past 64 MB and the ZipFile is zip64-capable."""
        self.assertEqual(servicer._EXPORT_SPOOL_MAX_BYTES, 64 * 1024 * 1024)
        self.assertEqual(servicer._EXPORT_ZIP_COMPRESS_LEVEL, 6)
        _ctx, chunks = self._export()
        blob = b"".join(c.data for c in chunks)
        with zipfile.ZipFile(io.BytesIO(blob)) as zf:
            self.assertTrue(zf.filelist)  # entries present
            self.assertEqual(zf.comment, b"")


class TestExportPageErrors(_ExportPageTestBase):
    def test_missing_page_not_found(self):
        self.set_db_page(None)
        self.set_r2(_FakeR2({}))

        ctx, chunks = self._export()

        self.assertEqual(chunks, [])
        self.assertEqual(ctx._code, grpc.StatusCode.NOT_FOUND)
        self.assertEqual(ctx._details, "Page not found")

    def test_foreign_page_identical_not_found(self):
        """Ownership enforced: a foreign page is EXACTLY a missing page — no
        existence leak (same code, same details, no R2 access)."""
        self.set_db_page(_make_page(page_id=PAGE_ID, user_id="owner-u0"))
        r2 = _FakeR2(_objects_with_thumbnail())
        self.set_r2(r2)

        ctx, chunks = self._export(user_id="attacker-u2")

        self.assertEqual(chunks, [])
        self.assertEqual(ctx._code, grpc.StatusCode.NOT_FOUND)
        self.assertEqual(ctx._details, "Page not found")
        self.set_db_page(None)
        ctx_missing, _ = self._export(user_id="attacker-u2")
        self.assertEqual(ctx._code, ctx_missing._code)
        self.assertEqual(ctx._details, ctx_missing._details)
        self.assertEqual(r2.read_keys, [])
        self.assertEqual(r2.list_prefixes, [])

    def test_empty_user_id_invalid_argument(self):
        self.set_db_page(_make_page())
        self.set_r2(_FakeR2(_objects_with_thumbnail()))

        ctx, chunks = self._export(user_id="")

        self.assertEqual(chunks, [])
        self.assertEqual(ctx._code, grpc.StatusCode.INVALID_ARGUMENT)
        self.assertEqual(ctx._details, "user_id is required")

    def test_listing_failure_classified_unavailable(self):
        self.set_db_page(_make_page())
        self.set_r2(_FakeR2({}, list_error=Exception("SlowDown")))

        ctx, chunks = self._export()

        self.assertEqual(chunks, [])
        self.assertEqual(ctx._code, grpc.StatusCode.UNAVAILABLE)

    def test_read_failure_classified_not_found(self):
        self.set_db_page(_make_page())
        self.set_r2(_FakeR2(_objects_with_thumbnail(), read_error=Exception("NoSuchKey")))

        ctx, chunks = self._export()

        self.assertEqual(chunks, [])
        self.assertEqual(ctx._code, grpc.StatusCode.NOT_FOUND)

    def test_generic_storage_failure_classified_internal(self):
        self.set_db_page(_make_page())
        self.set_r2(_FakeR2(_objects_with_thumbnail(), read_error=OSError("connection reset")))

        ctx, chunks = self._export()

        self.assertEqual(chunks, [])
        self.assertEqual(ctx._code, grpc.StatusCode.INTERNAL)


if __name__ == "__main__":
    unittest.main()
