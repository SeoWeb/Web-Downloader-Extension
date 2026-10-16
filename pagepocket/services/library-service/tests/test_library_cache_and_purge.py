"""Library service cache-scoping and page-link purge tests (2.12 / 2.3).

Covers the "User-Scoped Collection-Id Cache" and "Page-Link Purge Contract"
requirements:

  - "Cache key includes the user": ListCollectionPageIds entries live under
    (user_id, collection_id) keys — never shared across users.
  - "Cross-user collection access rejected before cache": ownership is
    enforced on the cache path too; a poisoned or foreign cache entry is
    never served to a non-owner.
  - "Purge removes all membership rows" / "Purge is idempotent" /
    "Collection counts stay consistent after page deletion": PurgePageLinks
    deletes every membership row for a page and invalidates the affected
    collection caches.

Redis interactions run against fakeredis, mirroring the real client options
(decode_responses=True).
"""

import importlib.util
import os
import sys
import unittest
import unittest.mock

import fakeredis

_shared = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "shared"))

# Per-service module names (models/servicer) exist in every service. This
# suite aliases its copies under a unique prefix; tests/conftest.py re-points
# the shared sys.modules names per test for combined multi-suite runs. The
# (db, models) pair is established together — reloading db while another
# suite's aliased models stays on the old Base would leave create_all
# building empty metadata.
_PP_ALIAS = "_ppsvc_library-service_"
if _PP_ALIAS + "models" not in sys.modules:
    _spec = importlib.util.spec_from_file_location("db", os.path.join(_shared, "db.py"))
    _mod = importlib.util.module_from_spec(_spec)
    sys.modules["db"] = _mod
    _spec.loader.exec_module(_mod)

    sys.path.insert(0, _shared)
    sys.path.insert(0, os.path.join(_shared, "proto_generated"))
    sys.path.insert(0, os.path.normpath(os.path.join(os.path.dirname(__file__), "..")))

    for _name in ("models", "servicer"):
        sys.modules.pop(_name, None)
else:
    sys.path.insert(0, _shared)
    sys.path.insert(0, os.path.join(_shared, "proto_generated"))
    sys.path.insert(0, os.path.normpath(os.path.join(os.path.dirname(__file__), "..")))

import grpc
import library_pb2
import servicer as _servicer_mod
from cache_config import key_collection, key_collection_page_ids
from db import Base, db_session
from models import Collection, PageCollection

sys.modules[_PP_ALIAS + "models"] = sys.modules["models"]
sys.modules[_PP_ALIAS + "servicer"] = sys.modules["servicer"]

import cache as _cache_mod

USER_A = "user-a-001"
USER_B = "user-b-002"


class _FakeRpcContext:
    def __init__(self):
        self.code = None
        self.details = None

    def set_code(self, code):
        self.code = code

    def set_details(self, details):
        self.details = details


def _init_db():
    from sqlalchemy import create_engine, event

    engine = create_engine("sqlite://")

    @event.listens_for(engine, "connect")
    def _set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(engine)
    return engine


