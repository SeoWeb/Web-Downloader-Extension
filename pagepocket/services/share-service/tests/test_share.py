"""Share service unit tests — expiry, revocation, view-count increment, enumeration-proof errors."""

import importlib.util
import os
import sys
import time
import unittest
import unittest.mock

_shared = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "shared"))

_spec = importlib.util.spec_from_file_location("db", os.path.join(_shared, "db.py"))
_mod = importlib.util.module_from_spec(_spec)
sys.modules["db"] = _mod
_spec.loader.exec_module(_mod)

sys.path.insert(0, _shared)
sys.path.insert(0, os.path.join(_shared, "proto_generated"))
sys.path.insert(0, os.path.normpath(os.path.join(os.path.dirname(__file__), "..")))

os.environ.setdefault("BASE_URL", "http://localhost:8000")

import grpc
import servicer as _servicer_mod
import share_pb2
from db import Base, db_session, get_engine
from models import ShareLink


class _FakeRpcContext:
    def __init__(self):
        self.code = None
        self.details = None

    def set_code(self, code):
        self.code = code

    def set_details(self, details):
        self.details = details


USER_A = "user-a-001"
USER_B = "user-b-002"
PAGE_1 = "page-001"


def _init_db():
    engine = get_engine("sqlite://")
    Base.metadata.create_all(engine)
    return engine


class TestShareServicer(unittest.TestCase):
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
        cls._engine_patcher.stop()
        cls._session_patcher.stop()

    def setUp(self):
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

    def _validate(self, token):
        ctx = _FakeRpcContext()
        req = share_pb2.ValidateTokenRequest(token=token)
        return self.svc.ValidateToken(req, ctx), ctx

    def _revoke(self, token, user_id=USER_A):
        ctx = _FakeRpcContext()
        req = share_pb2.RevokeShareLinkRequest(token=token, user_id=user_id)
        return self.svc.RevokeShareLink(req, ctx), ctx

    def _get(self, token):
        ctx = _FakeRpcContext()
        req = share_pb2.GetShareLinkRequest(token=token)
        return self.svc.GetShareLink(req, ctx), ctx

    # -- CreateShareLink --

    def test_create_success(self):
        resp, ctx = self._create()
        self.assertIsNone(ctx.code)
        self.assertTrue(resp.token)
        self.assertTrue(resp.short_url)
        self.assertTrue(resp.is_public)
        self.assertEqual(resp.view_count, 0)

    def test_create_returns_existing_active_link(self):
        resp1, _ = self._create()
        resp2, _ = self._create()
        self.assertEqual(resp1.token, resp2.token)

    def test_create_with_expiry(self):
        exp = int(time.time()) + 3600
        resp, _ = self._create(expires_at=exp)
        self.assertGreater(resp.expires_at, 0)

    # -- ValidateToken --

    def test_validate_valid_token(self):
        created, _ = self._create()
        resp, _ctx = self._validate(created.token)
        self.assertTrue(resp.valid)
        self.assertEqual(resp.page_id, PAGE_1)

    def test_validate_increments_view_count(self):
        created, _ = self._create()
        self._validate(created.token)
        self._validate(created.token)

        resp, _ = self._get(created.token)
        self.assertEqual(resp.view_count, 2)

    def test_validate_unknown_token(self):
        resp, _ctx = self._validate("nonexistent-token")
        self.assertFalse(resp.valid)

    # -- Expiry --

    def test_validate_expired_token(self):
        past = int(time.time()) - 10
        created, _ = self._create(expires_at=past)
        resp, _ctx = self._validate(created.token)
        self.assertFalse(resp.valid)

    def test_validate_non_expired_token(self):
        future = int(time.time()) + 3600
        created, _ = self._create(expires_at=future)
        resp, _ctx = self._validate(created.token)
        self.assertTrue(resp.valid)

    def test_validate_never_expiring_token(self):
        created, _ = self._create(expires_at=0)
        resp, _ctx = self._validate(created.token)
        self.assertTrue(resp.valid)

    # -- Revocation --

    def test_revoke_success(self):
        created, _ = self._create()
        resp, _ctx = self._revoke(created.token)
        self.assertTrue(resp.success)

    def test_validate_revoked_token(self):
        created, _ = self._create()
        self._revoke(created.token)
        resp, _ctx = self._validate(created.token)
        self.assertFalse(resp.valid)

    def test_revoke_others_link_fails(self):
        created, _ = self._create(user_id=USER_A)
        resp, _ctx = self._revoke(created.token, user_id=USER_B)
        self.assertFalse(resp.success)

    # -- Non-public tokens --

    def test_validate_non_public_token(self):
        created, _ = self._create(is_public=False)
        resp, _ctx = self._validate(created.token)
        self.assertFalse(resp.valid)

    # -- Enumeration-proof error uniformity --

    def test_validate_returns_same_shape_for_all_failures(self):
        past = int(time.time()) - 10
        expired, _ = self._create(expires_at=past)
        public, _ = self._create()
        self._revoke(public.token)
        private, _ = self._create(is_public=False)

        for desc, token in [
            ("unknown", "nonexistent-token"),
            ("expired", expired.token),
            ("revoked", public.token),
            ("private", private.token),
        ]:
            resp, ctx = self._validate(token)
            self.assertFalse(resp.valid, f"{desc} should be invalid")
            self.assertEqual(resp.page_id, "", f"{desc} should not leak page_id")
            self.assertIsNone(ctx.code, f"{desc} should not set gRPC error code")

    # -- GetShareLink --

    def test_get_existing_link(self):
        created, _ = self._create()
        resp, ctx = self._get(created.token)
        self.assertIsNone(ctx.code)
        self.assertEqual(resp.token, created.token)
        self.assertEqual(resp.page_id, PAGE_1)

    def test_get_nonexistent_link(self):
        _, ctx = self._get("nonexistent")
        self.assertEqual(ctx.code, grpc.StatusCode.NOT_FOUND)


if __name__ == "__main__":
    unittest.main()
