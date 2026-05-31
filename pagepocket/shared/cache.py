"""Redis cache helper with graceful degradation."""

import json
import os
import logging
from typing import Any

import redis

logger = logging.getLogger(__name__)

_client: redis.Redis | None = None
_checked = False


def _get_client() -> redis.Redis | None:
    global _client, _checked
    if _checked:
        return _client
    _checked = True

    url = os.environ.get("REDIS_URL")
    if not url:
        logger.info("REDIS_URL not set — caching disabled")
        return None

    try:
        _client = redis.from_url(url, decode_responses=True, socket_connect_timeout=2)
        _client.ping()
        logger.info("Connected to Redis at %s", url)
        return _client
    except Exception as exc:
        logger.warning("Redis unavailable (%s) — caching disabled", exc)
        _client = None
        return None


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
        return None


def cache_set(key: str, value: Any, ttl: int) -> None:
    """Set a cached value with TTL in seconds. No-op if Redis is unavailable."""
    client = _get_client()
    if client is None:
        return
    try:
        client.setex(key, ttl, json.dumps(value))
    except Exception:
        pass


def cache_delete(key: str) -> None:
    """Delete a single cache key. No-op if Redis is unavailable."""
    client = _get_client()
    if client is None:
        return
    try:
        client.delete(key)
    except Exception:
        pass


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
        pass
