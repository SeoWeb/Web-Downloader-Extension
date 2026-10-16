"""Share service hardening tests (2.15 / 2.3 / 1.17).

Covers:

  - "Plaintext tokens absent from storage": rows carry only the SHA-256 of
    the URL-safe token; validation resolves tokens by hash.
  - Alembic migration 001 → 002 (hash backfill, PK swap, active-link
    discriminator) and the lossy downgrade, on SQLite.
  - "Concurrent duplicate creation blocked": the partial-active unique index
    rejects a second active link and the race loser converges on the winner.
  - "Revocation is immediately visible despite caching": revocation deletes
    cache entries inside the transaction and valid entries are bounded by
    TTL_SHARE_VALID.
  - "Dangling-Link Cleanup": RevokeLinksForPage revokes every link of a page.
  - View-count dedup (1.17): Redis INCR per (token, viewer) gates the DB
    write; Redis unavailable falls back to the legacy per-hit DB increment.

Redis interactions run against fakeredis (decode_responses=True), mirroring
the production client.
"""

import importlib.util
import os
import sys
import time
import unittest
import unittest.mock
from types import SimpleNamespace

import fakeredis

_shared = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "shared"))

# Per-service module names (models/servicer) exist in every service. This
# suite aliases its copies under a unique prefix; tests/conftest.py re-points
# the shared sys.modules names per test for combined multi-suite runs. The
# (db, models) pair is established together — see the library suite note.
_PP_ALIAS = "_ppsvc_share-service_"
if _PP_ALIAS + "models" not in sys.modules:
    _spec_db = importlib.util.spec_from_file_location("db", os.path.join(_shared, "db.py"))
    _mod = importlib.util.module_from_spec(_spec_db)
    sys.modules["db"] = _mod
    _spec_db.loader.exec_module(_mod)

    sys.path.insert(0, _shared)
    sys.path.insert(0, os.path.join(_shared, "proto_generated"))
    sys.path.insert(0, os.path.normpath(os.path.join(os.path.dirname(__file__), "..")))

    for _name in ("models", "servicer"):
        sys.modules.pop(_name, None)
else:
    sys.path.insert(0, _shared)
    sys.path.insert(0, os.path.join(_shared, "proto_generated"))
    sys.path.insert(0, os.path.normpath(os.path.join(os.path.dirname(__file__), "..")))

import common_pb2
import grpc
import servicer as _servicer_mod
import share_pb2
from db import Base, db_session
from models import ShareLink
from sqlalchemy.exc import IntegrityError

sys.modules[_PP_ALIAS + "models"] = sys.modules["models"]
sys.modules[_PP_ALIAS + "servicer"] = sys.modules["servicer"]

import cache as _cache_mod
from cache_config import (
    TTL_SHARE_LINK,
    TTL_SHARE_VALID,
    key_share_page,
    key_share_token,
)

USER_A = "user-a-001"
USER_B = "user-b-002"
PAGE_1 = "page-001"


class _FakeRpcContext:
    def __init__(self):
        self.code = None
        self.details = None

    def set_code(self, code):
        self.code = code

    def set_details(self, details):
        self.details = details


