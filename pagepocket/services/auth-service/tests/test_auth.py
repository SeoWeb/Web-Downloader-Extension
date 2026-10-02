"""Auth service unit tests — jwt_utils + AuthServicer RPCs."""

import hashlib
import importlib.util
import os
import sys
import time
import unittest
import unittest.mock

# ---------------------------------------------------------------------------
# Path setup — pre-load shared/db.py as 'db' to avoid name collision with
# the local db.py wrapper in services/auth-service/.
# ---------------------------------------------------------------------------
_shared = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "shared"))

_spec = importlib.util.spec_from_file_location("db", os.path.join(_shared, "db.py"))
_mod = importlib.util.module_from_spec(_spec)
sys.modules["db"] = _mod
_spec.loader.exec_module(_mod)

sys.path.insert(0, _shared)
sys.path.insert(0, os.path.join(_shared, "proto_generated"))
sys.path.insert(0, os.path.normpath(os.path.join(os.path.dirname(__file__), "..")))

os.environ.setdefault("JWT_SECRET", "test-secret-key")

import auth_pb2
import grpc
import servicer as _servicer_mod
from db import Base, db_session, get_engine
from jwt_utils import (
    ACCESS_TOKEN_EXPIRY,
    issue_access_token,
    issue_refresh_token,
    verify_access_token,
)
from models import RefreshToken, User


class _FakeRpcContext:
    """Minimal gRPC context stub that records set_code / set_details calls."""

    def __init__(self):
        self.code = None
        self.details = None

    def set_code(self, code):
        self.code = code

    def set_details(self, details):
        self.details = details


def _init_db():
    """Create an in-memory SQLite database with auth tables."""
    engine = get_engine("sqlite://")
    Base.metadata.create_all(engine)
    return engine


class TestJWTUtils(unittest.TestCase):
    def test_issue_and_verify_access_token(self):
        token, _expires_at = issue_access_token("user-1", "a@b.com", "free")
        payload = verify_access_token(token)
        self.assertIsNotNone(payload)
        self.assertEqual(payload["sub"], "user-1")
        self.assertEqual(payload["email"], "a@b.com")
        self.assertEqual(payload["plan"], "free")

    def test_invalid_token_returns_none(self):
        payload = verify_access_token("garbage-token")
        self.assertIsNone(payload)

    def test_expired_token_returns_none(self):
        # Rewind the clock past the full token lifetime so the issued
        # token is genuinely expired regardless of ACCESS_TOKEN_EXPIRY.
        with unittest.mock.patch(
            "jwt_utils.time.time",
            return_value=time.time() - ACCESS_TOKEN_EXPIRY - 7200,
        ):
            token, _ = issue_access_token("user-1", "a@b.com", "free")
        payload = verify_access_token(token)
        self.assertIsNone(payload)

    def test_issue_refresh_token(self):
        raw, token_hash, expires_at = issue_refresh_token()
        self.assertTrue(len(raw) > 30)
        expected = hashlib.sha256(raw.encode()).hexdigest()
        self.assertEqual(token_hash, expected)
        self.assertTrue(expires_at > time.time())

    def test_wrong_secret_returns_none(self):
        token, _ = issue_access_token("user-1", "a@b.com", "free")
        with unittest.mock.patch("jwt_utils.JWT_SECRET", "wrong-secret"):
            payload = verify_access_token(token)
        self.assertIsNone(payload)


# ---------------------------------------------------------------------------
# AuthServicer tests – use in-memory SQLite so ORM queries run for real
# ---------------------------------------------------------------------------


