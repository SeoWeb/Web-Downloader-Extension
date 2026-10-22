"""Auth service gRPC servicer implementation."""

import hashlib
import logging
import os
import re
import sys
import threading
import time
from datetime import UTC, datetime

import grpc
import httpx
import jwt
from passlib.context import CryptContext
from sqlalchemy import select

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared", "proto_generated"))

import auth_pb2
import auth_pb2_grpc

# StatusResponse lives in common.proto (single source of truth since
# harden-pagepocket-platform): auth.proto no longer defines its own.
import common_pb2
from config import google_credentials
from db import db_session, get_engine
from jwt_utils import issue_access_token, issue_refresh_token, verify_access_token
from models import RefreshToken, User

logger = logging.getLogger(__name__)

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto", bcrypt__rounds=12)

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# --- Google sign-in (easier-auth D4/D5) -------------------------------------
_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
_GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
_GOOGLE_ISSUERS = ("accounts.google.com", "https://accounts.google.com")
_GOOGLE_HTTP_TIMEOUT_SECONDS = 10.0
# Google serves the JWKS with a Cache-Control max-age; this fallback covers a
# response without it so the keys never pin forever.
_GOOGLE_JWKS_FALLBACK_TTL_SECONDS = 300.0
# The single failure message for EVERY GoogleAuth failure mode: no user
# enumeration, no Google internals leaked (spec "Invalid or unverifiable
# token material" / "Google dependency failure").
_GOOGLE_FAIL_DETAIL = "google sign-in failed"

_JWKS_MAX_AGE_RE = re.compile(r"max-age\s*=\s*(\d+)", re.IGNORECASE)


def _parse_cache_control_max_age(header: str | None) -> float:
    """Extract the Cache-Control max-age (seconds) from a response header.

    Returns 0.0 when absent/unparseable — the caller applies its fallback TTL.
    """
    if not header:
        return 0.0
    match = _JWKS_MAX_AGE_RE.search(header)
    return float(match.group(1)) if match else 0.0


def _bcrypt_truncate(password: str) -> str:
    return password.encode("utf-8")[:72].decode("utf-8", errors="ignore")