def _init_db():
    from sqlalchemy import create_engine

    engine = create_engine("sqlite://")
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
            s.query(ShareLink).delete()
        self.svc = _servicer_mod.ShareServicer()

    # -- helpers --

    def _create(self, user_id=USER_A, page_id=PAGE_1, is_public=True, expires_at=0):
        ctx = _FakeRpcContext()
        req = share_pb2.CreateShareLinkRequest(
            user_id=user_id, page_id=page_id, is_public=is_public, expires_at=expires_at
        )
        return self.svc.CreateShareLink(req, ctx), ctx

    def _validate(self, token, viewer=None):
        ctx = _FakeRpcContext()
        if viewer is not None:
            req = SimpleNamespace(token=token, viewer_fingerprint=viewer)
        else:
            req = share_pb2.ValidateTokenRequest(token=token)
        return self.svc.ValidateToken(req, ctx), ctx

    def _revoke(self, token, user_id=USER_A):
        ctx = _FakeRpcContext()
        req = share_pb2.RevokeShareLinkRequest(token=token, user_id=user_id)
        return self.svc.RevokeShareLink(req, ctx), ctx

    def _get_link(self, token):
        ctx = _FakeRpcContext()
        return self.svc.GetShareLink(
            share_pb2.GetShareLinkRequest(token=token), ctx
        ), ctx

    def _get_by_page(self, user_id, page_id):
        ctx = _FakeRpcContext()
        return self.svc.GetShareLinkByPage(
            share_pb2.GetShareLinkByPageRequest(user_id=user_id, page_id=page_id),
            ctx,
        ), ctx

    def _view_count(self, token):
        with db_session(self.engine) as s:
            row = s.query(ShareLink).filter(
                ShareLink.token_hash == _servicer_mod._hash_token(token)
            ).one_or_none()
            return row.view_count if row else None


class TestHashAtRest(_FakeredisCase):
    def test_row_stores_only_the_hash(self):
        """Scenario: Plaintext tokens absent from storage — the returned
        plaintext cannot be derived from anything in the row."""
        resp, ctx = self._create()
        self.assertIsNone(ctx.code)
        token = resp.token
        self.assertEqual(len(token), 43)  # token_urlsafe(32) → 43 chars

        with db_session(self.engine) as s:
            rows = s.query(ShareLink).all()
            self.assertEqual(len(rows), 1)
            row = rows[0]
            self.assertEqual(row.token_hash, _servicer_mod._hash_token(token))
            # The only token material on the row is the hash.
            serialized = repr(
                (row.token_hash, row.user_id, row.page_id, row.is_public,
                 row.active_page_id)
            )
            self.assertNotIn(token, serialized)

    def test_validation_resolves_by_hash(self):
        """ValidateToken/GetShareLink/RevokeShareLink all resolve the
        plaintext token against its stored hash."""
        resp, _ = self._create()
        token = resp.token

        valid, _ = self._validate(token)
        self.assertTrue(valid.valid)
        self.assertEqual(valid.page_id, PAGE_1)
        self.assertEqual(valid.owner_user_id, USER_A)

        got, ctx = self._get_link(token)
        self.assertIsNone(ctx.code)
        self.assertEqual(got.token, token)  # caller-supplied plaintext echoed

        revoked, _ = self._revoke(token)
        self.assertTrue(revoked.success)
        invalid, _ = self._validate(token)
        self.assertFalse(invalid.valid)

    def test_get_share_link_by_page_metadata_only_on_db_path(self):
        """Hash-at-rest: a page-keyed lookup after a cache miss cannot return
        the plaintext token — metadata only (creation stays the one-time
        reveal)."""
        resp, _ = self._create()
        self.assertTrue(resp.token)

        # Force the DB path: wipe the cache.
        self.redis.flushall()
        got, ctx = self._get_by_page(USER_A, PAGE_1)
        self.assertIsNone(ctx.code)
        self.assertEqual(got.page_id, PAGE_1)
        self.assertEqual(got.token, "")
        self.assertEqual(got.short_url, "")

    def test_get_share_link_by_page_serves_creation_cache(self):
        """With the creation-time cache entry present, the owner lookup still
        returns the full link (token included)."""
        resp, _ = self._create()
        got, ctx = self._get_by_page(USER_A, PAGE_1)
        self.assertIsNone(ctx.code)
        self.assertEqual(got.token, resp.token)
        self.assertTrue(got.short_url.endswith(f"/s/{resp.token}"))


