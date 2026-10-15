"""Search service IndexPage/RemovePage unit tests (pagepocket-search-service).

Covers the "Index Upsert on Ingest" requirement scenarios against a real
in-memory SQLite database — the same light approach the archive-service
servicer tests use (TestPerUserIdempotency): patch ``servicer.get_engine``
onto a per-test SQLite engine, let the servicer's own ``db_session`` run
against it.

  - "New page indexed": upsert inserts the row with the provided fields and
    truncates body_text to the MEDIUMTEXT limit (16 MB).
  - "Idempotent re-index": a second IndexPage for the same page_id overwrites
    title/url/body_text and keeps the original archived_at.
  - RemovePage deletes the row (owner-scoped).
"""

import os
import sys
import unittest
import uuid
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "shared"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "shared", "proto_generated"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import models  # -- registers page_index on Base before create_all
import servicer
from models import PageIndex


class _FakeRpcContext:
    def __init__(self):
        self.code = None
        self.details = None

    def set_code(self, code):
        self.code = code

    def set_details(self, details):
        self.details = details


class TestIndexPage(unittest.TestCase):
    def setUp(self):
        from sqlalchemy import create_engine as ce

        self.engine = ce("sqlite://")
        models.Base.metadata.create_all(self.engine)
        self.engine_patcher = patch("servicer.get_engine", return_value=self.engine)
        self.engine_patcher.start()
        self.svc = servicer.SearchServicer()
        self.user_id = str(uuid.uuid4())

    def tearDown(self):
        self.engine_patcher.stop()

    def _index(self, page_id=None, user_id=None, url=None, title="T",
               body_text="", tags=""):
        pid = page_id or str(uuid.uuid4())
        req = servicer.search_pb2.IndexPageRequest(
            page_id=pid,
            user_id=user_id or self.user_id,
            url=url or f"https://example.com/{pid}",
            title=title,
            body_text=body_text,
            tags=tags,
        )
        ctx = _FakeRpcContext()
        resp = self.svc.IndexPage(req, ctx)
        return resp, ctx, pid

    def _get_row(self, page_id):
        """Fetch the row's column values inside the session (commit expires
        instances, so ORM objects cannot be read after the session closes)."""
        from sqlalchemy import select

        with servicer.db_session(self.engine) as session:
            row = session.execute(
                select(PageIndex).where(PageIndex.page_id == page_id)
            ).scalar_one_or_none()
            if row is None:
                return None
            return {
                "page_id": row.page_id,
                "user_id": row.user_id,
                "url": row.url,
                "title": row.title,
                "body_text": row.body_text,
                "tags": row.tags,
                "archived_at": row.archived_at,
            }

    # -- Scenario: New page indexed ---------------------------------------

    def test_new_page_indexed_creates_row(self):
        resp, ctx, pid = self._index(
            title="Test Page",
            body_text="hello searchable world",
            tags="docs,guide",
        )
        self.assertIsNone(ctx.code)
        self.assertTrue(resp.success)

        row = self._get_row(pid)
        self.assertIsNotNone(row)
        self.assertEqual(row["page_id"], pid)
        self.assertEqual(row["user_id"], self.user_id)
        self.assertEqual(row["url"], f"https://example.com/{pid}")
        self.assertEqual(row["title"], "Test Page")
        self.assertEqual(row["body_text"], "hello searchable world")
        self.assertEqual(row["tags"], "docs,guide")
        self.assertIsNotNone(row["archived_at"])

    def test_body_text_truncated_to_mediumtext_limit(self):
        """Oversized body_text is cut to exactly 16 MB before storage."""
        self.assertEqual(servicer.MEDIUMTEXT_LIMIT, 16 * 1024 * 1024)

        marker = "MARKER|"
        body = marker + "x" * (servicer.MEDIUMTEXT_LIMIT + 50)
        _resp, ctx, pid = self._index(body_text=body)
        self.assertIsNone(ctx.code)

        row = self._get_row(pid)
        self.assertEqual(len(row["body_text"]), servicer.MEDIUMTEXT_LIMIT)
        self.assertTrue(row["body_text"].startswith(marker))

    # -- Scenario: Idempotent re-index ------------------------------------

    def test_re_index_updates_content_preserves_archived_at(self):
        _resp, _ctx, pid = self._index(
            title="Original Title",
            body_text="original body",
        )
        original = self._get_row(pid)
        self.assertIsNotNone(original["archived_at"])

        resp, ctx, _pid = self._index(
            page_id=pid,
            title="Updated Title",
            url="https://example.com/updated",
            body_text="updated body",
        )
        self.assertIsNone(ctx.code)
        self.assertTrue(resp.success)

        row = self._get_row(pid)
        self.assertEqual(row["title"], "Updated Title")
        self.assertEqual(row["url"], "https://example.com/updated")
        self.assertEqual(row["body_text"], "updated body")
        self.assertEqual(row["archived_at"], original["archived_at"])

    def test_re_index_keeps_tags_when_new_request_has_none(self):
        _resp, _ctx, pid = self._index(title="Tagged", tags="keep-me")
        _resp2, _ctx2, _pid2 = self._index(page_id=pid, title="Retagged")
        row = self._get_row(pid)
        self.assertIsNotNone(row)
        self.assertEqual(row["tags"], "keep-me")

    # -- RemovePage --------------------------------------------------------

    def test_remove_page_deletes_row(self):
        _resp, _ctx, pid = self._index(title="Doomed")
        self.assertIsNotNone(self._get_row(pid))

        req = servicer.search_pb2.RemovePageRequest(
            page_id=pid, user_id=self.user_id,
        )
        ctx = _FakeRpcContext()
        resp = self.svc.RemovePage(req, ctx)
        self.assertIsNone(ctx.code)
        self.assertTrue(resp.success)
        self.assertIsNone(self._get_row(pid))

    def test_remove_page_is_scoped_to_user(self):
        other_user = str(uuid.uuid4())
        _resp, _ctx, pid = self._index(title="Not theirs", user_id=self.user_id)

        req = servicer.search_pb2.RemovePageRequest(
            page_id=pid, user_id=other_user,
        )
        self.svc.RemovePage(req, _FakeRpcContext())
        # Another user's remove must not delete the owner's row.
        self.assertIsNotNone(self._get_row(pid))


if __name__ == "__main__":
    unittest.main()
