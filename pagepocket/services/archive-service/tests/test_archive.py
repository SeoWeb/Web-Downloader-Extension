"""Archive service unit tests - page processor, quota, servicer RPCs."""

import os
import sys
import unittest
from datetime import datetime, timezone, timedelta
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "shared"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "shared", "proto_generated"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Stub out boto3/botocore before servicer imports them
sys.modules["boto3"] = MagicMock()
sys.modules["botocore"] = MagicMock()
sys.modules["botocore.config"] = MagicMock()

from page_processor import sanitise_and_rewrite
import archive_pb2


# ---------------------------------------------------------------------------
# Page processor tests
# ---------------------------------------------------------------------------

class TestPageProcessor(unittest.TestCase):
    def test_rewrite_asset_refs(self):
        html = b'<html><img src="photo.jpg"><link href="style.css"></html>'
        asset_map = {"photo.jpg": "/r2/u1/p1/assets/photo.jpg", "style.css": "/r2/u1/p1/assets/style.css"}
        rewritten, preview, body = sanitise_and_rewrite(html, asset_map)
        self.assertIn(b"/r2/u1/p1/assets/photo.jpg", rewritten)
        self.assertIn(b"/r2/u1/p1/assets/style.css", rewritten)

    def test_preview_text_extraction(self):
        html = b"<html><body><p>Hello World</p></body></html>"
        _, preview, body = sanitise_and_rewrite(html, {})
        self.assertIn("Hello World", body)
        self.assertTrue(len(preview) <= 500)

    def test_empty_html(self):
        html = b""
        rewritten, preview, body = sanitise_and_rewrite(html, {})
        self.assertIsNotNone(rewritten)

    def test_no_matching_assets(self):
        html = b'<html><img src="other.png"></html>'
        asset_map = {"photo.jpg": "/r2/u1/p1/assets/photo.jpg"}
        rewritten, _, _ = sanitise_and_rewrite(html, asset_map)
        self.assertIn(b"other.png", rewritten)
        self.assertNotIn(b"/r2/u1/p1/assets/photo.jpg", rewritten)

    def test_rewrite_mixed_asset_refs(self):
        """HTML with img, link, script, source, video, audio referencing assets."""
        html = (
            b'<html><head>'
            b'<link href="styles.css">'
            b'<script src="app.js"></script>'
            b'</head><body>'
            b'<img src="photo.jpg">'
            b'<source src="video.mp4">'
            b'<video src="clip.webm"></video>'
            b'<audio src="sound.mp3"></audio>'
            b'<img data-src="lazy.png">'
            b'</body></html>'
        )
        asset_map = {
            "styles.css": "/r2/u1/p1/assets/styles.css",
            "app.js": "/r2/u1/p1/assets/app.js",
            "photo.jpg": "/r2/u1/p1/assets/photo.jpg",
            "video.mp4": "/r2/u1/p1/assets/video.mp4",
            "clip.webm": "/r2/u1/p1/assets/clip.webm",
            "sound.mp3": "/r2/u1/p1/assets/sound.mp3",
            "lazy.png": "/r2/u1/p1/assets/lazy.png",
        }
        rewritten, _, _ = sanitise_and_rewrite(html, asset_map)
        for orig, new in asset_map.items():
            self.assertIn(new.encode(), rewritten, f"{orig} should be rewritten to {new}")
        self.assertNotIn(b'src="photo.jpg"', rewritten)
        self.assertNotIn(b'href="styles.css"', rewritten)

    def test_asset_with_query_params(self):
        html = b'<html><img src="photo.jpg?v=1&w=200"></html>'
        asset_map = {"photo.jpg": "/r2/u1/p1/assets/photo.jpg"}
        rewritten, _, _ = sanitise_and_rewrite(html, asset_map)
        self.assertIn(b"/r2/u1/p1/assets/photo.jpg", rewritten)


# ---------------------------------------------------------------------------
# Helpers for quota and servicer tests
# ---------------------------------------------------------------------------

def _make_quota_dict(user_id="u1", pages=0, total_bytes=0, reset_at=None):
    """Return a plain dict-like mock that quota.check_and_reserve can use."""
    q = MagicMock()
    q.user_id = user_id
    q.pages_this_month = pages
    q.total_bytes = total_bytes
    q.quota_reset_at = reset_at or datetime.now(timezone.utc) + timedelta(days=30)
    return q


