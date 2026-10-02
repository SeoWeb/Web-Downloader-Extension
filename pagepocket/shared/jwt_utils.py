"""JWT utility functions for HS256 access/refresh token management."""

import hashlib
import os
import secrets
import time

import jwt

JWT_SECRET = os.environ["JWT_SECRET"]
ACCESS_TOKEN_EXPIRY = 7 * 24 * 3600  # 7 days
REFRESH_TOKEN_EXPIRY = 30 * 24 * 3600  # 30 days


def issue_access_token(user_id: str, email: str, plan: str) -> tuple[str, int]:
    """Issue an HS256 JWT access token. Returns (token, expires_at_unix)."""
    now = int(time.time())
    expires_at = now + ACCESS_TOKEN_EXPIRY
    payload = {
        "sub": user_id,
        "email": email,
        "plan": plan,
        "iat": now,
        "exp": expires_at,
    }
    token = jwt.encode(payload, JWT_SECRET, algorithm="HS256")
    return token, expires_at


def issue_refresh_token() -> tuple[str, str, int]:
    """Issue a refresh token. Returns (raw_token, sha256_hash, expires_at_unix)."""
    raw = secrets.token_urlsafe(48)
    token_hash = hashlib.sha256(raw.encode()).hexdigest()
    expires_at = int(time.time()) + REFRESH_TOKEN_EXPIRY
    return raw, token_hash, expires_at


def verify_access_token(token: str) -> dict | None:
    """Decode and verify an access token. Returns payload or None."""
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except (jwt.ExpiredSignatureError, jwt.InvalidTokenError):
        return None
