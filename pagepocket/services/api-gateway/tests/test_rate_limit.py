"""Unit tests for the Redis-backed rate limiter (task 4.5).

Runs against fakeredis (no live stack): fixed-window semantics with bounded
expiries, real-client-IP keying behind a proxy (the global-bucket regression),
per-user keying when authenticated, fail-open + degraded health on Redis
outage, and recovery after the failure cooldown.
"""

import time
import unittest

import fakeredis
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from middleware.rate_limit import (
    AUTH_LIMIT_PER_WINDOW,
    AUTHENTICATED_LIMIT_PER_WINDOW,
    WINDOW_SECONDS,
    RateLimitMiddleware,
    RedisRateLimiter,
    client_ip_for_request,
)
from routers.health import build_health_router


class _DownRedis:
    """Stands in for an unreachable Redis: every command raises."""

    def pipeline(self, *args, **kwargs):
        raise ConnectionError("Redis is down")


class _FlakyRedis(fakeredis.FakeStrictRedis):
    """Fails while `down`, else behaves as a real fakeredis client."""

    def __init__(self):
        super().__init__()
        self.down = True

    def pipeline(self, *args, **kwargs):
        if self.down:
            raise ConnectionError("Redis is down")
        return super().pipeline(*args, **kwargs)


class TestWindowSemantics(unittest.TestCase):
    def setUp(self):
        self.client = fakeredis.FakeStrictRedis()
        self.limiter = RedisRateLimiter(client=self.client)

    def test_limit_allows_n_then_denies(self):
        for _ in range(AUTH_LIMIT_PER_WINDOW):
            self.assertTrue(self.limiter.check("ip", "1.2.3.4", AUTH_LIMIT_PER_WINDOW))
        self.assertFalse(self.limiter.check("ip", "1.2.3.4", AUTH_LIMIT_PER_WINDOW))

    def test_authenticated_limit_is_higher(self):
        self.assertGreater(AUTHENTICATED_LIMIT_PER_WINDOW, AUTH_LIMIT_PER_WINDOW)
        for _ in range(AUTHENTICATED_LIMIT_PER_WINDOW):
            self.assertTrue(self.limiter.check("user", "u1", AUTHENTICATED_LIMIT_PER_WINDOW))
        self.assertFalse(self.limiter.check("user", "u1", AUTHENTICATED_LIMIT_PER_WINDOW))

    def test_counter_key_has_bounded_expiry(self):
        """Every key must carry a TTL within the window (bounded memory)."""
        self.limiter.check("ip", "1.2.3.4", 20)
        ttl = self.client.ttl("ratelimit:ip:1.2.3.4")
        self.assertGreater(ttl, 0)
        self.assertLessEqual(ttl, WINDOW_SECONDS)

    def test_key_rearmed_when_ttl_lost(self):
        """A key that lost its TTL must not become an immortal counter."""
        self.limiter.check("ip", "1.2.3.4", 20)
        self.client.persist("ratelimit:ip:1.2.3.4")  # simulate TTL loss
        self.assertEqual(self.client.ttl("ratelimit:ip:1.2.3.4"), -1)
        self.limiter.check("ip", "1.2.3.4", 20)  # re-arms the expiry
        self.assertGreater(self.client.ttl("ratelimit:ip:1.2.3.4"), 0)

    def test_window_expiry_resets_the_bucket(self):
        limiter = RedisRateLimiter(client=self.client, window=1)
        self.assertTrue(limiter.check("ip", "1.2.3.4", 1))
        self.assertFalse(limiter.check("ip", "1.2.3.4", 1))  # window full
        time.sleep(1.1)  # fakeredis honours TTLs in real time
        self.assertEqual(self.client.exists("ratelimit:ip:1.2.3.4"), 0)
        self.assertTrue(limiter.check("ip", "1.2.3.4", 1))  # fresh window

    def test_identities_get_independent_buckets(self):
        self.assertTrue(self.limiter.check("ip", "1.2.3.4", 1))
        self.assertFalse(self.limiter.check("ip", "1.2.3.4", 1))
        self.assertTrue(self.limiter.check("ip", "5.6.7.8", 1))

    def test_healthy_while_redis_responds(self):
        self.limiter.check("ip", "1.2.3.4", 20)
        self.assertTrue(self.limiter.healthy)
        self.assertEqual(self.limiter.health, "ok")


