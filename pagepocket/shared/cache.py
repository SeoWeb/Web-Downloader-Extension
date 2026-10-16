"""Redis cache helper with graceful degradation.

D13 (design note d): the old one-shot ``_checked`` latch meant a Redis blip
during boot permanently disabled caching for the life of the process. The
client now retries the health probe with capped exponential backoff, so the
cache degrades while Redis is down and recovers on its own. The connect log
never includes the URL (it carries the password) — host:port/db only — and
a hung Redis can't stall callers (short socket timeouts, mirrored from the
gateway's rate limiter).
"""

import json
import logging
import os
import time
from typing import Any
from urllib.parse import urlsplit

import redis

logger = logging.getLogger(__name__)

_client: redis.Redis | None = None
# Probe bookkeeping for the degrad/retry loop (no one-shot latch: a boot
# blip must not disable caching permanently).
_last_attempt = 0.0
_retry_delay = _RETRY_MIN_S = 2.0
_RETRY_MAX_S = 60.0
_logged_no_url = False


def _redacted_target(url: str) -> str:
    """host:port/db for logging — NEVER the passworded URL itself."""
    try:
        parts = urlsplit(url)
        host = parts.hostname or "?"
        target = f"{host}:{parts.port}" if parts.port else host
        return f"{target}{parts.path or '/0'}"
    except ValueError:
        return "<unparseable redis url>"


def _get_client() -> redis.Redis | None:
    global _client, _last_attempt, _retry_delay
    if _client is not None:
        return _client
    now = time.monotonic()
    if now - _last_attempt < _retry_delay:
        return None  # still inside the backoff window after a failed probe
    _last_attempt = now

    url = os.environ.get("REDIS_URL")
    if not url:
        global _logged_no_url
        if not _logged_no_url:
            _logged_no_url = True
            logger.info("REDIS_URL not set — caching disabled")
        return None

    try:
        # Short socket timeouts: a hung Redis must not stall requests
        # (mirrors middleware/rate_limit.py's limiter client).
        client = redis.from_url(
            url,
            decode_responses=True,
            socket_connect_timeout=1,
            socket_timeout=1,
        )
        client.ping()
        _client = client
        _retry_delay = _RETRY_MIN_S  # recovered — probe immediately next time
        logger.info("Connected to Redis at %s", _redacted_target(url))
        return _client
    except Exception as exc:
        _client = None
        # Backoff before the next probe; the cache stays degradable, not off.
        _retry_delay = min(_retry_delay * 2, _RETRY_MAX_S)
        logger.warning(
            "Redis unavailable (%s) — caching degraded, retrying in %.0fs",
            exc,
            _retry_delay,
        )
        return None


def _drop_client() -> None:
    """Forget a client after an operation error so the probe can re-dial."""
    global _client
    _client = None


def cache_get(key: str) -> Any | None:
    """Get a cached value. Returns None on miss or error."""
    client = _get_client()
    if client is None:
        return None
    try:
        raw = client.get(key)
        if raw is None:
            return None
        return json.loads(raw)
    except Exception:
        _drop_client()
        return None


def cache_set(key: str, value: Any, ttl: int) -> None:
    """Set a cached value with TTL in seconds. No-op if Redis is unavailable."""
    client = _get_client()
    if client is None:
        return
    try:
        client.setex(key, ttl, json.dumps(value))
    except Exception:
        _drop_client()


def cache_delete(key: str) -> None:
    """Delete a single cache key. No-op if Redis is unavailable."""
    client = _get_client()
    if client is None:
        return
    try:
        client.delete(key)
    except Exception:
        _drop_client()


def cache_incr(key: str, ttl: int) -> int | None:
    """Increment a counter, setting the TTL on the first increment.

    Used for view-count deduplication (harden-pagepocket-platform 1.17): the
    caller treats a return value of 1 as "first hit inside the window".
    Returns None when Redis is unavailable so callers can fall back to their
    own accounting.
    """
    client = _get_client()
    if client is None:
        return None
    try:
        count = client.incr(key)
        if count == 1:
            client.expire(key, ttl)
        return int(count)
    except Exception:
        _drop_client()
        return None


def cache_invalidate_pattern(pattern: str) -> None:
    """Delete all keys matching a glob pattern (e.g. 'library:collections:user123:*')."""
    client = _get_client()
    if client is None:
        return
    try:
        cursor = 0
        while True:
            cursor, keys = client.scan(cursor, match=pattern, count=100)
            if keys:
                client.delete(*keys)
            if cursor == 0:
                break
    except Exception:
        _drop_client()