def _make_page(page_id="p1", user_id="u1", url="https://example.com",
               title="Test", preview_text="preview", r2_key="u1/p1/index.html",
               size_bytes=1000, extension_job_id="job1",
               archived_at=None):
    page = MagicMock()
    page.id = page_id
    page.user_id = user_id
    page.url = url
    page.title = title
    page.preview_text = preview_text
    page.r2_key = r2_key
    page.size_bytes = size_bytes
    page.extension_job_id = extension_job_id
    page.archived_at = archived_at or datetime.now(timezone.utc)
    return page


class _FakeContext:
    def __init__(self):
        self._code = None
        self._details = None

    def set_code(self, code):
        self._code = code

    def set_details(self, details):
        self._details = details


# ---------------------------------------------------------------------------
# Quota tests
# ---------------------------------------------------------------------------

class TestQuota(unittest.TestCase):
    def test_under_quota_returns_none(self):
        from quota import check_and_reserve
        mock_session = MagicMock()
        quota = _make_quota_dict(pages=10, total_bytes=100)
        mock_session.execute.return_value.scalar_one_or_none.return_value = quota
        result = check_and_reserve(mock_session, "u1", "free", 1000)
        self.assertIsNone(result)

    def test_page_limit_exceeded(self):
        from quota import check_and_reserve
        from models import PLAN_LIMITS
        mock_session = MagicMock()
        quota = _make_quota_dict(pages=PLAN_LIMITS["free"]["pages_per_month"])
        mock_session.execute.return_value.scalar_one_or_none.return_value = quota
        result = check_and_reserve(mock_session, "u1", "free", 1000)
        self.assertEqual(result, "Monthly page limit reached")

    def test_byte_limit_exceeded(self):
        from quota import check_and_reserve
        from models import PLAN_LIMITS
        mock_session = MagicMock()
        quota = _make_quota_dict(total_bytes=PLAN_LIMITS["free"]["max_bytes"])
        mock_session.execute.return_value.scalar_one_or_none.return_value = quota
        result = check_and_reserve(mock_session, "u1", "free", 1)
        self.assertEqual(result, "Storage limit reached")

    def test_pro_plan_higher_limits(self):
        from quota import check_and_reserve
        from models import PLAN_LIMITS
        mock_session = MagicMock()
        quota = _make_quota_dict(pages=PLAN_LIMITS["free"]["pages_per_month"])
        mock_session.execute.return_value.scalar_one_or_none.return_value = quota
        result = check_and_reserve(mock_session, "u1", "pro", 1000)
        self.assertIsNone(result)

    def test_monthly_rollover(self):
        from quota import check_and_reserve
        mock_session = MagicMock()
        quota = _make_quota_dict(
            pages=50,
            reset_at=datetime.now(timezone.utc) - timedelta(days=1),
        )
        mock_session.execute.return_value.scalar_one_or_none.return_value = quota
        result = check_and_reserve(mock_session, "u1", "free", 1000)
        self.assertIsNone(result)
        self.assertEqual(quota.pages_this_month, 0)

    def test_new_user_creates_quota(self):
        from quota import check_and_reserve
        mock_session = MagicMock()
        mock_session.execute.return_value.scalar_one_or_none.return_value = None
        result = check_and_reserve(mock_session, "new_user", "free", 1000)
        self.assertIsNone(result)
        mock_session.add.assert_called_once()


# ---------------------------------------------------------------------------
# Servicer tests
# ---------------------------------------------------------------------------

def _build_ingest_request(**overrides):
    defaults = dict(
        user_id="u1", url="https://example.com", title="Test",
        html_content=b"<html><body>Hello</body></html>",
        assets=[], extension_job_id="job1", plan="free",
    )
    defaults.update(overrides)
    return archive_pb2.IngestPageRequest(**defaults)


