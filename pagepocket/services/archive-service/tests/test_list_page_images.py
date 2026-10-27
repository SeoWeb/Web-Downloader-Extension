"""ListPageImages unit tests (gallery-lightbox 1.1).

Covers the service-side contract: ownership exactly like GetArchiveFile
(missing and foreign pages are the same NOT_FOUND), R2 assets/ prefix
listing as the source of truth, image-extension filtering (incl. .avif)
with the shared content-type map, deterministic path-ascending order,
safe relative paths only, the images-only gallery title flag, and the
classified storage-failure statuses.
"""

import os
import sys
import unittest
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
ASSETS_PREFIX = f"{USER_ID}/{PAGE_ID}/assets/"


class _FakeR2:
    """Fake R2Client: assets/ prefix listing over an in-memory dict.

    Unlike the ExportPage fake, pages are yielded in INSERTION order (not
    sorted) so the servicer's path-ascending sort is actually exercised.
    """

    def __init__(self, objects, list_error=None):
        self.bucket = "test-bucket"
        self.objects = objects
        self.list_error = list_error
        self.list_prefixes = []
        paginator = MagicMock()
        paginator.paginate = self._paginate
        self.client = MagicMock()
        self.client.get_paginator.return_value = paginator

    def _paginate(self, Bucket=None, Prefix=None, **_kwargs):
        self.list_prefixes.append(Prefix)
        if self.list_error is not None:
            raise self.list_error
        keys = [k for k in self.objects if k.startswith(Prefix)]
        # Split into deterministic unsorted "pages" of two.
        for i in range(0, len(keys), 2):
            yield {
                "Contents": [
                    {"Key": k, "Size": self.objects[k]} for k in keys[i:i + 2]
                ],
            }


class _FakeContext:
    def __init__(self):
        self._code = None
        self._details = None

    def set_code(self, code):
        self._code = code

    def set_details(self, details):
        self._details = details


def _make_page(page_id=PAGE_ID, user_id=USER_ID, title="Some Page"):
    page = MagicMock()
    page.id = page_id
    page.user_id = user_id
    page.title = title
    return page


class _ListPageImagesTestBase(unittest.TestCase):
    """Servicer with mocked engine/db_session/R2Client kept active per test
    (same patcher style as the ExportPage suite)."""

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

    def _list(self, page_id=PAGE_ID, user_id=USER_ID):
        ctx = _FakeContext()
        resp = self.svc.ListPageImages(
            archive_pb2.ListPageImagesRequest(page_id=page_id, user_id=user_id), ctx,
        )
        return ctx, resp


def _gallery_objects():
    """Images of every supported type (unsorted), non-images, an unsafe key,
    and the page-root thumbnail that sits OUTSIDE the assets/ prefix."""
    return {
        # Inserted deliberately unsorted to exercise the servicer's sort.
        f"{ASSETS_PREFIX}z_photo.webp": 2048,
        f"{ASSETS_PREFIX}a.png": 100,
        f"{ASSETS_PREFIX}m.jpg": 12345,
        f"{ASSETS_PREFIX}sub/dir.jpeg": 7,
        f"{ASSETS_PREFIX}favicon.ico": 42,
        f"{ASSETS_PREFIX}logo.svg": 11,
        f"{ASSETS_PREFIX}modern.avif": 555,
        f"{ASSETS_PREFIX}tiny.gif": 3,
        # Non-image assets must be excluded.
        f"{ASSETS_PREFIX}style.css": 999,
        f"{ASSETS_PREFIX}app.js": 888,
        f"{ASSETS_PREFIX}readme.txt": 777,
        # A flat-store key that is NOT a safe page-relative path.
        f"{ASSETS_PREFIX}../evil.jpg": 666,
        # Page-root objects live outside assets/: never listed.
        f"{USER_ID}/{PAGE_ID}/index.html": 10,
        f"{USER_ID}/{PAGE_ID}/meta.json": 10,
        f"{USER_ID}/{PAGE_ID}.webp": 9999,  # thumbnail
    }