class _FakeredisCase(unittest.TestCase):
    """Base: servicer on SQLite + cache client on fakeredis."""

    @classmethod
    def setUpClass(cls):
        cls.engine = _init_db()
        cls._engine_patcher = unittest.mock.patch.object(
            _servicer_mod, "get_engine", return_value=cls.engine
        )
        cls._engine_patcher.start()

        orig_db_session = _servicer_mod.db_session

        def _bound_session(engine_arg=None):
            return orig_db_session(engine_arg or cls.engine)

        cls._session_patcher = unittest.mock.patch.object(
            _servicer_mod, "db_session", _bound_session
        )
        cls._session_patcher.start()

    @classmethod
    def tearDownClass(cls):
        cls._session_patcher.stop()
        cls._engine_patcher.stop()

    def setUp(self):
        server = fakeredis.FakeServer()
        self.redis = fakeredis.FakeStrictRedis(
            server=server, decode_responses=True
        )
        p = unittest.mock.patch.object(_cache_mod, "_get_client", return_value=self.redis)
        p.start()
        self.addCleanup(p.stop)

        with db_session(self.engine) as s:
            s.query(PageCollection).delete()
            s.query(Collection).delete()
        self.svc = _servicer_mod.LibraryServicer()

    # -- helpers --

    def _create(self, user_id=USER_A, name="Coll"):
        ctx = _FakeRpcContext()
        return self.svc.CreateCollection(
            library_pb2.CreateCollectionRequest(user_id=user_id, name=name), ctx
        ), ctx

    def _add_page(self, page_id, collection_id, user_id=USER_A):
        ctx = _FakeRpcContext()
        return self.svc.AddPageToCollection(library_pb2.PageCollectionRequest(
            user_id=user_id, page_id=page_id, collection_id=collection_id,
        ), ctx), ctx

    def _page_ids(self, collection_id, user_id=USER_A):
        ctx = _FakeRpcContext()
        resp = self.svc.ListCollectionPageIds(
            library_pb2.ListCollectionPageIdsRequest(
                collection_id=collection_id, user_id=user_id,
            ), ctx
        )
        return resp, ctx


class TestCollectionIdCacheScoping(_FakeredisCase):
    def test_cache_key_scoped_by_user_and_collection(self):
        """Scenario: Cache key includes the user — two users requesting the
        same collection_id get distinct cache entries."""
        coll, _ = self._create(USER_A)
        self._add_page("page-1", coll.id)

        resp, ctx = self._page_ids(coll.id, USER_A)
        self.assertIsNone(ctx.code)
        self.assertEqual(list(resp.page_ids), ["page-1"])
        self.assertTrue(self.redis.exists(key_collection_page_ids(USER_A, coll.id)))

        # User B never gets an entry for A's collection — and never gets a
        # shared one.
        _resp, ctx_b = self._page_ids(coll.id, USER_B)
        self.assertEqual(ctx_b.code, grpc.StatusCode.NOT_FOUND)
        self.assertFalse(self.redis.exists(key_collection_page_ids(USER_B, coll.id)))

    def test_ownership_enforced_on_cache_path(self):
        """Scenario: Cross-user collection access rejected before cache — a
        cache entry belonging to another user is never served, and a poisoned
        entry under the caller's own key cannot bypass the ownership check."""
        coll, _ = self._create(USER_A)
        self._add_page("page-1", coll.id)

        # Prime A's entry.
        resp, _ = self._page_ids(coll.id, USER_A)
        self.assertEqual(list(resp.page_ids), ["page-1"])

        # Poison B's key as if a leaked entry existed.
        self.redis.set(
            key_collection_page_ids(USER_B, coll.id), '["stolen-id"]'
        )

        _resp, ctx_b = self._page_ids(coll.id, USER_B)
        self.assertEqual(ctx_b.code, grpc.StatusCode.NOT_FOUND)

    def test_cache_hit_serves_owner_after_db_rows_removed(self):
        """A cache hit serves the owner's scoped entry without re-querying
        membership — proof the entry is per-user usable."""
        coll, _ = self._create(USER_A)
        self._add_page("page-1", coll.id)
        resp, _ = self._page_ids(coll.id, USER_A)
        self.assertEqual(list(resp.page_ids), ["page-1"])

        # Remove the membership row behind the service's back; the owner's
        # next call is served from their scoped cache entry.
        with db_session(self.engine) as s:
            s.query(PageCollection).delete()

        resp2, ctx2 = self._page_ids(coll.id, USER_A)
        self.assertIsNone(ctx2.code)
        self.assertEqual(list(resp2.page_ids), ["page-1"])

    def test_membership_change_invalidates_scoped_key(self):
        coll, _ = self._create(USER_A)
        self._add_page("page-1", coll.id)
        resp, _ = self._page_ids(coll.id, USER_A)
        self.assertEqual(list(resp.page_ids), ["page-1"])

        self._add_page("page-2", coll.id)
        resp2, _ = self._page_ids(coll.id, USER_A)
        self.assertEqual(sorted(resp2.page_ids), ["page-1", "page-2"])