class TestIngestPage(unittest.TestCase):
    @patch("servicer._get_search_stub", return_value=None)
    @patch("servicer._get_r2_client")
    @patch("servicer.check_and_reserve", return_value=None)
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_ingest_success(self, mock_engine, mock_db_session, mock_quota,
                            mock_r2, mock_search):
        from servicer import ArchiveServicer
        mock_session = MagicMock()
        # First execute: idempotency check -> None (new page)
        # Second execute: quota increment -> quota_row
        quota_row = _make_quota_dict()
        call_count = [0]
        def fake_execute(stmt):
            call_count[0] += 1
            result = MagicMock()
            result.scalar_one_or_none.return_value = None if call_count[0] == 1 else quota_row
            return result
        mock_session.execute = fake_execute
        mock_db_session.return_value.__enter__ = lambda s: mock_session
        mock_db_session.return_value.__exit__ = lambda s, *a: None
        mock_r2.return_value.put_object = MagicMock()

        svc = ArchiveServicer()
        ctx = _FakeContext()
        req = _build_ingest_request(assets=[
            archive_pb2.Asset(filename="photo.jpg", content_type="image/jpeg", data=b"\xff\xd8\xff"),
        ])
        resp = svc.IngestPage(req, ctx)

        self.assertTrue(resp.success)
        self.assertTrue(resp.page_id)
        # 1 asset + index.html + meta.json = 3 uploads
        self.assertEqual(mock_r2.return_value.put_object.call_count, 3)

    @patch("servicer._get_search_stub", return_value=None)
    @patch("servicer._get_r2_client")
    @patch("servicer.check_and_reserve", return_value=None)
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_idempotent_replay(self, mock_engine, mock_db_session, mock_quota,
                               mock_r2, mock_search):
        """Second IngestPage with same extension_job_id returns existing page_id."""
        from servicer import ArchiveServicer
        existing_page = _make_page(page_id="existing-id")

        mock_session = MagicMock()
        mock_session.execute.return_value.scalar_one_or_none.return_value = existing_page
        mock_db_session.return_value.__enter__ = lambda s: mock_session
        mock_db_session.return_value.__exit__ = lambda s, *a: None

        svc = ArchiveServicer()
        ctx = _FakeContext()
        resp = svc.IngestPage(_build_ingest_request(extension_job_id="job1"), ctx)

        self.assertTrue(resp.success)
        self.assertEqual(resp.page_id, "existing-id")
        mock_r2.return_value.put_object.assert_not_called()

    @patch("servicer._get_search_stub", return_value=None)
    @patch("servicer._get_r2_client")
    @patch("servicer.check_and_reserve", return_value="Monthly page limit reached")
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_quota_exceeded_no_r2_write(self, mock_engine, mock_db_session,
                                         mock_quota, mock_r2, mock_search):
        """When quota is exceeded, no R2 upload happens."""
        from servicer import ArchiveServicer
        import grpc

        mock_session = MagicMock()
        mock_session.execute.return_value.scalar_one_or_none.return_value = None
        mock_db_session.return_value.__enter__ = lambda s: mock_session
        mock_db_session.return_value.__exit__ = lambda s, *a: None

        svc = ArchiveServicer()
        ctx = _FakeContext()
        resp = svc.IngestPage(_build_ingest_request(), ctx)

        self.assertFalse(resp.success)
        self.assertEqual(ctx._code, grpc.StatusCode.RESOURCE_EXHAUSTED)
        mock_r2.return_value.put_object.assert_not_called()