class TestFailOpen(unittest.TestCase):
    def test_redis_down_fails_open_and_marks_degraded(self):
        limiter = RedisRateLimiter(client=_DownRedis())
        self.assertTrue(limiter.check("ip", "1.2.3.4", 1))  # request forwarded
        self.assertFalse(limiter.healthy)
        self.assertEqual(limiter.health, "degraded")

    def test_fail_open_does_not_contact_redis_during_cooldown(self):
        flaky = _FlakyRedis()
        limiter = RedisRateLimiter(client=flaky, failure_cooldown=5.0)
        self.assertTrue(limiter.check("ip", "1.2.3.4", 1))
        self.assertFalse(limiter.healthy)

        flaky.down = False  # Redis recovered...
        # ...but within the cooldown the limiter fails open without calling it
        self.assertTrue(limiter.check("ip", "1.2.3.4", 1))
        self.assertFalse(limiter.healthy)

    def test_recovery_after_cooldown(self):
        now = [0.0]
        flaky = _FlakyRedis()
        limiter = RedisRateLimiter(client=flaky, failure_cooldown=5.0, clock=lambda: now[0])
        self.assertTrue(limiter.check("ip", "1.2.3.4", 1))
        self.assertFalse(limiter.healthy)

        now[0] += 6.0  # cooldown elapsed
        flaky.down = False
        self.assertTrue(limiter.check("ip", "1.2.3.4", 1))
        self.assertTrue(limiter.healthy)  # recovered and counting again
        self.assertFalse(limiter.check("ip", "1.2.3.4", 1))  # limit enforced again

    def test_missing_redis_url_fails_open_degraded(self):
        limiter = RedisRateLimiter(redis_url="", client=None)
        self.assertTrue(limiter.check("ip", "1.2.3.4", 1))
        self.assertFalse(limiter.healthy)


