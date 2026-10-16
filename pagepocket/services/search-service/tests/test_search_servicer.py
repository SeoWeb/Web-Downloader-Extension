"""Search service IndexPage/RemovePage/Search unit tests (pagepocket-search-service).

Covers the "Index Upsert on Ingest" and "Schema Isolation" requirements
against a real in-memory SQLite database — the same light approach the
archive-service servicer tests use: patch this suite's aliased servicer
module onto a per-test SQLite engine and let its own ``db_session`` run
against it.

Scenarios:
  - "New page indexed": single-statement atomic upsert inserts the row.
  - "Concurrent duplicate IndexPage calls": two IndexPage calls for the same
    page_id both succeed through the upsert — no IntegrityError, one row.
  - "CJK body near the size limit": byte-safe truncation (never char count).
  - "Idempotent re-index": overwrite title/url/body_text, keep archived_at.
  - "Collection filter via library RPC": ids come from the library stub with
    the caller's user_id; library outage → UNAVAILABLE (never a silent
    unfiltered search); empty collection → authoritative empty result.
  - "No embedded foreign-schema SQL": no schema-qualified foreign-schema
    reference anywhere in the search-service source (2.8 / 6.2 gate).
"""

import importlib.util
import os
import sys
import unittest
import unittest.mock
import uuid

_shared = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "shared"))

# Per-service module names (models/servicer) exist in every service. Import
# this suite's copies ONCE under an alias; tests/conftest.py re-points the
# shared sys.modules names per test for combined multi-suite runs. The
# (db, models) pair is established together — reloading db while another
# suite's aliased models stays on the old Base would leave create_all
# building empty metadata.
_PP_ALIAS = "_ppsvc_search-service_"
if _PP_ALIAS + "models" not in sys.modules:
    _spec = importlib.util.spec_from_file_location("db", os.path.join(_shared, "db.py"))
    _mod = importlib.util.module_from_spec(_spec)
    sys.modules["db"] = _mod
    _spec.loader.exec_module(_mod)

    for _name in ("models", "servicer"):
        sys.modules.pop(_name, None)

sys.path.insert(0, _shared)
sys.path.insert(0, os.path.join(_shared, "proto_generated"))
sys.path.insert(0, os.path.normpath(os.path.join(os.path.dirname(__file__), "..")))

import common_pb2
import grpc
import library_pb2
import search_pb2
import servicer as _servicer_mod
from db import Base, db_session
from models import PageIndex

sys.modules[_PP_ALIAS + "models"] = sys.modules["models"]
sys.modules[_PP_ALIAS + "servicer"] = sys.modules["servicer"]


class _FakeRpcContext:
    def __init__(self):
        self.code = None
        self.details = None

    def set_code(self, code):
        self.code = code

    def set_details(self, details):
        self.details = details


class _FakeRpcError(grpc.RpcError):
    def __init__(self, code):
        self._code = code

    def code(self):
        return self._code


def _init_db():
    from sqlalchemy import create_engine

    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    return engine