class TestCrossUserIsolation(unittest.TestCase):
    @patch("servicer._get_r2_client")
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_get_page_wrong_user(self, mock_engine, mock_db_session, mock_r2):
        from servicer import ArchiveServicer
        import grpc

        page = _make_page(page_id="p1", user_id="owner-u1")
        mock_session = MagicMock()
        mock_session.execute.return_value.scalar_one_or_none.return_value = page
        mock_db_session.return_value.__enter__ = lambda s: mock_session
        mock_db_session.return_value.__exit__ = lambda s, *a: None

        svc = ArchiveServicer()
        ctx = _FakeContext()
        req = archive_pb2.GetPageRequest(page_id="p1", user_id="attacker-u2")
        svc.GetPage(req, ctx)

        self.assertEqual(ctx._code, grpc.StatusCode.NOT_FOUND)

    @patch("servicer._get_r2_client")
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_get_page_content_wrong_user(self, mock_engine, mock_db_session, mock_r2):
        from servicer import ArchiveServicer
        import grpc

        page = _make_page(page_id="p1", user_id="owner-u1")
        mock_session = MagicMock()
        mock_session.execute.return_value.scalar_one_or_none.return_value = page
        mock_db_session.return_value.__enter__ = lambda s: mock_session
        mock_db_session.return_value.__exit__ = lambda s, *a: None

        svc = ArchiveServicer()
        ctx = _FakeContext()
        req = archive_pb2.GetPageContentRequest(page_id="p1", user_id="attacker-u2")
        svc.GetPageContent(req, ctx)

        self.assertEqual(ctx._code, grpc.StatusCode.NOT_FOUND)
        mock_r2.return_value.generate_presigned_url.assert_not_called()

    @patch("servicer._get_search_stub", return_value=None)
    @patch("servicer._get_r2_client")
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_delete_page_wrong_user(self, mock_engine, mock_db_session, mock_r2, mock_search):
        from servicer import ArchiveServicer

        page = _make_page(page_id="p1", user_id="owner-u1")
        mock_session = MagicMock()
        mock_session.execute.return_value.scalar_one_or_none.return_value = page
        mock_db_session.return_value.__enter__ = lambda s: mock_session
        mock_db_session.return_value.__exit__ = lambda s, *a: None

        svc = ArchiveServicer()
        ctx = _FakeContext()
        req = archive_pb2.DeletePageRequest(page_id="p1", user_id="attacker-u2")
        resp = svc.DeletePage(req, ctx)

        self.assertFalse(resp.success)
        self.assertEqual(resp.message, "not found")
        mock_r2.return_value.delete_objects.assert_not_called()


class TestDeletePage(unittest.TestCase):
    @patch("servicer._get_search_stub")
    @patch("servicer._get_r2_client")
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_delete_cleans_r2_and_quota(self, mock_engine, mock_db_session,
                                         mock_r2, mock_search):
        from servicer import ArchiveServicer

        page = _make_page(page_id="p1", user_id="u1", size_bytes=5000)
        quota_row = _make_quota_dict(user_id="u1", total_bytes=10000)

        mock_session = MagicMock()
        call_count = [0]

        def fake_execute(stmt):
            call_count[0] += 1
            result = MagicMock()
            if call_count[0] == 1:
                result.scalar_one_or_none.return_value = page
            else:
                result.scalar_one_or_none.return_value = quota_row
            return result

        mock_session.execute = fake_execute
        mock_session.delete = MagicMock()
        mock_db_session.return_value.__enter__ = lambda s: mock_session
        mock_db_session.return_value.__exit__ = lambda s, *a: None

        mock_r2_client = MagicMock()
        mock_paginator = MagicMock()
        mock_paginator.paginate.return_value = [
            {"Contents": [{"Key": "u1/p1/index.html"}, {"Key": "u1/p1/assets/photo.jpg"}]}
        ]
        mock_r2_client.get_paginator.return_value = mock_paginator
        mock_r2_client.get_paginator.call_args = None  # clear
        mock_r2.return_value = mock_r2_client

        mock_search_stub = MagicMock()
        mock_search.return_value = mock_search_stub

        svc = ArchiveServicer()
        ctx = _FakeContext()
        req = archive_pb2.DeletePageRequest(page_id="p1", user_id="u1")
        resp = svc.DeletePage(req, ctx)

        self.assertTrue(resp.success)

        # R2 prefix deleted
        mock_r2_client.delete_objects.assert_called_once()
        deleted = mock_r2_client.delete_objects.call_args[1]["Delete"]["Objects"]
        self.assertEqual(len(deleted), 2)

        # Thumbnail deleted
        mock_r2_client.delete_object.assert_called_once_with(
            Bucket="pagepocket-pages",
            Key="u1/p1.webp",
        )

        # Page row deleted
        mock_session.delete.assert_called_once_with(page)

        # Quota decremented
        self.assertEqual(quota_row.total_bytes, 5000)

        # Search removal called
        mock_search_stub.RemovePage.assert_called_once()


if __name__ == "__main__":
    unittest.main()