class TestPurgePageLinks(_FakeredisCase):
    def test_purge_removes_all_membership_rows(self):
        """Scenario: Purge removes all membership rows — a page in three
        collections loses all three rows, success=true."""
        c1, _ = self._create(USER_A, "One")
        c2, _ = self._create(USER_A, "Two")
        c3, _ = self._create(USER_B, "Three")
        for coll in (c1, c2, c3):
            self._add_page("doomed-page", coll.id, user_id=coll.user_id)

        ctx = _FakeRpcContext()
        resp = self.svc.PurgePageLinks(
            library_pb2.PurgePageLinksRequest(page_id="doomed-page"), ctx
        )
        self.assertIsNone(ctx.code)
        self.assertTrue(resp.success)

        with db_session(self.engine) as s:
            self.assertEqual(
                s.query(PageCollection)
                .filter(PageCollection.page_id == "doomed-page")
                .count(),
                0,
            )

    def test_purge_is_idempotent(self):
        """Scenario: Purge is idempotent — a page with no membership rows
        still returns success with no error."""
        ctx = _FakeRpcContext()
        resp = self.svc.PurgePageLinks(
            library_pb2.PurgePageLinksRequest(page_id="never-existed"), ctx
        )
        self.assertIsNone(ctx.code)
        self.assertTrue(resp.success)

    def test_page_count_matches_rows_after_purge(self):
        """Scenario: Collection counts stay consistent after page deletion —
        page_count equals the remaining membership rows (no drift)."""
        coll, _ = self._create(USER_A)
        self._add_page("page-1", coll.id)
        self._add_page("page-2", coll.id)

        self.svc.PurgePageLinks(
            library_pb2.PurgePageLinksRequest(page_id="page-1"), _FakeRpcContext()
        )

        ctx = _FakeRpcContext()
        get_resp = self.svc.GetCollection(
            library_pb2.GetCollectionRequest(
                collection_id=coll.id, user_id=USER_A), ctx
        )
        self.assertIsNone(ctx.code)
        self.assertEqual(get_resp.page_count, 1)

    def test_purge_invalidates_affected_collection_caches(self):
        """A purge must not leave stale membership/metadata cache entries for
        the collections the page belonged to."""
        coll, _ = self._create(USER_A)
        self._add_page("page-1", coll.id)
        self._add_page("page-2", coll.id)

        # Prime both caches.
        resp, _ = self._page_ids(coll.id, USER_A)
        self.assertEqual(list(resp.page_ids), ["page-1", "page-2"])

        self.svc.PurgePageLinks(
            library_pb2.PurgePageLinksRequest(page_id="page-1"), _FakeRpcContext()
        )

        # The scoped page-id cache entry was deleted — the next call re-reads
        # membership and caches the fresh list.
        self.assertFalse(self.redis.exists(key_collection_page_ids(USER_A, coll.id)))
        resp2, _ = self._page_ids(coll.id, USER_A)
        self.assertEqual(list(resp2.page_ids), ["page-2"])

        # Collection metadata cache (page_count) was deleted too.
        self.assertFalse(self.redis.exists(key_collection(coll.id)))

    def test_purge_accepts_empty_page_id(self):
        """A malformed (empty) request is idempotent success — the caller is
        best-effort and must never break page deletion."""
        resp = self.svc.PurgePageLinks(
            library_pb2.PurgePageLinksRequest(page_id=""), _FakeRpcContext()
        )
        self.assertTrue(resp.success)


if __name__ == "__main__":
    unittest.main()