class TestAuthServicer(unittest.TestCase):
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
            s.query(RefreshToken).delete()
            s.query(User).delete()
        self.svc = _servicer_mod.AuthServicer()

    # -- helpers --

    def _register(self, email="alice@example.com", password="secret1234", name="Alice"):
        ctx = _FakeRpcContext()
        req = auth_pb2.RegisterRequest(email=email, password=password, name=name)
        return self.svc.Register(req, ctx), ctx

    def _login(self, email="alice@example.com", password="secret1234"):
        ctx = _FakeRpcContext()
        req = auth_pb2.LoginRequest(email=email, password=password)
        return self.svc.Login(req, ctx), ctx

    # -- Register --

    def test_register_success(self):
        resp, ctx = self._register()
        self.assertIsNone(ctx.code)
        self.assertTrue(resp.access_token)
        self.assertTrue(resp.refresh_token)
        self.assertTrue(resp.expires_at > 0)
        self.assertEqual(resp.user.email, "alice@example.com")
        self.assertEqual(resp.user.plan, "free")
        self.assertFalse(resp.user.is_verified)

        with db_session(self.engine) as s:
            user = s.query(User).one()
            self.assertEqual(user.email, "alice@example.com")
            self.assertNotEqual(user.password_hash, "secret1234")

    def test_register_duplicate_email(self):
        self._register()
        _resp, ctx = self._register()
        self.assertEqual(ctx.code, grpc.StatusCode.ALREADY_EXISTS)

    def test_register_invalid_email(self):
        _resp, ctx = self._register(email="not-an-email")
        self.assertEqual(ctx.code, grpc.StatusCode.INVALID_ARGUMENT)

    def test_register_short_password(self):
        _resp, ctx = self._register(password="abc")
        self.assertEqual(ctx.code, grpc.StatusCode.INVALID_ARGUMENT)

    def test_register_empty_name(self):
        _resp, ctx = self._register(name="")
        self.assertEqual(ctx.code, grpc.StatusCode.INVALID_ARGUMENT)

    # -- Login --

    def test_login_success(self):
        self._register()
        resp, ctx = self._login()
        self.assertIsNone(ctx.code)
        self.assertTrue(resp.access_token)
        self.assertTrue(resp.refresh_token)
        self.assertEqual(resp.user.email, "alice@example.com")

    def test_login_wrong_email_same_error(self):
        _resp, ctx = self._login(email="nobody@example.com", password="secret1234")
        self.assertEqual(ctx.code, grpc.StatusCode.UNAUTHENTICATED)
        self.assertEqual(ctx.details, "invalid credentials")

    def test_login_wrong_password_same_error(self):
        self._register()
        _resp, ctx = self._login(password="wrong-password")
        self.assertEqual(ctx.code, grpc.StatusCode.UNAUTHENTICATED)
        self.assertEqual(ctx.details, "invalid credentials")

    def test_login_error_messages_identical(self):
        _, ctx_bad_email = self._login(email="no@no.com")
        self._register()
        _, ctx_bad_pw = self._login(password="wrong")
        self.assertEqual(ctx_bad_email.code, ctx_bad_pw.code)
        self.assertEqual(ctx_bad_email.details, ctx_bad_pw.details)

    # -- Verify --

    def test_verify_valid_token(self):
        reg_resp, _ = self._register()
        ctx = _FakeRpcContext()
        req = auth_pb2.VerifyRequest(token=reg_resp.access_token)
        resp = self.svc.Verify(req, ctx)
        self.assertTrue(resp.valid)
        self.assertEqual(resp.user_id, reg_resp.user.id)
        self.assertEqual(resp.email, "alice@example.com")

    def test_verify_invalid_token(self):
        ctx = _FakeRpcContext()
        req = auth_pb2.VerifyRequest(token="garbage")
        resp = self.svc.Verify(req, ctx)
        self.assertFalse(resp.valid)

    # -- Refresh --

    def test_refresh_success(self):
        reg_resp, _ = self._register()
        ctx = _FakeRpcContext()
        req = auth_pb2.RefreshRequest(refresh_token=reg_resp.refresh_token)
        resp = self.svc.Refresh(req, ctx)
        self.assertIsNone(ctx.code)
        self.assertTrue(resp.access_token)
        self.assertNotEqual(resp.refresh_token, reg_resp.refresh_token)

        with db_session(self.engine) as s:
            old_hash = hashlib.sha256(reg_resp.refresh_token.encode()).hexdigest()
            old_rt = s.query(RefreshToken).filter_by(token_hash=old_hash).one_or_none()
            self.assertIsNotNone(old_rt)
            self.assertIsNotNone(old_rt.revoked_at)
            self.assertEqual(s.query(RefreshToken).count(), 2)  # old (revoked) + new

    def test_refresh_rotation_invalidates_old_token(self):
        reg_resp, _ = self._register()
        ctx = _FakeRpcContext()
        self.svc.Refresh(auth_pb2.RefreshRequest(refresh_token=reg_resp.refresh_token), ctx)

        ctx2 = _FakeRpcContext()
        self.svc.Refresh(
            auth_pb2.RefreshRequest(refresh_token=reg_resp.refresh_token), ctx2
        )
        self.assertEqual(ctx2.code, grpc.StatusCode.UNAUTHENTICATED)

    def test_refresh_reuse_detection_revokes_all(self):
        reg_resp, _ = self._register()
        ctx = _FakeRpcContext()
        self.svc.Refresh(
            auth_pb2.RefreshRequest(refresh_token=reg_resp.refresh_token), ctx
        )
        self.assertIsNone(ctx.code)

        # Replay the old (consumed) token.
        ctx2 = _FakeRpcContext()
        self.svc.Refresh(
            auth_pb2.RefreshRequest(refresh_token=reg_resp.refresh_token), ctx2
        )
        self.assertEqual(ctx2.code, grpc.StatusCode.UNAUTHENTICATED)

        with db_session(self.engine) as s:
            for t in s.query(RefreshToken).all():
                self.assertIsNotNone(t.revoked_at)

    def test_refresh_unknown_token(self):
        ctx = _FakeRpcContext()
        self.svc.Refresh(auth_pb2.RefreshRequest(refresh_token="nonexistent-token"), ctx)
        self.assertEqual(ctx.code, grpc.StatusCode.UNAUTHENTICATED)

    # -- Logout --

    def test_logout_deletes_all_tokens(self):
        reg_resp, _ = self._register()
        self._login()  # second refresh token

        with db_session(self.engine) as s:
            self.assertEqual(s.query(RefreshToken).count(), 2)

        ctx = _FakeRpcContext()
        req = auth_pb2.LogoutRequest(user_id=reg_resp.user.id)
        resp = self.svc.Logout(req, ctx)
        self.assertTrue(resp.success)

        with db_session(self.engine) as s:
            self.assertEqual(s.query(RefreshToken).count(), 0)


if __name__ == "__main__":
    unittest.main()
