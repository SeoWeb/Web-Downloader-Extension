"""GoogleAuth RPC unit tests (easier-auth 2.7).

Covers the six spec scenarios plus failure-mode edge cases: new-user creation,
auto-link to an existing password account, returning google_sub match,
unverifiable token material (signature/aud/exp/iss/email_verified), Google
dependency failure, link conflicts, and NULL password_hash login.

External HTTP is mocked at the servicer's own boundaries (`_exchange_google_code`
returns the Google token-endpoint body, `_fetch_jwks` serves a locally generated
JWKS) — the repo has no HTTP-mocking library, matching test_auth.py's
unittest.mock convention. ID tokens are genuinely RS256-signed with a locally
generated key so the signature-verification path runs for real.
"""

import hashlib
import importlib.util
import json
import os
import sys
import time
import types
import unittest
import unittest.mock
from datetime import UTC, datetime, timedelta

# ---------------------------------------------------------------------------
# Path setup — identical to test_auth.py: pre-load shared/db.py as 'db' (only
# if another suite has not already loaded it — a second Base with empty
# metadata would silently create no tables) and put shared/, the generated
# stubs, and this service's dir on sys.path.
# ---------------------------------------------------------------------------
_shared = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "shared"))

if "db" not in sys.modules:
    _spec = importlib.util.spec_from_file_location("db", os.path.join(_shared, "db.py"))
    _mod = importlib.util.module_from_spec(_spec)
    sys.modules["db"] = _mod
    _spec.loader.exec_module(_mod)

sys.path.insert(0, _shared)
sys.path.insert(0, os.path.join(_shared, "proto_generated"))
sys.path.insert(0, os.path.normpath(os.path.join(os.path.dirname(__file__), "..")))

os.environ.setdefault("JWT_SECRET", "test-secret-key")
os.environ.setdefault("GOOGLE_CLIENT_ID", "test-google-client-id.apps.googleusercontent.com")
os.environ.setdefault("GOOGLE_CLIENT_SECRET", "test-google-client-secret")

# Per-service module aliases (see tests/conftest.py): register this suite's
# copies of the shared names exactly like test_auth.py does, regardless of
# which suite is collected first.
_PP_ALIAS = "_ppsvc_auth-service_"
if _PP_ALIAS + "models" not in sys.modules:
    for _name in ("models", "servicer"):
        sys.modules.pop(_name, None)

import auth_pb2
import grpc
import jwt
import servicer as _servicer_mod
from cryptography.hazmat.primitives.asymmetric import rsa as _rsa
from db import Base, db_session, get_engine
from jwt.algorithms import RSAAlgorithm
from jwt_utils import REFRESH_TOKEN_EXPIRY, verify_access_token
from models import RefreshToken, User

sys.modules[_PP_ALIAS + "models"] = sys.modules["models"]
sys.modules[_PP_ALIAS + "servicer"] = sys.modules["servicer"]

_CLIENT_ID = os.environ["GOOGLE_CLIENT_ID"]


class _FakeRpcContext:
    """Minimal gRPC context stub that records set_code / set_details calls."""

    def __init__(self):
        self.code = None
        self.details = None

    def set_code(self, code):
        self.code = code

    def set_details(self, details):
        self.details = details


def _generate_key(kid):
    """RSA keypair + the public JWK the mocked JWKS endpoint would serve."""
    private = _rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(RSAAlgorithm.to_jwk(private.public_key()))
    jwk.update({"kid": kid, "alg": "RS256", "use": "sig"})
    return private, jwk


def _init_db():
    engine = get_engine("sqlite://")
    Base.metadata.create_all(engine)
    return engine


class TestJWKSHeaderParsing(unittest.TestCase):
    def test_max_age_parsed(self):
        self.assertEqual(_servicer_mod._parse_cache_control_max_age("public, max-age=22821, must-revalidate"), 22821.0)

    def test_missing_or_unparseable_header_is_zero(self):
        self.assertEqual(_servicer_mod._parse_cache_control_max_age(None), 0.0)
        self.assertEqual(_servicer_mod._parse_cache_control_max_age("public"), 0.0)
        self.assertEqual(_servicer_mod._parse_cache_control_max_age(""), 0.0)