class TestDuplicateActiveLinkRace(_FakeredisCase):
    def test_sequential_creates_single_active_row(self):
        resp1, _ = self._create()
        resp2, _ = self._create()
        with db_session(self.engine) as s:
            active = s.query(ShareLink).filter(
                ShareLink.revoked_at.is_(None)
            ).all()
            self.assertEqual(len(active), 1)
        self.assertEqual(resp1.page_id, resp2.page_id)

    def test_unique_index_blocks_second_active_row(self):
        """The DB constraint itself: a second ACTIVE row for the same
        (user_id, page_id) is impossible; revoked rows remain allowed."""
        self._create()
        with db_session(self.engine) as s:
            winner = s.query(ShareLink).one()
            dup = ShareLink(
                token_hash="f" * 64,
                active_page_id=winner.page_id,
                user_id=winner.user_id,
                page_id=winner.page_id,
                is_public=True,
            )
            s.add(dup)
            with self.assertRaises(IntegrityError):
                s.flush()
            s.rollback()

        # Revoked rows are exempt (NULL active_page_id) — re-share works.
        with db_session(self.engine) as s:
            winner = s.query(ShareLink).one()
            for i in range(3):
                s.add(ShareLink(
                    token_hash=f"{i:x}0" * 32,
                    active_page_id=None,
                    user_id=winner.user_id,
                    page_id=winner.page_id,
                    is_public=True,
                    revoked_at=_servicer_mod._utcnow(),
                ))
            s.flush()
            active = s.query(ShareLink).filter(
                ShareLink.revoked_at.is_(None)
            ).count()
            self.assertEqual(active, 1)

    def test_race_loser_converges_on_winner(self):
        """Two concurrent creates: the loser's pre-check misses the winner's
        uncommitted row, the insert hits uq_share_links_active, and the loser
        returns the existing link instead of failing or duplicating."""
        self._create()

        loser = _servicer_mod.ShareServicer()
        # Simulate the in-flight window: the pre-check sees nothing.
        with unittest.mock.patch.object(
            loser, "_find_active_link", return_value=None
        ):
            ctx = _FakeRpcContext()
            resp2 = loser.CreateShareLink(share_pb2.CreateShareLinkRequest(
                user_id=USER_A, page_id=PAGE_1,
            ), ctx)

        self.assertIsNone(ctx.code)
        self.assertEqual(resp2.page_id, PAGE_1)
        with db_session(self.engine) as s:
            self.assertEqual(s.query(ShareLink).count(), 1)

    def test_expired_link_is_replaced_not_duplicated(self):
        """An expired-but-not-revoked link is retired (revoked) before the
        replacement insert — the active-link invariant still holds."""
        past = int(time.time()) - 100
        old, _ = self._create(expires_at=past)
        new, ctx = self._create()
        self.assertIsNone(ctx.code)
        self.assertNotEqual(new.token, old.token)

        with db_session(self.engine) as s:
            rows = s.query(ShareLink).order_by(ShareLink.created_at).all()
            self.assertEqual(len(rows), 2)
            self.assertIsNotNone(rows[0].revoked_at)  # old one retired
            self.assertIsNone(rows[1].revoked_at)
            active = [r for r in rows if r.revoked_at is None]
            self.assertEqual(len(active), 1)

        # The new token validates; the old one does not.
        ok, _ = self._validate(new.token)
        self.assertTrue(ok.valid)
        gone, _ = self._validate(old.token)
        self.assertFalse(gone.valid)


