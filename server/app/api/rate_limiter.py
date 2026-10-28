"""Simple in-memory token bucket rate limiter."""

import logging
import time
from collections import defaultdict

from app.config import settings

logger = logging.getLogger(__name__)


class TokenBucket:
    """Token bucket rate limiter for a single key."""

    def __init__(self, rate: float, capacity: int):
        """Initialize token bucket.

        Args:
            rate: Tokens added per second.
            capacity: Maximum number of tokens (burst size).
        """
        self.rate = rate
        self.capacity = capacity
        self.tokens: float = capacity
        self.last_refill: float = time.monotonic()

    def consume(self, tokens: int = 1) -> bool:
        """Try to consume tokens. Returns True if allowed."""
        now = time.monotonic()
        elapsed = now - self.last_refill
        self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)
        self.last_refill = now

        if self.tokens >= tokens:
            self.tokens -= tokens
            return True
        return False

    def retry_after_seconds(self) -> float:
        """Estimate seconds until one token is available."""
        if self.tokens >= 1:
            return 0.0
        deficit = 1.0 - self.tokens
        return deficit / self.rate


class RateLimiter:
    """In-memory rate limiter using token buckets per key.

    Not suitable for multi-process deployments; use Redis-backed limiter
    for production multi-worker setups. For single-server Docker deployment
    this is sufficient.

    Stale buckets are pruned automatically when ``cleanup_if_needed()`` is
    called.  The check is cheap (a timestamp comparison) so it can be called
    on every ``is_allowed()`` invocation.
    """

    # Prune buckets whose last activity is older than this many seconds
    _BUCKET_MAX_AGE: float = 600.0  # 10 minutes
    # Run cleanup at most once per this many calls to is_allowed()
    _CLEANUP_INTERVAL: int = 100

    def __init__(self, rate: float, capacity: int):
        """Initialize rate limiter.

        Args:
            rate: Requests per second allowed per key.
            capacity: Maximum burst size per key.
        """
        self.rate = rate
        self.capacity = capacity
        self._buckets: dict[str, TokenBucket] = defaultdict(
            lambda: TokenBucket(self.rate, self.capacity)
        )
        self._last_cleanup: float = time.monotonic()
        self._call_count: int = 0

    def is_allowed(self, key: str, tokens: int = 1) -> tuple[bool, float]:
        """Check if request is allowed for the given key.

        Returns:
            Tuple of (allowed: bool, retry_after_seconds: float).
        """
        self._call_count += 1
        self.cleanup_if_needed()

        bucket = self._buckets[key]
        allowed = bucket.consume(tokens)
        retry_after = 0.0 if allowed else bucket.retry_after_seconds()
        return allowed, retry_after

    def cleanup_if_needed(self) -> int:
        """Remove buckets that have been idle longer than ``_BUCKET_MAX_AGE``.

        Called automatically by ``is_allowed()``; can also be called manually.

        This does NOT advance ``_call_count`` — only ``is_allowed()``
        increments it — so pruning fires exactly once per
        ``_CLEANUP_INTERVAL`` ``is_allowed()`` calls (~every 100 calls),
        not twice as often.

        Returns:
            Number of buckets removed.
        """
        if self._call_count % self._CLEANUP_INTERVAL != 0:
            return 0

        now = time.monotonic()
        stale_keys = [
            k
            for k, b in self._buckets.items()
            if now - b.last_refill > self._BUCKET_MAX_AGE
        ]
        for k in stale_keys:
            del self._buckets[k]

        if stale_keys:
            logger.debug(
                "Pruned %d stale rate-limiter buckets (remaining: %d)",
                len(stale_keys),
                len(self._buckets),
            )
        return len(stale_keys)


# Pre-configured rate limiters
# Registration: 5 requests/minute per IP = 5/60 per second, burst of 5
registration_limiter = RateLimiter(rate=5 / 60, capacity=5)

# Registration per extension instance id (7.8): at most
# ``registration_per_instance_daily_limit`` registration attempts per
# instance id per day. Burst == limit; the refill rate spreads the budget
# over 24 hours so a persistent id gets roughly N fresh attempts per day.
_registration_instance_daily = max(
    1, settings.registration_per_instance_daily_limit
)
registration_instance_limiter = RateLimiter(
    rate=_registration_instance_daily / 86400,
    capacity=_registration_instance_daily,
)

# Resource uploads: 60 requests/second per session, burst of 100
# The extension uploads resources in bursts (5 concurrent workers uploading
# small files can easily exceed 10 req/sec). Since this is a trusted
# extension (not a public API), the limit is generous to avoid 429 retries
# that slow down the overall download pipeline.
resource_upload_limiter = RateLimiter(rate=60, capacity=100)