class TestExchangeGoogleCode(unittest.TestCase):
    """The exchange helper's own failure modes — network/5xx/JSON shapes."""

    def setUp(self):
        self.svc = object.__new__(_servicer_mod.AuthServicer)

    def test_unconfigured_credentials_fail_closed(self):
        env = {k: "" for k in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET")}
        with unittest.mock.patch.dict(os.environ, env):
            self.assertIsNone(self.svc._exchange_google_code("c", "v", "r"))

    def test_unreachable_endpoint_returns_none(self):
        import httpx

        with unittest.mock.patch.object(
            _servicer_mod.httpx, "post", side_effect=httpx.ConnectError("boom")
        ):
            self.assertIsNone(self.svc._exchange_google_code("c", "v", "r"))

    def test_google_5xx_returns_none(self):
        resp = types.SimpleNamespace(status_code=503)
        with unittest.mock.patch.object(_servicer_mod.httpx, "post", return_value=resp):
            self.assertIsNone(self.svc._exchange_google_code("c", "v", "r"))

    def test_non_json_body_returns_none(self):
        resp = types.SimpleNamespace(status_code=200, json=lambda: (_ for _ in ()).throw(ValueError()))
        with unittest.mock.patch.object(_servicer_mod.httpx, "post", return_value=resp):
            self.assertIsNone(self.svc._exchange_google_code("c", "v", "r"))

    def test_body_without_id_token_returns_none(self):
        resp = types.SimpleNamespace(status_code=200, json=lambda: {"error": "invalid_grant"})
        with unittest.mock.patch.object(_servicer_mod.httpx, "post", return_value=resp):
            self.assertIsNone(self.svc._exchange_google_code("c", "v", "r"))

    def test_sends_the_pkce_exchange_payload(self):
        captured = {}

        def _capture(url, **kwargs):
            captured["url"] = url
            captured["data"] = kwargs["data"]
            return types.SimpleNamespace(
                status_code=200, json=lambda: {"id_token": "tok"}
            )

        with unittest.mock.patch.object(_servicer_mod.httpx, "post", side_effect=_capture):
            body = self.svc._exchange_google_code("the-code", "the-verifier", "https://ext.chromiumapp.org/")
        self.assertEqual(body, {"id_token": "tok"})
        self.assertEqual(captured["url"], _servicer_mod._GOOGLE_TOKEN_URL)
        self.assertEqual(
            captured["data"],
            {
                "code": "the-code",
                "client_id": _CLIENT_ID,
                "client_secret": os.environ["GOOGLE_CLIENT_SECRET"],
                "code_verifier": "the-verifier",
                "redirect_uri": "https://ext.chromiumapp.org/",
                "grant_type": "authorization_code",
            },
        )


class TestGoogleAuth(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = _init_db()
        cls.key_main, cls.jwk_main = _generate_key("test-kid-main")
        cls.key_other, cls.jwk_other = _generate_key("test-kid-other")

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

    def _id_token(
        self,
        key=None,
        kid="test-kid-main",
        sub="google-sub-1",
        email="guser@example.com",
        name="Google User",
        email_verified=True,
        aud=_CLIENT_ID,
        iss="https://accounts.google.com",
        expired=False,
    ):
        now = int(time.time())
        iat, exp = now, now + 3600
        if expired:
            iat, exp = now - 7200, now - 3600
        payload = {
            "iss": iss,
            "aud": aud,
            "sub": sub,
            "email": email,
            "email_verified": email_verified,
            "name": name,
            "iat": iat,
            "exp": exp,
        }
        return jwt.encode(
            payload, (key or self.key_main), algorithm="RS256", headers={"kid": kid}
        )

    def _google(self, id_token, **exchange_kwargs):
        """Run GoogleAuth with the token endpoint returning `id_token` and the
        JWKS endpoint serving this class's main key."""
        ctx = _FakeRpcContext()
        req = auth_pb2.GoogleAuthRequest(
            code="code",
            code_verifier="verifier",
            redirect_uri="https://ext.chromiumapp.org/",
            **exchange_kwargs,
        )
        with (
            unittest.mock.patch.object(
                self.svc, "_exchange_google_code", return_value={"id_token": id_token}
            ),
            unittest.mock.patch.object(
                type(self.svc),
                "_fetch_jwks",
                return_value={"keys": [self.jwk_main]},
            ),
        ):
            resp = self.svc.GoogleAuth(req, ctx)
        return resp, ctx

    def _user_count(self):
        with db_session(self.engine) as s:
            return s.query(User).count()

    def _user_by_email(self, email):
        """Plain values read INSIDE the session — ORM instances go stale
        (expired + detached) once db_session closes."""
        with db_session(self.engine) as s:
            user = s.query(User).filter(User.email == email).one_or_none()
            if user is None:
                return None
            return types.SimpleNamespace(
                id=user.id,
                email=user.email,
                google_sub=user.google_sub,
                password_hash=user.password_hash,
                plan=user.plan,
                is_verified=user.is_verified,
            )

    def _register(self, email="alice@example.com", password="secret1234", name="Alice"):
        ctx = _FakeRpcContext()
        req = auth_pb2.RegisterRequest(email=email, password=password, name=name)
        return self.svc.Register(req, ctx), ctx

    def _login(self, email="alice@example.com", password="secret1234"):
        ctx = _FakeRpcContext()
        req = auth_pb2.LoginRequest(email=email, password=password)
        return self.svc.Login(req, ctx), ctx

    # -- Scenario: Successful Google sign-in for a new user --

    def test_new_user_created_with_tokens(self):
        resp, ctx = self._google(self._id_token())
        self.assertIsNone(ctx.code)
        self.assertEqual(resp.user.email, "guser@example.com")
        self.assertEqual(resp.user.name, "Google User")
        self.assertEqual(resp.user.plan, "free")
        self.assertTrue(resp.user.is_verified)

        user = self._user_by_email("guser@example.com")
        self.assertIsNotNone(user)
        self.assertEqual(user.google_sub, "google-sub-1")
        self.assertIsNone(user.password_hash)
        self.assertEqual(user.plan, "free")
        self.assertTrue(user.is_verified)

        # Access token: real platform JWT (HS256, 1h) for the new user id.
        payload = verify_access_token(resp.access_token)
        self.assertIsNotNone(payload)
        self.assertEqual(payload["sub"], user.id)
        self.assertEqual(payload["exp"] - payload["iat"], 3600)

        # Refresh token: persisted SHA-256 row with a 30-day expiry.
        raw_hash = hashlib.sha256(resp.refresh_token.encode()).hexdigest()
        with db_session(self.engine) as s:
            rt = s.query(RefreshToken).filter_by(token_hash=raw_hash).one_or_none()
            self.assertIsNotNone(rt)
            rt_user_id = rt.user_id
            expires_at = rt.expires_at.replace(tzinfo=UTC) if rt.expires_at.tzinfo is None else rt.expires_at
        self.assertEqual(rt_user_id, user.id)
        self.assertGreaterEqual(
            expires_at - datetime.now(UTC),
            timedelta(seconds=REFRESH_TOKEN_EXPIRY - 60),
        )

    def test_missing_profile_name_falls_back_to_email_local_part(self):
        resp, ctx = self._google(self._id_token(name=""))
        self.assertIsNone(ctx.code)
        self.assertEqual(resp.user.name, "guser")

    # -- Scenario: Google sign-in links an existing password account --

    def test_links_existing_password_account_without_duplicate(self):
        reg, _ = self._register(email="alice@example.com")

        resp, ctx = self._google(
            self._id_token(sub="sub-alice", email="alice@example.com", name="Alice G")
        )
        self.assertIsNone(ctx.code)
        self.assertEqual(resp.user.id, reg.user.id)

        with db_session(self.engine) as s:
            users = s.query(User).all()
            self.assertEqual(len(users), 1)
            self.assertEqual(users[0].google_sub, "sub-alice")
            self.assertIsNotNone(users[0].password_hash)  # password account untouched

        # The pre-existing password still works after linking.
        _, login_ctx = self._login(email="alice@example.com")
        self.assertIsNone(login_ctx.code)

    # -- Scenario: Returning Google user --

    def test_returning_user_matches_by_google_sub_first(self):
        first, ctx = self._google(self._id_token(sub="stable-sub", email="original@example.com"))
        self.assertIsNone(ctx.code)

        # Same sub, DIFFERENT email in the token: the google_sub match wins —
        # the existing user authenticates and no second account is created.
        second, ctx2 = self._google(
            self._id_token(sub="stable-sub", email="renamed@example.com")
        )
        self.assertIsNone(ctx2.code)
        self.assertEqual(second.user.id, first.user.id)
        self.assertEqual(second.user.email, "original@example.com")
        self.assertEqual(self._user_count(), 1)

    def test_email_match_does_not_overwrite_a_different_google_sub(self):
        """A Google account whose sub differs from the stored link must not
        steal the email-matched account — refused without modification."""
        self._google(self._id_token(sub="sub-A", email="alice@example.com"))

        ctx = _FakeRpcContext()
        req = auth_pb2.GoogleAuthRequest(
            code="code", code_verifier="v", redirect_uri="r"
        )
        with (
            unittest.mock.patch.object(
                self.svc,
                "_exchange_google_code",
                return_value={"id_token": self._id_token(sub="sub-B", email="alice@example.com")},
            ),
            unittest.mock.patch.object(
                type(self.svc), "_fetch_jwks", return_value={"keys": [self.jwk_main]}
            ),
        ):
            self.svc.GoogleAuth(req, ctx)
        self.assertEqual(ctx.code, grpc.StatusCode.UNAUTHENTICATED)
        self.assertEqual(self._user_count(), 1)
        self.assertEqual(self._user_by_email("alice@example.com").google_sub, "sub-A")

    # -- Scenario: Invalid or unverifiable token material --

    def test_invalid_code_is_unauthenticated_without_user_mutation(self):
        ctx = _FakeRpcContext()
        req = auth_pb2.GoogleAuthRequest(code="code", code_verifier="v", redirect_uri="r")
        with unittest.mock.patch.object(self.svc, "_exchange_google_code", return_value=None):
            self.svc.GoogleAuth(req, ctx)
        self.assertEqual(ctx.code, grpc.StatusCode.UNAUTHENTICATED)
        self.assertEqual(self._user_count(), 0)

    def test_bad_signature_is_unauthenticated_without_user_mutation(self):
        # Signed with a key the JWKS does not serve.
        token = self._id_token(key=self.key_other, kid="test-kid-other")
        _resp, ctx = self._google(token)
        self.assertEqual(ctx.code, grpc.StatusCode.UNAUTHENTICATED)
        self.assertEqual(self._user_count(), 0)

    def test_wrong_audience_is_unauthenticated(self):
        token = self._id_token(aud="some-other-client-id")
        _resp, ctx = self._google(token)
        self.assertEqual(ctx.code, grpc.StatusCode.UNAUTHENTICATED)
        self.assertEqual(self._user_count(), 0)

    def test_expired_token_is_unauthenticated(self):
        token = self._id_token(expired=True)
        _resp, ctx = self._google(token)
        self.assertEqual(ctx.code, grpc.StatusCode.UNAUTHENTICATED)
        self.assertEqual(self._user_count(), 0)

    def test_unverified_email_is_unauthenticated(self):
        token = self._id_token(email_verified=False)
        _resp, ctx = self._google(token)
        self.assertEqual(ctx.code, grpc.StatusCode.UNAUTHENTICATED)
        self.assertEqual(self._user_count(), 0)

    def test_missing_email_verified_claim_is_unauthenticated(self):
        token = jwt.encode(
            {
                "iss": "https://accounts.google.com",
                "aud": _CLIENT_ID,
                "sub": "google-sub-1",
                "email": "guser@example.com",
                "iat": int(time.time()),
                "exp": int(time.time()) + 3600,
            },
            self.key_main,
            algorithm="RS256",
            headers={"kid": "test-kid-main"},
        )
        _resp, ctx = self._google(token)
        self.assertEqual(ctx.code, grpc.StatusCode.UNAUTHENTICATED)
        self.assertEqual(self._user_count(), 0)

    def test_wrong_issuer_is_unauthenticated(self):
        token = self._id_token(iss="https://evil.example.com")
        _resp, ctx = self._google(token)
        self.assertEqual(ctx.code, grpc.StatusCode.UNAUTHENTICATED)
        self.assertEqual(self._user_count(), 0)

    def test_garbage_token_is_unauthenticated(self):
        _resp, ctx = self._google("not-a-jwt")
        self.assertEqual(ctx.code, grpc.StatusCode.UNAUTHENTICATED)
        self.assertEqual(self._user_count(), 0)

    def test_all_google_failures_share_one_generic_message(self):
        """No enumeration, no Google internals: every failure uses the same
        short generic detail, in kind identical to login's 'invalid credentials'."""
        details = set()
        for token in (
            None,  # exchange failure (None body → no id_token)
            self._id_token(key=self.key_other, kid="test-kid-other"),  # bad signature
            self._id_token(aud="wrong"),  # bad audience
            self._id_token(expired=True),  # expired
            self._id_token(email_verified=False),  # unverified email
        ):
            if token is None:
                ctx = _FakeRpcContext()
                with unittest.mock.patch.object(
                    self.svc, "_exchange_google_code", return_value=None
                ):
                    self.svc.GoogleAuth(
                        auth_pb2.GoogleAuthRequest(code="c", code_verifier="v", redirect_uri="r"), ctx
                    )
            else:
                _, ctx = self._google(token)
            details.add(ctx.details)
        self.assertEqual(details, {"google sign-in failed"})

    # -- Scenario: Google dependency failure --

    def test_google_endpoint_unreachable_is_unauthenticated_without_mutation(self):
        import httpx

        ctx = _FakeRpcContext()
        req = auth_pb2.GoogleAuthRequest(code="c", code_verifier="v", redirect_uri="r")
        with unittest.mock.patch.object(
            _servicer_mod.httpx, "post", side_effect=httpx.ConnectError("down")
        ):
            self.svc.GoogleAuth(req, ctx)
        self.assertEqual(ctx.code, grpc.StatusCode.UNAUTHENTICATED)
        self.assertEqual(ctx.details, "google sign-in failed")
        self.assertEqual(self._user_count(), 0)

    def test_google_5xx_is_unauthenticated_without_mutation(self):
        ctx = _FakeRpcContext()
        req = auth_pb2.GoogleAuthRequest(code="c", code_verifier="v", redirect_uri="r")
        with unittest.mock.patch.object(
            _servicer_mod.httpx,
            "post",
            return_value=types.SimpleNamespace(status_code=500),
        ):
            self.svc.GoogleAuth(req, ctx)
        self.assertEqual(ctx.code, grpc.StatusCode.UNAUTHENTICATED)
        self.assertEqual(self._user_count(), 0)

    # -- Scenario: Google-only account cannot password-login --

    def test_null_password_hash_login_is_generic_unauthenticated(self):
        self._google(self._id_token(sub="sub-g", email="googleonly@example.com"))

        # Sanity: the account really has no password hash.
        user = self._user_by_email("googleonly@example.com")
        self.assertIsNone(user.password_hash)

        _resp, ctx = self._login(email="googleonly@example.com", password="whatever-password")
        self.assertEqual(ctx.code, grpc.StatusCode.UNAUTHENTICATED)
        # Identical to the wrong-credentials message — no "has Google account"
        # enumeration.
        self.assertEqual(ctx.details, "invalid credentials")

        _resp, ctx_bad_email = self._login(email="nobody@example.com", password="whatever-password")
        self.assertEqual(ctx.details, ctx_bad_email.details)
        self.assertEqual(ctx.code, ctx_bad_email.code)

    # -- JWKS cache behaviour --

    def test_unknown_kid_triggers_single_jwks_refresh(self):
        """A rotated kid must force one cache-bypassing JWKS re-fetch."""
        token = self._id_token(kid="freshly-rotated-kid")
        ctx = _FakeRpcContext()
        req = auth_pb2.GoogleAuthRequest(code="code", code_verifier="v", redirect_uri="r")

        calls = []
        jwks_with_new_key = {"keys": [self.jwk_main | {"kid": "freshly-rotated-kid"}]}

        def _fake_fetch(force_refresh=False):
            calls.append(force_refresh)
            # First (cached-cache) lookup serves the STALE key set without
            # the kid; only the forced refresh carries the rotated key.
            return {"keys": []} if len(calls) == 1 else jwks_with_new_key

        with (
            unittest.mock.patch.object(
                self.svc, "_exchange_google_code", return_value={"id_token": token}
            ),
            unittest.mock.patch.object(type(self.svc), "_fetch_jwks", side_effect=_fake_fetch),
        ):
            resp = self.svc.GoogleAuth(req, ctx)

        self.assertIsNone(ctx.code)
        self.assertEqual(resp.user.email, "guser@example.com")
        # First lookup (cached) + one forced refresh — never a fetch loop.
        self.assertEqual(calls, [False, True])


if __name__ == "__main__":
    unittest.main()