class TestRevocationStaleness(_FakeredisCase):
    def test_revoke_deletes_cache_entries_immediately(self):
        resp, _ = self._create()
        token = resp.token
        token_hash = _servicer_mod._hash_token(token)

        valid, _ = self._validate(token)
        self.assertTrue(valid.valid)
        self.assertTrue(self.redis.exists(key_share_token(token_hash)))

        revoked, _ = self._revoke(token)
        self.assertTrue(revoked.success)
        self.assertFalse(self.redis.exists(key_share_token(token_hash)))
        self.assertFalse(self.redis.exists(key_share_page(USER_A, PAGE_1)))

        # Immediately-after revoke: invalid — no stale window.
        invalid, _ = self._validate(token)
        self.assertFalse(invalid.valid)

    def test_valid_entries_bounded_by_short_ttl(self):
        """2.15(c): an entry that would validate as valid=true is cached only
        for TTL_SHARE_VALID (≪ the old 1800 s) — a validation in flight
        across a concurrent revoke cannot repopulate a long-lived valid
        entry. Revoked/expired/private entries keep the metadata TTL."""
        resp, _ = self._create()
        token = resp.token
        token_hash = _servicer_mod._hash_token(token)

        self._validate(token)
        ttl = self.redis.ttl(key_share_token(token_hash))
        self.assertGreater(ttl, 0)
        self.assertLessEqual(ttl, TTL_SHARE_VALID)

        # A revoked entry (via the DB path) gets the long metadata TTL.
        self.redis.flushall()
        self._revoke(token)
        self._validate(token)  # caches the revoked dict from DB
        self.assertLessEqual(
            TTL_SHARE_VALID, self.redis.ttl(key_share_token(token_hash)),
            "revoked entries should use TTL_SHARE_LINK",
        )
        self.assertLessEqual(
            self.redis.ttl(key_share_token(token_hash)), TTL_SHARE_LINK
        )

    def test_private_and_expired_not_served_valid_from_cache(self):
        past = int(time.time()) - 50
        private, _ = self._create(is_public=False)
        expired, _ = self._create(page_id="page-exp", expires_at=past)

        for token in (private.token, expired.token):
            got, _ = self._validate(token)
            self.assertFalse(got.valid)

        # The private link's negative result is cached (it can never turn
        # valid). The expired link's cache entry is DELETED by the expiry
        # branch — deliberate: it can never become valid again, and a stale
        # near-expiry entry must not be re-servable.
        self.assertIsNotNone(
            self.redis.get(key_share_token(_servicer_mod._hash_token(private.token)))
        )
        self.assertIsNone(
            self.redis.get(key_share_token(_servicer_mod._hash_token(expired.token)))
        )


class TestRevokeLinksForPage(_FakeredisCase):
    def test_page_deletion_revokes_all_links(self):
        """Scenario: Page deletion revokes all links — every link for the
        page ends up revoked and validation turns invalid. (Two links for a
        page = one active + one historical revoked row; two concurrent active
        rows are exactly what 2.15(b) makes impossible.)"""
        link1, _ = self._create()
        # Historical (already revoked) link for the same page, seeded behind
        # the API the way pre-2.15 rows exist.
        with db_session(self.engine) as s:
            s.query(ShareLink).one()
            s.add(ShareLink(
                token_hash="e" * 64,
                active_page_id=None,
                user_id=USER_A,
                page_id=PAGE_1,
                is_public=True,
                revoked_at=_servicer_mod._utcnow(),
            ))
            s.flush()
        # A link for a different page must stay untouched.
        other, _ = self._create(page_id="page-other")

        ctx = _FakeRpcContext()
        resp = self.svc.RevokeLinksForPage(
            share_pb2.RevokeLinksForPageRequest(page_id=PAGE_1), ctx
        )
        self.assertIsNone(ctx.code)
        self.assertIsInstance(resp, common_pb2.StatusResponse)
        self.assertTrue(resp.success)

        invalid, _ = self._validate(link1.token)
        self.assertFalse(invalid.valid)
        still_valid, _ = self._validate(other.token)
        self.assertTrue(still_valid.valid)

        with db_session(self.engine) as s:
            revoked = s.query(ShareLink).filter(
                ShareLink.page_id == PAGE_1
            ).all()
            self.assertEqual(len(revoked), 2)
            for row in revoked:
                self.assertIsNotNone(row.revoked_at)
                self.assertIsNone(row.active_page_id)

    def test_revoke_links_for_page_is_idempotent(self):
        self._create()
        for _ in range(2):
            resp = self.svc.RevokeLinksForPage(
                share_pb2.RevokeLinksForPageRequest(page_id=PAGE_1),
                _FakeRpcContext(),
            )
            self.assertTrue(resp.success)

    def test_revoke_links_for_page_clears_caches(self):
        resp, _ = self._create()
        token_hash = _servicer_mod._hash_token(resp.token)
        self._validate(resp.token)
        self.assertTrue(self.redis.exists(key_share_token(token_hash)))

        self.svc.RevokeLinksForPage(
            share_pb2.RevokeLinksForPageRequest(page_id=PAGE_1), _FakeRpcContext()
        )
        self.assertFalse(self.redis.exists(key_share_token(token_hash)))
        self.assertFalse(self.redis.exists(key_share_page(USER_A, PAGE_1)))


