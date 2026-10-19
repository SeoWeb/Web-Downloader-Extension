"""Signed asset-token validation for the archive file route (fix E).

The sandboxed viewer iframe runs on an opaque origin, so its CORS-mode
subresource loads (crossorigin tags, webfonts) cannot send credentials —
they hit the authed archive file route with no Bearer header and would all
401 (surfacing in the browser as a CORS error). Instead, the BFF mints a
bounded HMAC "asset token" and places it in an extra path segment right
after /f/; the gateway validates it as an alternative credential on THAT
route only.

Token format (the BFF mints; the gateway only validates — never re-mint):

    payload_b64url + "." + mac_b64url

- payload_b64url: base64url (unpadded) of the compact JSON
  ``{"p": <page_id>, "u": <user_id>, "e": <exp_epoch_seconds>}``
- mac_b64url: HMAC-SHA256(key=ASSET_TOKEN_SECRET, msg=payload_b64url),
  base64url unpadded

The expiry is bucketed by the minting side (with TTL = ASSET_TOKEN_TTL
_SECONDS, default 604800: ``e = (floor(now / TTL) + 2) * TTL``) so tokens
are deterministic within the current bucket and stay valid through the end
of the next one — validation only checks ``e`` against the wall clock. An
empty ASSET_TOKEN_SECRET disables the feature entirely: every token
verification fails closed, and Bearer authentication is unaffected.
"""

import base64
import hashlib
import hmac
import json
import re
import time

# Full request path (AuthMiddleware): the token rides an extra segment right
# after /f/ — /api/v1/archive/pages/{page}/f/at/{token}/{rest}. The token
# shape is deliberately just "b64url.b64url"; a stronger shape check happens
# cryptographically at verification time.
ASSET_TOKEN_PATH_RE = re.compile(
    r"^/api/v1/archive/pages/(?P<page>[^/]+)/f/at/"
    r"(?P<tok>[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/(?P<rest>.+)$"
)

# Route-param shape (routers/archive.py): a leading `at/{token}/` segment
# inside the {file_path:path} parameter — same token shape as above.
ASSET_TOKEN_SEGMENT_RE = re.compile(r"^at/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/")


def strip_asset_token_segment(file_path: str) -> str:
    """Drop ONE leading ``at/{token}/`` segment matching the token shape.

    Token-authenticated requests carry the credential INSIDE file_path; this
    recovers the real archived path before any upstream fetch (both the
    primary GetArchiveFile call and its assets/ fallback retry). Paths
    without the leading segment — the overwhelmingly common case, including
    every plain-Bearer request — pass through unchanged.
    """
    return ASSET_TOKEN_SEGMENT_RE.sub("", file_path, count=1)


def _b64url_decode(part: str) -> bytes:
    """Strict base64url (no padding) decode; raises ValueError on junk."""
    padded = part.replace("-", "+").replace("_", "/") + "=" * (-len(part) % 4)
    return base64.b64decode(padded, validate=True)


def verify_asset_token(token: str, *, page_id: str, secret: str, now: int | None = None) -> str | None:
    """Validate a signed asset token; return the embedded user_id, or None.

    Fails closed on EVERY problem: empty secret (feature disabled), wrong
    shape, undecodable payload/MAC, MAC mismatch (constant-time compare),
    non-dict payload, missing or mismatched page binding, empty user, or a
    non-integer/expired ``e``. Returns the token's ``u`` on success only.
    """
    if not secret:
        return None

    payload_b64, sep, mac_b64 = token.partition(".")
    if not sep or not payload_b64 or not mac_b64:
        return None
    if now is None:
        now = int(time.time())

    try:
        # The MAC message is the payload STRING exactly as sent — never a
        # re-encoding of the decoded JSON.
        expected_mac = hmac.new(
            secret.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256
        ).digest()
        if not hmac.compare_digest(expected_mac, _b64url_decode(mac_b64)):
            return None
        payload = json.loads(_b64url_decode(payload_b64))
    except (ValueError, UnicodeEncodeError):
        return None

    if not isinstance(payload, dict):
        return None
    user_id = payload.get("u")
    expiry = payload.get("e")
    if payload.get("p") != page_id:
        return None
    if not isinstance(user_id, str) or not user_id:
        return None
    # bool is an int subclass — exclude it explicitly so `e: true` cannot
    # masquerade as epoch second 1.
    if isinstance(expiry, bool) or not isinstance(expiry, int) or expiry <= now:
        return None
    return user_id