class TestClientIpResolution(unittest.TestCase):
    """Task 1.8 / spec "Spoof-Proof Client IP Derivation": rightmost-untrusted
    XFF walk; CF-Connecting-IP only from a trusted peer with no untrusted XFF
    entry beyond it."""

    def _request(self, headers=None, peer="10.0.0.1"):
        scope = {
            "type": "http",
            "method": "GET",
            "path": "/",
            "headers": [
                (k.lower().encode(), v.encode())
                for k, v in (headers or {}).items()
            ],
            "query_string": b"",
            "client": (peer, 12345),
        }
        return Request(scope)

    def test_cf_ignored_from_untrusted_peer(self):
        """An untrusted peer's CF-Connecting-IP must not become the identity."""
        req = self._request({"CF-Connecting-IP": "6.6.6.6"}, peer="192.0.2.50")
        self.assertEqual(client_ip_for_request(req, ("10.0.0.0/8",)), "192.0.2.50")

    def test_cf_used_from_trusted_peer_without_xff(self):
        req = self._request({"CF-Connecting-IP": "203.0.113.7"}, peer="10.0.0.9")
        self.assertEqual(client_ip_for_request(req, ("10.0.0.0/8",)), "203.0.113.7")

    def test_xff_ignored_without_trusted_proxies(self):
        req = self._request({"X-Forwarded-For": "198.51.100.1"})
        self.assertEqual(client_ip_for_request(req, ()), "10.0.0.1")

    def test_rightmost_untrusted_xff_entry_wins(self):
        """Trusted proxy appends the real client: rightmost untrusted entry is
        the identity, the trusted hop entries are skipped."""
        req = self._request(
            {"X-Forwarded-For": "203.0.113.7, 198.51.100.1, 10.0.0.9"},
            peer="10.0.0.9",
        )
        self.assertEqual(client_ip_for_request(req, ("10.0.0.0/8",)), "198.51.100.1")

    def test_leftmost_spoofed_entry_ignored(self):
        """Spec scenario: `1.2.3.4, 203.0.113.7` behind a trusted proxy must
        resolve to 203.0.113.7, never the attacker-supplied leftmost."""
        req = self._request({"X-Forwarded-For": "1.2.3.4, 203.0.113.7"}, peer="10.0.0.9")
        self.assertEqual(client_ip_for_request(req, ("10.0.0.0/8",)), "203.0.113.7")

    def test_spoofed_xff_cannot_rotate_the_bucket(self):
        """Rotating the LEFTMOST (spoofable) XFF value must not change the
        identity the limiter buckets on."""
        proxies = ("10.0.0.0/8",)
        for spoofed in ("1.2.3.4", "5.6.7.8", "9.9.9.9"):
            req = self._request({"X-Forwarded-For": f"{spoofed}, 203.0.113.7"}, peer="10.0.0.9")
            self.assertEqual(client_ip_for_request(req, proxies), "203.0.113.7")

    def test_untrusted_peer_xff_ignored_entirely(self):
        req = self._request({"X-Forwarded-For": "198.51.100.1"}, peer="192.0.2.50")
        self.assertEqual(client_ip_for_request(req, ("10.0.0.0/8",)), "192.0.2.50")

    def test_legit_nginx_chain_resolves_real_client(self):
        """nginx (trusted) forwards `X-Forwarded-For: <real client>` — the
        gateway must recover the client, not the nginx address."""
        req = self._request({"X-Forwarded-For": "203.0.113.7"}, peer="10.0.0.9")
        self.assertEqual(client_ip_for_request(req, ("10.0.0.0/8",)), "203.0.113.7")

    def test_all_trusted_chain_with_cf_prefers_cf_header(self):
        """Only trusted proxies in XFF + trusted peer → CF-Connecting-IP is
        honored (no untrusted entry remains beyond it)."""
        req = self._request(
            {"X-Forwarded-For": "10.0.0.2", "CF-Connecting-IP": "203.0.113.7"},
            peer="10.0.0.9",
        )
        self.assertEqual(client_ip_for_request(req, ("10.0.0.0/8",)), "203.0.113.7")

    def test_all_trusted_chain_without_cf_uses_rightmost_entry(self):
        req = self._request({"X-Forwarded-For": "10.0.0.2"}, peer="10.0.0.9")
        self.assertEqual(client_ip_for_request(req, ("10.0.0.0/8",)), "10.0.0.2")

    def test_garbage_xff_entry_is_never_trusted(self):
        """An unparseable XFF entry cannot vouch for itself as a proxy."""
        req = self._request({"X-Forwarded-For": "not-an-ip"}, peer="10.0.0.9")
        self.assertEqual(client_ip_for_request(req, ("10.0.0.0/8",)), "not-an-ip")

    def test_peer_fallback_without_headers(self):
        self.assertEqual(client_ip_for_request(self._request(), ()), "10.0.0.1")