class TestListPageImages(_ListPageImagesTestBase):
    def test_images_sorted_filtered_typed(self):
        self.set_db_page(_make_page(title="My Page — Image Gallery"))
        self.set_r2(_FakeR2(_gallery_objects()))

        ctx, resp = self._list()

        self.assertIsNone(ctx._code)
        self.assertEqual(
            [i.path for i in resp.images],
            [
                "assets/a.png",
                "assets/favicon.ico",
                "assets/logo.svg",
                "assets/m.jpg",
                "assets/modern.avif",
                "assets/sub/dir.jpeg",
                "assets/tiny.gif",
                "assets/z_photo.webp",
            ],
        )
        by_path = {i.path: i for i in resp.images}
        self.assertEqual(by_path["assets/m.jpg"].content_type, "image/jpeg")
        self.assertEqual(by_path["assets/m.jpg"].size_bytes, 12345)
        self.assertEqual(by_path["assets/modern.avif"].content_type, "image/avif")
        self.assertEqual(by_path["assets/a.png"].content_type, "image/png")
        self.assertEqual(by_path["assets/logo.svg"].content_type, "image/svg+xml")
        self.assertEqual(by_path["assets/favicon.ico"].content_type, "image/x-icon")
        # Listing never escaped the assets/ prefix; the thumbnail is not listed.
        self.assertEqual(self.svc.r2.list_prefixes, [ASSETS_PREFIX])

    def test_gallery_title_suffix_flags_gallery(self):
        self.set_db_page(_make_page(title="Deep Thoughts — Image Gallery"))
        self.set_r2(_FakeR2({f"{ASSETS_PREFIX}a.jpg": 1}))

        _ctx, resp = self._list()

        self.assertTrue(resp.is_image_gallery)
        self.assertEqual(len(resp.images), 1)

    def test_plain_gallery_title_flags_gallery(self):
        self.set_db_page(_make_page(title="Image Gallery"))
        self.set_r2(_FakeR2({}))

        _ctx, resp = self._list()

        self.assertTrue(resp.is_image_gallery)
        self.assertEqual(len(resp.images), 0)

    def test_regular_page_title_is_not_gallery(self):
        self.set_db_page(_make_page(title="My Page — Image Galleryish"))
        self.set_r2(_FakeR2({f"{ASSETS_PREFIX}a.jpg": 1}))

        _ctx, resp = self._list()

        self.assertFalse(resp.is_image_gallery)

    def test_empty_assets_prefix_is_valid(self):
        self.set_db_page(_make_page(title="Text Page"))
        self.set_r2(_FakeR2({}))

        ctx, resp = self._list()

        self.assertIsNone(ctx._code)
        self.assertEqual(len(resp.images), 0)
        self.assertFalse(resp.is_image_gallery)


class TestListPageImagesErrors(_ListPageImagesTestBase):
    def test_missing_page_not_found(self):
        self.set_db_page(None)
        self.set_r2(_FakeR2({}))

        ctx, resp = self._list()

        self.assertEqual(len(resp.images), 0)
        self.assertEqual(ctx._code, grpc.StatusCode.NOT_FOUND)
        self.assertEqual(ctx._details, "Page not found")

    def test_foreign_page_identical_not_found(self):
        """Ownership enforced: a foreign page is EXACTLY a missing page —
        no existence leak (same code, same details, no R2 access)."""
        self.set_db_page(_make_page(page_id=PAGE_ID, user_id="owner-u0"))
        r2 = _FakeR2(_gallery_objects())
        self.set_r2(r2)

        ctx, resp = self._list(user_id="attacker-u2")

        self.assertEqual(len(resp.images), 0)
        self.assertEqual(ctx._code, grpc.StatusCode.NOT_FOUND)
        self.assertEqual(ctx._details, "Page not found")
        self.set_db_page(None)
        ctx_missing, _ = self._list(user_id="attacker-u2")
        self.assertEqual(ctx._code, ctx_missing._code)
        self.assertEqual(ctx._details, ctx_missing._details)
        self.assertEqual(r2.list_prefixes, [])

    def test_empty_user_id_invalid_argument(self):
        self.set_db_page(_make_page())
        self.set_r2(_FakeR2(_gallery_objects()))

        ctx, resp = self._list(user_id="")

        self.assertEqual(len(resp.images), 0)
        self.assertEqual(ctx._code, grpc.StatusCode.INVALID_ARGUMENT)
        self.assertEqual(ctx._details, "user_id is required")

    def test_listing_failure_classified_unavailable(self):
        self.set_db_page(_make_page())
        self.set_r2(_FakeR2({}, list_error=Exception("SlowDown")))

        ctx, resp = self._list()

        self.assertEqual(len(resp.images), 0)
        self.assertEqual(ctx._code, grpc.StatusCode.UNAVAILABLE)

    def test_generic_listing_failure_classified_internal(self):
        self.set_db_page(_make_page())
        self.set_r2(_FakeR2({}, list_error=OSError("connection reset")))

        ctx, resp = self._list()

        self.assertEqual(len(resp.images), 0)
        self.assertEqual(ctx._code, grpc.StatusCode.INTERNAL)


if __name__ == "__main__":
    unittest.main()