class TestIndexPage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = _init_db()
        cls._engine_patcher = unittest.mock.patch.object(
            _servicer_mod, "get_engine", return_value=cls.engine
        )
        cls._engine_patcher.start()

    @classmethod
    def tearDownClass(cls):
        cls._engine_patcher.stop()

    def setUp(self):
        with db_session(self.engine) as session:
            session.query(PageIndex).delete()
        self.svc = _servicer_mod.SearchServicer()
        self.user_id = str(uuid.uuid4())

    def _index(self, page_id=None, user_id=None, url=None, title="T",
               body_text="", tags=""):
        pid = page_id or str(uuid.uuid4())
        req = search_pb2.IndexPageRequest(
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

        with db_session(self.engine) as session:
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

    def _row_count(self, page_id=None):
        from sqlalchemy import func, select

        with db_session(self.engine) as session:
            query = select(func.count()).select_from(PageIndex)
            if page_id:
                query = query.where(PageIndex.page_id == page_id)
            return session.execute(query).scalar()

    # -- Scenario: New page indexed ---------------------------------------

    def test_new_page_indexed_creates_row(self):
        resp, ctx, pid = self._index(
            title="Test Page",
            body_text="hello searchable world",
            tags="docs,guide",
        )
        self.assertIsNone(ctx.code)
        self.assertTrue(resp.success)
        self.assertIsInstance(resp, common_pb2.StatusResponse)

        row = self._get_row(pid)
        self.assertIsNotNone(row)
        self.assertEqual(row["page_id"], pid)
        self.assertEqual(row["user_id"], self.user_id)
        self.assertEqual(row["url"], f"https://example.com/{pid}")
        self.assertEqual(row["title"], "Test Page")
        self.assertEqual(row["body_text"], "hello searchable world")
        self.assertEqual(row["tags"], "docs,guide")
        self.assertIsNotNone(row["archived_at"])

    def test_upsert_compiles_to_single_atomic_statement(self):
        """2.7: MySQL path compiles to INSERT … ON DUPLICATE KEY UPDATE and
        the SQLite test path to INSERT … ON CONFLICT DO UPDATE — one
        statement each, no read-before-write."""
        from sqlalchemy.dialects import mysql, sqlite

        values = {"page_id": "p", "user_id": "u", "url": "u", "title": "t",
                  "body_text": "b"}
        update_values = {"url": "u", "title": "t", "body_text": "b",
                         "user_id": "u"}

        mysql_stmt = _servicer_mod.mysql_insert(PageIndex).values(**values)
        mysql_sql = str(
            mysql_stmt.on_duplicate_key_update(**update_values).compile(
                dialect=mysql.dialect()
            )
        ).upper()
        self.assertIn("INSERT INTO", mysql_sql)
        self.assertIn("ON DUPLICATE KEY UPDATE", mysql_sql)

        sqlite_stmt = _servicer_mod.sqlite_insert(PageIndex).values(**values)
        sqlite_sql = str(
            sqlite_stmt.on_conflict_do_update(
                index_elements=[PageIndex.page_id], set_=update_values
            ).compile(dialect=sqlite.dialect())
        ).upper()
        self.assertIn("ON CONFLICT", sqlite_sql)
        self.assertIn("DO UPDATE", sqlite_sql)

    def test_double_index_page_both_succeed_single_row(self):
        """Scenario: concurrent duplicate IndexPage calls — serialized onto
        SQLite here, both calls succeed through the atomic upsert (one
        insert, one duplicate-key update) and exactly one row results."""
        pid = str(uuid.uuid4())
        resp1, ctx1, _ = self._index(page_id=pid, title="First", body_text="first body")
        resp2, ctx2, _ = self._index(page_id=pid, title="Second", body_text="second body")

        self.assertIsNone(ctx1.code)
        self.assertIsNone(ctx2.code)
        self.assertTrue(resp1.success)
        self.assertTrue(resp2.success)

        from sqlalchemy import select

        with db_session(self.engine) as session:
            rows = session.execute(
                select(PageIndex).where(PageIndex.page_id == pid)
            ).scalars().all()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0].title, "Second")
            self.assertEqual(rows[0].body_text, "second body")

    def test_index_page_invalidates_search_cache_pattern(self):
        with unittest.mock.patch.object(_servicer_mod, "cache_invalidate_pattern") as inv:
            self._index(title="Cache bust")
        inv.assert_called_once_with(_servicer_mod.pattern_search(self.user_id))

    # -- Scenario: CJK body near the size limit ----------------------------

    def test_body_text_truncated_to_byte_limit(self):
        """Oversized ASCII body is cut to the byte-safe limit (16 MiB minus
        the 4 KiB safety margin)."""
        limit = _servicer_mod.MEDIUMTEXT_LIMIT - _servicer_mod.TRUNCATE_SAFETY_MARGIN
        marker = "MARKER|"
        body = marker + "x" * (limit + 50)
        _resp, ctx, pid = self._index(body_text=body)
        self.assertIsNone(ctx.code)

        row = self._get_row(pid)
        self.assertEqual(len(row["body_text"].encode("utf-8")), limit)
        self.assertTrue(row["body_text"].startswith(marker))

    def test_cjk_body_truncated_bytesafe_valid_utf8(self):
        """Multi-byte CJK bodies are truncated on UTF-8 bytes: the stored
        value fits the byte limit, remains valid UTF-8 (no U+FFFD, no raise),
        and never trips MySQL's 'Data too long' — the char-count slice would
        have left an encoding far past the byte limit."""
        limit = _servicer_mod.MEDIUMTEXT_LIMIT - _servicer_mod.TRUNCATE_SAFETY_MARGIN
        body = "漢" * (limit // 3 + 1000)  # 3 bytes/char
        self.assertGreater(len(body.encode("utf-8")), limit)
        self.assertLess(len(body), limit)  # char count itself is below the limit

        _resp, ctx, pid = self._index(body_text=body)
        self.assertIsNone(ctx.code)

        row = self._get_row(pid)
        encoded = row["body_text"].encode("utf-8")
        self.assertLessEqual(len(encoded), limit)
        decoded = encoded.decode("utf-8", "strict")  # raises if not valid UTF-8
        self.assertNotIn("\ufffd", decoded)

    def test_cjk_body_within_limit_stored_intact(self):
        body = "検索インデックス" * 10
        _resp, ctx, pid = self._index(body_text=body)
        self.assertIsNone(ctx.code)
        self.assertEqual(self._get_row(pid)["body_text"], body)

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

        req = search_pb2.RemovePageRequest(
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

        req = search_pb2.RemovePageRequest(
            page_id=pid, user_id=other_user,
        )
        self.svc.RemovePage(req, _FakeRpcContext())
        # Another user's remove must not delete the owner's row.
        self.assertIsNotNone(self._get_row(pid))


class TestCollectionFilter(unittest.TestCase):
    """Scenario: Collection filter via library RPC (2.8 / D8 / D12).

    The full Search SQL runs on SQLite with MATCH(...) swapped for a constant
    score (FULLTEXT is MySQL-only; the WHERE assembly under test is shared).
    """

    @classmethod
    def setUpClass(cls):
        cls.engine = _init_db()
        cls._engine_patcher = unittest.mock.patch.object(
            _servicer_mod, "get_engine", return_value=cls.engine
        )
        cls._engine_patcher.start()
        # FULLTEXT scoring is MySQL-only; the collection-filter behavior
        # under test lives in the WHERE assembly, shared by both dialects.
        cls._fts_patcher = unittest.mock.patch.object(
            _servicer_mod, "MATCH_FTS", "1.0"
        )
        cls._fts_patcher.start()

    @classmethod
    def tearDownClass(cls):
        cls._fts_patcher.stop()
        cls._engine_patcher.stop()

    def setUp(self):
        with db_session(self.engine) as session:
            session.query(PageIndex).delete()
        self.svc = _servicer_mod.SearchServicer()
        self.user_id = "user-a-001"

    def _index(self, page_id, title="T", body_text="body"):
        with db_session(self.engine) as session:
            session.add(PageIndex(
                page_id=page_id, user_id=self.user_id,
                url=f"https://example.com/{page_id}",
                title=title, body_text=body_text,
            ))

    def _search(self, collection_id="coll-1", stub=None):
        if stub is None:
            stub = unittest.mock.MagicMock()
            stub.ListCollectionPageIds.return_value = (
                library_pb2.ListCollectionPageIdsResponse(
                    page_ids=["page-1"])
            )
        p = unittest.mock.patch.object(_servicer_mod, "_get_library_stub", return_value=stub)
        p.start()
        self.addCleanup(p.stop)

        ctx = _FakeRpcContext()
        resp = self.svc.Search(search_pb2.SearchRequest(
            user_id=self.user_id, query="body",
            page=1, page_size=20, collection_id=collection_id,
        ), ctx)
        return resp, ctx, stub

    def test_filter_uses_library_rpc_with_user_scoping(self):
        self._index("page-1")
        self._index("page-2")

        resp, _ctx, stub = self._search(collection_id="coll-1")

        rpc_req = stub.ListCollectionPageIds.call_args[0][0]
        self.assertEqual(rpc_req.collection_id, "coll-1")
        self.assertEqual(rpc_req.user_id, self.user_id)  # caller scoping (D12)

        page_ids = {r.page_id for r in resp.results}
        self.assertEqual(page_ids, {"page-1"})
        self.assertEqual(resp.total, 1)

    def test_results_never_include_other_users(self):
        # A page owned by someone else that happens to sit in the collection
        # id list can never surface: the SQL filters user_id = caller.
        other = str(uuid.uuid4())
        with db_session(self.engine) as session:
            session.add(PageIndex(
                page_id="page-foreign", user_id=other,
                url="https://example.com/foreign", title="T", body_text="body",
            ))
        self._index("page-1")

        resp, _ctx, _stub = self._search(collection_id="coll-1")
        page_ids = {r.page_id for r in resp.results}
        self.assertNotIn("page-foreign", page_ids)
        self.assertEqual(page_ids, {"page-1"})

    def test_empty_collection_returns_empty_result(self):
        """Empty id list from an OWNED rpc call → empty result (correct,
        cacheable — not a library outage)."""
        self._index("page-1")

        stub = unittest.mock.MagicMock()
        stub.ListCollectionPageIds.return_value = (
            library_pb2.ListCollectionPageIdsResponse(page_ids=[])
        )
        with unittest.mock.patch.object(_servicer_mod, "cache_set") as cache_set:
            resp, ctx, _ = self._search(collection_id="coll-empty", stub=stub)
        self.assertIsNone(ctx.code)
        self.assertEqual(resp.total, 0)
        self.assertEqual(list(resp.results), [])
        cache_set.assert_called_once()  # empty result is cached

    def test_library_not_found_yields_empty_result(self):
        """NOT_FOUND from the user-scoped RPC = collection invisible to this
        caller — authoritative empty set, no existence leak."""
        stub = unittest.mock.MagicMock()
        stub.ListCollectionPageIds.side_effect = _FakeRpcError(
            grpc.StatusCode.NOT_FOUND
        )
        self._index("page-1")
        resp, ctx, _ = self._search(collection_id="someone-elses", stub=stub)
        self.assertIsNone(ctx.code)
        self.assertEqual(resp.total, 0)

    def test_library_outage_fails_unavailable_never_unfiltered(self):
        """D8: a library failure must NOT degrade into an unfiltered search
        (and must not be cached as an empty result)."""
        stub = unittest.mock.MagicMock()
        stub.ListCollectionPageIds.side_effect = _FakeRpcError(
            grpc.StatusCode.INTERNAL
        )
        self._index("page-1")
        with unittest.mock.patch.object(_servicer_mod, "cache_set") as cache_set:
            resp, ctx, _ = self._search(collection_id="coll-1", stub=stub)
        self.assertEqual(ctx.code, grpc.StatusCode.UNAVAILABLE)
        self.assertEqual(resp.total, 0)
        cache_set.assert_not_called()

    def test_missing_library_config_fails_unavailable(self):
        """No library address configured → the filter cannot be resolved:
        fail closed rather than search without the filter."""
        p = unittest.mock.patch.object(_servicer_mod, "_get_library_stub", return_value=None)
        p.start()
        self.addCleanup(p.stop)

        ctx = _FakeRpcContext()
        resp = self.svc.Search(search_pb2.SearchRequest(
            user_id=self.user_id, query="body", page=1, page_size=20,
            collection_id="coll-1",
        ), ctx)
        self.assertEqual(ctx.code, grpc.StatusCode.UNAVAILABLE)
        self.assertEqual(resp.total, 0)

    def test_rpc_gets_explicit_deadline(self):
        """D7: the library call carries a 30 s-class timeout."""
        stub = unittest.mock.MagicMock()
        stub.ListCollectionPageIds.return_value = (
            library_pb2.ListCollectionPageIdsResponse(page_ids=[])
        )
        _resp, _ctx, _ = self._search(collection_id="coll-1", stub=stub)
        _args, kwargs = stub.ListCollectionPageIds.call_args
        self.assertEqual(kwargs.get("timeout"), 30)


class TestSchemaIsolation(unittest.TestCase):
    """Scenario: No embedded foreign-schema SQL (2.8 / 6.2 grep gate)."""

    def test_no_cross_schema_sql_in_search_service(self):
        # The literal is assembled so this test file itself never contains
        # the forbidden schema-qualified string (6.2 greps the whole tree).
        forbidden = "library" + "_db"
        service_dir = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
        offenders = []
        for root, _dirs, files in os.walk(service_dir):
            if any(part in ("__pycache__", ".pytest_cache") for part in root.split(os.sep)):
                continue
            for name in files:
                if not name.endswith(".py"):
                    continue
                path = os.path.join(root, name)
                with open(path, encoding="utf-8") as fh:
                    if forbidden in fh.read():
                        offenders.append(path)
        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