class TestMiddleware(unittest.TestCase):
    def _build_app(self, limiter, *, auth_limit=3, user_limit=5, share_public_limit=20, trusted_proxies=()):
        app = FastAPI()
        app.add_middleware(
            RateLimitMiddleware,
            limiter=limiter,
            auth_limit=auth_limit,
            authenticated_limit=user_limit,
            share_public_limit=share_public_limit,
            trusted_proxies=trusted_proxies,
        )

        # Simulates AuthMiddleware (outermost, added last): stamps user state.
        @app.middleware("http")
        async def fake_auth(request: Request, call_next):
            if request.headers.get("authorization") == "Bearer tok":
                request.state.user_id = "user-1"
            return await call_next(request)

        @app.get("/api/v1/auth/login")
        async def login():
            return {"ok": True}

        @app.get("/api/v1/archive/pages")
        async def pages():
            return {"pages": []}

        return app

    def test_cf_header_from_untrusted_peer_cannot_rotate_bucket(self):
        """Spec: CF-Connecting-IP from a peer not in TRUSTED_PROXIES must be
        ignored — rotating the header cannot rotate into a fresh bucket."""
        limiter = RedisRateLimiter(client=fakeredis.FakeStrictRedis())
        app = self._build_app(limiter, auth_limit=1)
        with TestClient(app) as client:
            r = client.get("/api/v1/auth/login", headers={"CF-Connecting-IP": "203.0.113.7"})
            self.assertEqual(r.status_code, 200)
            # Same (untrusted) peer bucket — the spoofed CF header changed nothing.
            r = client.get("/api/v1/auth/login", headers={"CF-Connecting-IP": "203.0.113.9"})
            self.assertEqual(r.status_code, 429)
            self.assertIn("Retry-After", r.headers)

    def test_xff_ignored_when_no_trusted_proxies_configured(self):
        """Without TRUSTED_PROXIES, rotating XFF cannot rotate the bucket:
        everything lands in the peer-address bucket."""
        limiter = RedisRateLimiter(client=fakeredis.FakeStrictRedis())
        app = self._build_app(limiter, auth_limit=1)
        with TestClient(app) as client:
            self.assertEqual(client.get("/api/v1/auth/login", headers={"X-Forwarded-For": "1.1.1.1"}).status_code, 200)
            r = client.get("/api/v1/auth/login", headers={"X-Forwarded-For": "2.2.2.2"})
            self.assertEqual(r.status_code, 429)  # same peer bucket, not a fresh XFF bucket

    def test_public_share_routes_limited_per_ip(self):
        """Task 1.11: /api/v1/share/public/* gets its own 20/min-class per-IP
        bucket; a 429 must not forward the request upstream."""
        limiter = RedisRateLimiter(client=fakeredis.FakeStrictRedis())
        app = self._build_app(limiter, auth_limit=1, user_limit=1, share_public_limit=1)
        upstream_hits = []

        @app.get("/api/v1/share/public/{token}")
        async def public_share(token: str):
            upstream_hits.append(token)
            return {"page_id": "p1"}

        with TestClient(app) as client:
            self.assertEqual(client.get("/api/v1/share/public/tok").status_code, 200)
            r = client.get("/api/v1/share/public/tok")
            self.assertEqual(r.status_code, 429)
            self.assertIn("Retry-After", r.headers)
            self.assertEqual(upstream_hits, ["tok"])  # the 429 never reached upstream

    def test_authenticated_routes_keyed_by_user_id(self):
        limiter = RedisRateLimiter(client=fakeredis.FakeStrictRedis())
        app = self._build_app(limiter, user_limit=2)
        with TestClient(app) as client:
            headers = {"Authorization": "Bearer tok"}
            for _ in range(2):
                r = client.get("/api/v1/archive/pages", headers=headers)
                self.assertEqual(r.status_code, 200)
            r = client.get("/api/v1/archive/pages", headers=headers)
            self.assertEqual(r.status_code, 429)

    def test_health_endpoint_exempt_from_limiting(self):
        limiter = RedisRateLimiter(client=fakeredis.FakeStrictRedis())
        app = self._build_app(limiter, auth_limit=0)  # deny everything
        app.include_router(build_health_router(limiter))
        with TestClient(app) as client:
            r = client.get("/api/v1/health")
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.json()["rate_limiter"], "ok")

    def test_health_reports_degraded_when_redis_down(self):
        limiter = RedisRateLimiter(client=_DownRedis())
        app = self._build_app(limiter)
        app.include_router(build_health_router(limiter))
        with TestClient(app) as client:
            r = client.get("/api/v1/auth/login", headers={"CF-Connecting-IP": "1.2.3.4"})
            self.assertEqual(r.status_code, 200)  # fail open
            r = client.get("/api/v1/health")
            self.assertEqual(r.json()["rate_limiter"], "degraded")

    def test_rate_limited_response_shape(self):
        limiter = RedisRateLimiter(client=fakeredis.FakeStrictRedis())
        app = self._build_app(limiter, user_limit=0)
        with TestClient(app) as client:
            r = client.get("/api/v1/archive/pages", headers={"Authorization": "Bearer tok"})
            self.assertEqual(r.status_code, 429)
            self.assertEqual(r.json()["api_version"], "v1")
            self.assertIn("Retry-After", r.headers)


if __name__ == "__main__":
    unittest.main()
