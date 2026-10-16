"""Redis-backed rate limiting middleware.

Fixed-window counters (INCR + bounded EXPIRE) in Redis replace the previous
per-worker in-memory dicts, so limits are shared across workers and key memory
is bounded by the window expiry.

Identity:
- authenticated routes  → ``user:{user_id}`` (600/min)
- /api/v1/auth/* routes → ``ip:{client}``   (20/min)
- /api/v1/share/public/* routes → ``ip:{client}`` (20/min, same class as auth)

The client IP is derived spoof-proof (D3, mirroring the monolith's
implementation): walk ``X-Forwarded-For`` right-to-left and take the first
entry NOT matching TRUSTED_PROXIES (a trusted proxy appends what it observed,
so attacker-supplied leftmost entries cannot rotate the bucket);
``CF-Connecting-IP`` is honored only when the immediate peer is trusted AND no
untrusted XFF entry remains. Without a trusted peer the connection peer address
is used.

Failure semantics: if Redis is unreachable the limiter fails OPEN (availability
over strictness), logs an error, reports ``degraded`` via the ``healthy`` flag
(surfaced by /api/v1/health), and retries Redis after a short cooldown instead
of stalling every request.
"""

import ipaddress
import logging
import os
import time

from config import trusted_proxies as parse_trusted_proxies
from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

logger = logging.getLogger(__name__)

AUTH_LIMIT_PER_WINDOW = 20
SHARE_PUBLIC_LIMIT_PER_WINDOW = AUTH_LIMIT_PER_WINDOW  # same 20/min class
AUTHENTICATED_LIMIT_PER_WINDOW = 600
WINDOW_SECONDS = 60

# While the limiter is marked down it stops contacting Redis for this long
# (requests fail open in the interim), so a dead Redis cannot add latency to
# every request or flood the logs.
FAILURE_COOLDOWN_SECONDS = 5.0

_KEY_PREFIX = "ratelimit"


def client_ip_for_request(request: Request, trusted_proxies: tuple[str, ...] = ()) -> str:
    """Spoof-proof real client IP (D3, mirrors the monolith's derivation).

    - ``X-Forwarded-For`` is considered only when the immediate peer is a
      configured TRUSTED_PROXIES entry, and is walked RIGHT to LEFT: the first
      entry not itself matching TRUSTED_PROXIES is the client. A trusted proxy
      appends the address it observed, so attacker-supplied leftmost entries
      cannot rotate the limit key.
    - ``CF-Connecting-IP`` is honored only when the immediate peer is trusted
      AND no untrusted XFF entry remains.
    - Otherwise the connection peer address is used.
    """
    peer = request.client.host if request.client else "unknown"
    peer_trusted = _peer_is_trusted(request, trusted_proxies)

    cf_ip = (request.headers.get("cf-connecting-ip") or "").strip()

    xff = request.headers.get("x-forwarded-for") or ""
    entries = [entry.strip() for entry in xff.split(",") if entry.strip()]

    if peer_trusted and entries:
        untrusted_entry = None
        for entry in reversed(entries):
            if not _addr_is_trusted(entry, trusted_proxies):
                untrusted_entry = entry
                break

        if untrusted_entry is not None:
            return untrusted_entry

        # Only trusted proxies appear in XFF: no untrusted entry remains, so
        # the trusted edge's CF-Connecting-IP wins; without it, the rightmost
        # entry (what the nearest trusted hop appended) is the best remaining
        # candidate — never the peer address, which is just the last proxy.
        if cf_ip:
            return cf_ip
        return entries[-1]

    if peer_trusted and cf_ip:
        return cf_ip

    return peer


def _addr_is_trusted(addr: str, trusted_proxies: tuple[str, ...]) -> bool:
    """Whether an XFF entry (or peer address) matches the trust list.

    Unparseable entries are never trusted — garbage cannot vouch for itself.
    """
    try:
        addr_ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    for entry in trusted_proxies:
        try:
            if "/" in entry:
                if addr_ip in ipaddress.ip_network(entry, strict=False):
                    return True
            elif addr_ip == ipaddress.ip_address(entry):
                return True
        except ValueError:
            continue
    return False


def _peer_is_trusted(request: Request, trusted_proxies: tuple[str, ...]) -> bool:
    peer = request.client.host if request.client else ""
    if not peer:
        return False
    return _addr_is_trusted(peer, trusted_proxies)