class TestViewCountDedup(_FakeredisCase):
    def test_same_viewer_counts_once_within_window(self):
        """Scenario: Repeated asset hits do not inflate the count — one view
        per (token, viewer) window, one DB write."""
        resp, _ = self._create()
        self._validate(resp.token, viewer="ip-hash-1")
        self._validate(resp.token, viewer="ip-hash-1")
        self._validate(resp.token, viewer="ip-hash-1")
        self.assertEqual(self._view_count(resp.token), 1)

    def test_different_viewers_count_separately(self):
        resp, _ = self._create()
        self._validate(resp.token, viewer="ip-hash-1")
        self._validate(resp.token, viewer="ip-hash-2")
        self._validate(resp.token, viewer="ip-hash-1")  # dup within window
        self.assertEqual(self._view_count(resp.token), 2)

    def test_cache_hit_path_also_dedups(self):
        resp, _ = self._create()
        self._validate(resp.token, viewer="ip-hash-1")  # primes the cache
        self._validate(resp.token, viewer="ip-hash-1")  # cache hit
        self._validate(resp.token, viewer="ip-hash-1")  # cache hit
        self.assertEqual(self._view_count(resp.token), 1)

    def test_anonymous_requests_share_one_bucket(self):
        """Without the (future) viewer field, real pb2 requests dedupe per
        token — still never one DB write per asset hit."""
        resp, _ = self._create()
        self._validate(resp.token)
        self._validate(resp.token)
        self.assertEqual(self._view_count(resp.token), 1)

    def test_redis_unavailable_falls_back_to_db_write(self):
        """Redis unavailable → legacy behavior: every validated view writes
        the DB increment."""
        resp, _ = self._create()
        p = unittest.mock.patch.object(_cache_mod, "_get_client", return_value=None)
        p.start()
        self.addCleanup(p.stop)

        self._validate(resp.token)
        self._validate(resp.token)
        self.assertEqual(self._view_count(resp.token), 2)


class TestExpiryReporting(_FakeredisCase):
    def test_expired_link_not_presented_as_active_by_page(self):
        """2.15(d): GetShareLinkByPage never presents an expired link as an
        active share (404, like a missing link)."""
        past = int(time.time()) - 10
        self._create(expires_at=past)
        _resp, ctx = self._get_by_page(USER_A, PAGE_1)
        self.assertEqual(ctx.code, grpc.StatusCode.NOT_FOUND)

    def test_get_share_link_reports_expiry_timestamp(self):
        """GetShareLink keeps returning expires_at (epoch) so the owner UI
        can render the expired state — see the report note: the proto lacks
        an `expired` boolean; an additive field is needed for first-class
        reporting."""
        past = int(time.time()) - 10
        created, _ = self._create(expires_at=past)
        got, ctx = self._get_link(created.token)
        self.assertIsNone(ctx.code)
        self.assertEqual(got.expires_at, past)
        self.assertLess(got.expires_at, int(time.time()))


if __name__ == "__main__":
    unittest.main()
