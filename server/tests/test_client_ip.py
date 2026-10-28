"""Pins for ``get_client_ip`` limiter-key resolution.

server-assembly-honesty 5.1 (D6): client-IP limiter keys SHALL come from the
peer address by default; only when ``TRUST_PROXY`` is enabled SHALL the
rightmost ``X-Forwarded-For`` entry be used, with the peer address as
fallback when the header is absent or malformed.

This behavior predates the change (harden-backend-security-and-ops 7.8) and
is unchanged by it — these tests pin the contract so the proxy-key semantics
cannot drift while the surrounding registration-limiting work lands.
"""

import pytest
from starlette.requests import Request

PEER = ("203.0.113.7", 44344)


def _make_request(headers=None, peer=PEER):
    """Build a minimal starlette Request (same shape as test_auth_security)."""
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/api/v1/auth/register",
        "headers": [
            (k.lower().encode(), v.encode()) for k, v in (headers or {}).items()
        ],
        "query_string": b"",
        "client": peer,
        "server": ("testserver", 80),
        "scheme": "http",
    }
    return Request(scope)


class TestGetClientIp:
    def test_peer_used_when_trust_proxy_off(self, monkeypatch):
        """XFF present but TRUST_PROXY off → the peer address is the key
        (honoring a spoofable header would let anyone rotate their limit)."""
        from app.api.routes.auth import get_client_ip

        monkeypatch.setattr("app.config.settings.trust_proxy", False)
        req = _make_request(
            headers={"X-Forwarded-For": "198.51.100.9, 198.51.100.10"},
        )
        assert get_client_ip(req) == "203.0.113.7"

    def test_rightmost_xff_entry_used_when_trust_proxy_on(self, monkeypatch):
        """TRUST_PROXY on: 'client, proxy' → the rightmost entry — the one
        the trusted proxy appended — is the key."""
        from app.api.routes.auth import get_client_ip

        monkeypatch.setattr("app.config.settings.trust_proxy", True)
        req = _make_request(
            headers={"X-Forwarded-For": "198.51.100.9, 198.51.100.10"},
        )
        assert get_client_ip(req) == "198.51.100.10"

    def test_rightmost_entry_is_whitespace_stripped(self, monkeypatch):
        from app.api.routes.auth import get_client_ip

        monkeypatch.setattr("app.config.settings.trust_proxy", True)
        req = _make_request(headers={"X-Forwarded-For": "9.9.9.9,  10.0.0.1 "})
        assert get_client_ip(req) == "10.0.0.1"

    def test_peer_fallback_when_header_absent_and_trusting(self, monkeypatch):
        """TRUST_PROXY on but no X-Forwarded-For (direct client) → peer."""
        from app.api.routes.auth import get_client_ip

        monkeypatch.setattr("app.config.settings.trust_proxy", True)
        assert get_client_ip(_make_request()) == "203.0.113.7"

    @pytest.mark.parametrize("malformed", ["", ",", " , ", "   "])
    def test_peer_fallback_when_header_malformed(
        self, monkeypatch, malformed
    ):
        """TRUST_PROXY on but the header carries no usable entry (empty,
        bare commas, whitespace-only) → peer fallback, never an empty key."""
        from app.api.routes.auth import get_client_ip

        monkeypatch.setattr("app.config.settings.trust_proxy", True)
        req = _make_request(headers={"X-Forwarded-For": malformed})
        assert get_client_ip(req) == "203.0.113.7"

    def test_unknown_peer_when_scope_has_no_client(self, monkeypatch):
        """No peer in the ASGI scope and no header → the 'unknown' bucket
        (degraded but harmless: all such clients share one key)."""
        from app.api.routes.auth import get_client_ip

        monkeypatch.setattr("app.config.settings.trust_proxy", True)
        assert get_client_ip(_make_request(peer=None)) == "unknown"