class RedisRateLimiter:
    """Fixed-window counter in Redis; fails open when Redis is unavailable."""

    def __init__(
        self,
        redis_url: str | None = None,
        client=None,
        *,
        window: int = WINDOW_SECONDS,
        failure_cooldown: float = FAILURE_COOLDOWN_SECONDS,
        clock=time.monotonic,
    ):
        self._redis_url = os.environ.get("REDIS_URL") if redis_url is None else redis_url
        self._client = client  # injection point for tests (fakeredis)
        self.window = window
        self._failure_cooldown = failure_cooldown
        self._clock = clock
        self.healthy = True
        self._down_until = 0.0
        self._down_reason: str | None = None

    # -- health -----------------------------------------------------------

    @property
    def health(self) -> str:
        return "ok" if self.healthy else "degraded"

    # -- core -------------------------------------------------------------

    def _get_client(self):
        if self._client is not None:
            return self._client
        if not self._redis_url:
            return None
        import redis

        # Short socket timeouts: a hung Redis must not stall requests.
        self._client = redis.Redis.from_url(
            self._redis_url,
            decode_responses=True,
            socket_connect_timeout=1,
            socket_timeout=1,
        )
        return self._client

    def check(self, kind: str, identity: str, limit: int) -> bool:
        """Record a hit and return whether the caller is within the limit."""
        now = self._clock()
        if now < self._down_until:
            return True  # fail open while marked down

        try:
            client = self._get_client()
            if client is None:
                self._mark_down(now, "REDIS_URL not set — rate limiting disabled")
                return True

            key = f"{_KEY_PREFIX}:{kind}:{identity}"
            pipe = client.pipeline(transaction=True)
            pipe.incr(key)
            pipe.ttl(key)
            count, ttl = pipe.execute()

            if int(ttl) < 0:
                # Fresh key (or a key that lost its TTL): (re-)arm the bounded
                # expiry so no counter can outlive the window.
                client.expire(key, self.window)

            self._mark_up()
            return int(count) <= limit
        except Exception as exc:  # noqa: BLE001 — any Redis failure fails open
            self._mark_down(now, exc)
            return True

    def _mark_down(self, now: float, reason) -> None:
        was_healthy = self.healthy
        self.healthy = False
        self._down_until = now + self._failure_cooldown
        self._down_reason = str(reason)
        # One loud error per outage episode, not one per request.
        if was_healthy:
            logger.error("Rate limiter unavailable (%s) — failing OPEN until Redis recovers", reason)

    def _mark_up(self) -> None:
        self.healthy = True
        self._down_until = 0.0
        self._down_reason = None


class RateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(
        self,
        app,
        limiter: RedisRateLimiter | None = None,
        auth_limit: int = AUTH_LIMIT_PER_WINDOW,
        authenticated_limit: int = AUTHENTICATED_LIMIT_PER_WINDOW,
        share_public_limit: int = SHARE_PUBLIC_LIMIT_PER_WINDOW,
        window: int = WINDOW_SECONDS,
        trusted_proxies: tuple[str, ...] = (),
    ):
        super().__init__(app)
        self.limiter = limiter if limiter is not None else RedisRateLimiter(window=window)
        self.auth_limit = auth_limit
        self.authenticated_limit = authenticated_limit
        self.share_public_limit = share_public_limit
        self.window = window
        self.trusted_proxies = trusted_proxies if trusted_proxies else parse_trusted_proxies()

    def _rate_limited(self):
        return JSONResponse(
            status_code=429,
            content={"detail": "Rate limit exceeded", "api_version": "v1"},
            headers={"Retry-After": str(self.window)},
        )

    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        # Health check exempt
        if path == "/api/v1/health":
            return await call_next(request)

        # Auth routes: per-client-IP limit (real client IP, not the proxy's)
        if path.startswith("/api/v1/auth/"):
            ip = client_ip_for_request(request, self.trusted_proxies)
            if not self.limiter.check("ip", ip, self.auth_limit):
                return self._rate_limited()

        # Public share routes (D3): unauthenticated asset/viewer traffic with
        # a DB write per hit — same 20/min per-IP class as the auth routes.
        elif path.startswith("/api/v1/share/public/"):
            ip = client_ip_for_request(request, self.trusted_proxies)
            if not self.limiter.check("ip", ip, self.share_public_limit):
                return self._rate_limited()

        # Authenticated routes: per-user limit
        elif hasattr(request.state, "user_id"):
            if not self.limiter.check("user", request.state.user_id, self.authenticated_limit):
                return self._rate_limited()

        return await call_next(request)