class AuthServicer(auth_pb2_grpc.AuthServiceServicer):
    def __init__(self):
        self.engine = get_engine()
        # Google JWKS cache (easier-auth): the raw JWKS document plus the
        # monotonic-clock expiry derived from its Cache-Control max-age.
        self._jwks_keys: dict | None = None
        self._jwks_expires_at = 0.0
        self._jwks_lock = threading.Lock()

    def _auth_response_for(self, session, user) -> auth_pb2.AuthResponse:
        """Issue the platform's normal token pair for `user` — the exact
        issuance path shared with Register/Login/Refresh (jwt_utils access
        JWT + persisted rotating refresh token), factored so GoogleAuth
        cannot drift from it and the existing RPCs stay untouched."""
        access_token, expires_at = issue_access_token(user.id, user.email, user.plan)
        raw_refresh, refresh_hash, refresh_expires = issue_refresh_token()
        rt = RefreshToken(
            user_id=user.id,
            token_hash=refresh_hash,
            expires_at=datetime.fromtimestamp(refresh_expires, tz=UTC),
        )
        session.add(rt)

        return auth_pb2.AuthResponse(
            access_token=access_token,
            refresh_token=raw_refresh,
            expires_at=expires_at,
            user=auth_pb2.User(
                id=user.id,
                email=user.email,
                name=user.name,
                plan=user.plan,
                is_verified=user.is_verified,
                created_at=user.created_at.isoformat(),
            ),
        )

    # -- Google sign-in helpers (all failure modes return None and log; the
    #    RPC layer is the only place that maps them to UNAUTHENTICATED, and
    #    it opens the DB session strictly AFTER verification succeeded, so a
    #    failure can never create or modify a user) --

    def _exchange_google_code(self, code: str, code_verifier: str, redirect_uri: str) -> dict | None:
        """Exchange the authorization code at Google's token endpoint.

        The client secret stays server-side (D4). Returns the parsed JSON
        body, or None on any failure (unreachable endpoint, non-200 —
        including Google 5xx — non-JSON body, missing id_token).
        """
        client_id, client_secret = google_credentials()
        if not client_id or not client_secret:
            logger.warning("GoogleAuth rejected: GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET not configured")
            return None
        try:
            resp = httpx.post(
                _GOOGLE_TOKEN_URL,
                data={
                    "code": code,
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "code_verifier": code_verifier,
                    "redirect_uri": redirect_uri,
                    "grant_type": "authorization_code",
                },
                timeout=_GOOGLE_HTTP_TIMEOUT_SECONDS,
            )
        except httpx.HTTPError as exc:
            logger.warning("Google token endpoint unreachable: %s", exc.__class__.__name__)
            return None
        if resp.status_code != 200:
            # Diagnostic-only: surface Google's `error` / `error_description`
            # fields. Those two carry only error codes/descriptions — no token
            # material — and nothing else from the body is ever logged (the
            # non-JSON fallback is truncated to 200 chars).
            try:
                payload = resp.json()
            except (ValueError, AttributeError):
                payload = None
            if isinstance(payload, dict):
                logger.warning(
                    "Google token exchange failed with HTTP %d error=%s description=%s",
                    resp.status_code,
                    payload.get("error"),
                    str(payload.get("error_description") or "")[:200],
                )
            else:
                logger.warning(
                    "Google token exchange failed with HTTP %d description=%s",
                    resp.status_code,
                    (getattr(resp, "text", "") or "")[:200],
                )
            return None
        try:
            body = resp.json()
        except ValueError:
            logger.warning("Google token exchange returned a non-JSON body")
            return None
        if not isinstance(body, dict) or not body.get("id_token"):
            logger.warning("Google token exchange response carried no id_token")
            return None
        return body

    def _fetch_jwks(self, force_refresh: bool = False) -> dict | None:
        """Fetch Google's signing keys, honoring the Cache-Control max-age TTL."""
        now = time.monotonic()
        with self._jwks_lock:
            if not force_refresh and self._jwks_keys is not None and now < self._jwks_expires_at:
                return self._jwks_keys
        try:
            resp = httpx.get(_GOOGLE_JWKS_URL, timeout=_GOOGLE_HTTP_TIMEOUT_SECONDS)
        except httpx.HTTPError as exc:
            logger.warning("Google JWKS unreachable: %s", exc.__class__.__name__)
            return None
        if resp.status_code != 200:
            logger.warning("Google JWKS fetch failed with HTTP %d", resp.status_code)
            return None
        ttl = (
            _parse_cache_control_max_age(resp.headers.get("cache-control"))
            or _GOOGLE_JWKS_FALLBACK_TTL_SECONDS
        )
        try:
            keys = resp.json()
        except ValueError:
            logger.warning("Google JWKS endpoint returned a non-JSON body")
            return None
        with self._jwks_lock:
            self._jwks_keys = keys
            self._jwks_expires_at = time.monotonic() + ttl
        return keys

    @staticmethod
    def _signing_key_for_kid(keys: dict | None, kid: str):
        """Return the crypto key for `kid` from a JWKS document, or None."""
        if not isinstance(keys, dict):
            return None
        for jwk in keys.get("keys") or []:
            if isinstance(jwk, dict) and jwk.get("kid") == kid:
                try:
                    return jwt.PyJWK.from_dict(jwk).key
                except (jwt.PyJWTError, ValueError, TypeError):
                    return None
        return None

    def _verify_google_id_token(self, id_token: str) -> dict | None:
        """Verify the ID token: JWKS signature, aud == GOOGLE_CLIENT_ID,
        accepted issuer, unexpired exp (PyJWT), and email_verified=true.

        Returns the verified claims, or None. The `iss` check is manual —
        PyJWT (<=2.7) compares the claim strictly against the `issuer`
        argument, so a set of accepted issuers cannot go through it.
        """
        client_id, _client_secret = google_credentials()
        if not client_id:
            return None
        try:
            header = jwt.get_unverified_header(id_token)
        except jwt.PyJWTError:
            return None
        kid = header.get("kid")
        if not kid:
            return None
        keys = self._fetch_jwks()
        key = self._signing_key_for_kid(keys, kid)
        if key is None:
            # The kid may have rotated since the cache was filled — refresh
            # the JWKS once before giving up.
            key = self._signing_key_for_kid(self._fetch_jwks(force_refresh=True), kid)
            if key is None:
                logger.warning("Google ID token kid not found in JWKS")
                return None
        try:
            claims = jwt.decode(
                id_token,
                key,
                algorithms=["RS256"],
                audience=client_id,
                options={"require": ["exp", "iat", "sub", "aud", "iss"]},
            )
        except jwt.PyJWTError as exc:
            logger.warning("Google ID token rejected: %s", exc.__class__.__name__)
            return None
        if claims.get("iss") not in _GOOGLE_ISSUERS:
            logger.warning("Google ID token issuer not accepted")
            return None
        # Google emails are only trusted when Google verified them — this is
        # what licenses the auto-link in GoogleAuth below (D5).
        if claims.get("email_verified") is not True:
            logger.warning("Google ID token email_verified is not true")
            return None
        if not claims.get("email"):
            return None
        return claims

    def GoogleAuth(self, request, context):
        body = self._exchange_google_code(request.code, request.code_verifier, request.redirect_uri)
        id_token = (body or {}).get("id_token")
        if not id_token:
            context.set_code(grpc.StatusCode.UNAUTHENTICATED)
            context.set_details(_GOOGLE_FAIL_DETAIL)
            return auth_pb2.AuthResponse()

        claims = self._verify_google_id_token(id_token)
        if claims is None:
            context.set_code(grpc.StatusCode.UNAUTHENTICATED)
            context.set_details(_GOOGLE_FAIL_DETAIL)
            return auth_pb2.AuthResponse()

        sub = claims["sub"]
        email = claims["email"].strip().lower()[:255]
        # Google profile name, falling back to the email local-part (D5).
        name = (claims.get("name") or "").strip()[:255] or email.split("@", 1)[0]
        if not _EMAIL_RE.match(email):
            logger.warning("Google ID token email failed local validation")
            context.set_code(grpc.StatusCode.UNAUTHENTICATED)
            context.set_details(_GOOGLE_FAIL_DETAIL)
            return auth_pb2.AuthResponse()

        # Verification succeeded — only now is the DB touched.
        with db_session(self.engine) as session:
            # (a) Returning Google user: match on google_sub, no email logic.
            user = session.execute(
                select(User).where(User.google_sub == sub)
            ).scalar_one_or_none()
            if user is None:
                # (b) Auto-link: an existing account with this email and no
                # Google link yet. email_verified=true was enforced above.
                user = session.execute(
                    select(User).where(User.email == email)
                ).scalar_one_or_none()
                if user is not None:
                    if user.google_sub is not None:
                        # Already linked to a DIFFERENT Google account —
                        # refuse without modifying anything.
                        logger.warning("GoogleAuth link conflict for %s", email)
                        context.set_code(grpc.StatusCode.UNAUTHENTICATED)
                        context.set_details(_GOOGLE_FAIL_DETAIL)
                        return auth_pb2.AuthResponse()
                    user.google_sub = sub
            if user is None:
                # (c) New user: no password, verified (Google did), free plan.
                user = User(
                    email=email,
                    password_hash=None,
                    name=name,
                    plan="free",
                    is_verified=True,
                    google_sub=sub,
                )
                session.add(user)
                session.flush()

            return self._auth_response_for(session, user)

    def Register(self, request, context):
        email = request.email.strip().lower()
        password = request.password
        name = request.name.strip()

        if not email or not _EMAIL_RE.match(email):
            context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
            context.set_details("Invalid email")
            return auth_pb2.AuthResponse()

        if not password or len(password) < 8:
            context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
            context.set_details("Password must be at least 8 characters")
            return auth_pb2.AuthResponse()

        if not name:
            context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
            context.set_details("Name is required")
            return auth_pb2.AuthResponse()

        with db_session(self.engine) as session:
            existing = session.execute(select(User).where(User.email == email)).scalar_one_or_none()
            if existing:
                context.set_code(grpc.StatusCode.ALREADY_EXISTS)
                context.set_details("Email already registered")
                return auth_pb2.AuthResponse()

            password_hash = pwd_context.hash(_bcrypt_truncate(password))
            user = User(email=email, password_hash=password_hash, name=name, plan="free", is_verified=False)
            session.add(user)
            session.flush()

            access_token, expires_at = issue_access_token(user.id, user.email, user.plan)
            raw_refresh, refresh_hash, refresh_expires = issue_refresh_token()
            rt = RefreshToken(
                user_id=user.id,
                token_hash=refresh_hash,
                expires_at=datetime.fromtimestamp(refresh_expires, tz=UTC),
            )
            session.add(rt)

            return auth_pb2.AuthResponse(
                access_token=access_token,
                refresh_token=raw_refresh,
                expires_at=expires_at,
                user=auth_pb2.User(
                    id=user.id,
                    email=user.email,
                    name=user.name,
                    plan=user.plan,
                    is_verified=user.is_verified,
                    created_at=user.created_at.isoformat(),
                ),
            )

    def Login(self, request, context):
        email = request.email.strip().lower()
        password = request.password

        with db_session(self.engine) as session:
            user = session.execute(select(User).where(User.email == email)).scalar_one_or_none()
            # Google-only accounts have a NULL password_hash (easier-auth):
            # they can never password-login and get the SAME generic
            # "invalid credentials" as a wrong password — no enumeration.
            # (passlib's verify() would also return False for a None hash;
            # the explicit check keeps that contract independent of passlib.)
            if (
                not user
                or not user.password_hash
                or not pwd_context.verify(_bcrypt_truncate(password), user.password_hash)
            ):
                context.set_code(grpc.StatusCode.UNAUTHENTICATED)
                context.set_details("invalid credentials")
                return auth_pb2.AuthResponse()

            access_token, expires_at = issue_access_token(user.id, user.email, user.plan)
            raw_refresh, refresh_hash, refresh_expires = issue_refresh_token()
            rt = RefreshToken(
                user_id=user.id,
                token_hash=refresh_hash,
                expires_at=datetime.fromtimestamp(refresh_expires, tz=UTC),
            )
            session.add(rt)

            return auth_pb2.AuthResponse(
                access_token=access_token,
                refresh_token=raw_refresh,
                expires_at=expires_at,
                user=auth_pb2.User(
                    id=user.id,
                    email=user.email,
                    name=user.name,
                    plan=user.plan,
                    is_verified=user.is_verified,
                    created_at=user.created_at.isoformat(),
                ),
            )

    def Verify(self, request, context):
        payload = verify_access_token(request.token)
        if payload is None:
            return auth_pb2.VerifyResponse(valid=False)
        # The plan claim in the JWT is refreshed at issue time, but a user can
        # change plan mid-token. Read the CURRENT plan from the users table so
        # callers (e.g. the monolith cloud binding) always store the real plan;
        # fall back to the token claims if the user row is gone.
        plan = payload.get("plan", "")
        try:
            with db_session(self.engine) as session:
                user = session.execute(
                    select(User).where(User.id == payload["sub"])
                ).scalar_one_or_none()
                if user is not None:
                    plan = user.plan
        except Exception as exc:
            # DB unavailable — serve the token claims rather than fail Verify.
            logger.warning(
                "Could not read current plan for user %s — serving token claims: %s",
                payload.get("sub"), exc,
            )
        return auth_pb2.VerifyResponse(
            valid=True,
            user_id=payload["sub"],
            email=payload["email"],
            plan=plan,
        )

    def Refresh(self, request, context):
        raw = request.refresh_token
        token_hash = hashlib.sha256(raw.encode()).hexdigest()

        with db_session(self.engine) as session:
            rt = session.execute(
                select(RefreshToken).where(RefreshToken.token_hash == token_hash)
            ).scalar_one_or_none()

            if not rt:
                context.set_code(grpc.StatusCode.UNAUTHENTICATED)
                context.set_details("invalid refresh token")
                return auth_pb2.AuthResponse()

            if rt.revoked_at is not None:
                # Reuse detection: revoke all tokens for this user
                session.query(RefreshToken).filter(RefreshToken.user_id == rt.user_id).update(
                    {"revoked_at": datetime.now(UTC)}
                )
                context.set_code(grpc.StatusCode.UNAUTHENTICATED)
                context.set_details("refresh token reused")
                return auth_pb2.AuthResponse()

            expires_at = rt.expires_at.replace(tzinfo=None) if rt.expires_at.tzinfo else rt.expires_at
            if expires_at < datetime.now(UTC).replace(tzinfo=None):
                context.set_code(grpc.StatusCode.UNAUTHENTICATED)
                context.set_details("refresh token expired")
                return auth_pb2.AuthResponse()

            # Rotation: revoke old, create new (keep row for reuse detection)
            user_id = rt.user_id
            rt.revoked_at = datetime.now(UTC)
            user = session.execute(select(User).where(User.id == user_id)).scalar_one()

            access_token, expires_at = issue_access_token(user.id, user.email, user.plan)
            new_raw, new_hash, new_expires = issue_refresh_token()
            new_rt = RefreshToken(
                user_id=user.id,
                token_hash=new_hash,
                expires_at=datetime.fromtimestamp(new_expires, tz=UTC),
            )
            session.add(new_rt)

            return auth_pb2.AuthResponse(
                access_token=access_token,
                refresh_token=new_raw,
                expires_at=expires_at,
                user=auth_pb2.User(
                    id=user.id,
                    email=user.email,
                    name=user.name,
                    plan=user.plan,
                    is_verified=user.is_verified,
                    created_at=user.created_at.isoformat(),
                ),
            )

    def Logout(self, request, context):
        with db_session(self.engine) as session:
            session.query(RefreshToken).filter(RefreshToken.user_id == request.user_id).delete()
        return common_pb2.StatusResponse(success=True)
