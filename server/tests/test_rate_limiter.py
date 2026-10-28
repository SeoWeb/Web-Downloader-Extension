"""Unit tests for the token-bucket rate limiter and its route wiring.

Covers the server-api "Resource upload rate limiting" requirement:

  - TokenBucket math: allow up to burst, deny past it, refill over time,
    Retry-After estimate (deficit / rate).
  - The resource-upload limiter is sized per spec (rate 60/s, burst 100).
  - Route wiring: an upload past the burst is rejected with 429 and a
    Retry-After header (the auth routes are exercised the same way in
    test_auth_security.py's throttling tests).
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from app.api.rate_limiter import RateLimiter, TokenBucket, resource_upload_limiter
from fastapi import HTTPException

# ---------------------------------------------------------------------------
# TokenBucket math
# ---------------------------------------------------------------------------


class TestTokenBucket:
    def test_allows_up_to_capacity_then_denies(self):
        bucket = TokenBucket(rate=0.0, capacity=3)
        assert bucket.consume() is True
        assert bucket.consume() is True
        assert bucket.consume() is True
        assert bucket.consume() is False

    def test_refill_restores_tokens_over_time(self, monkeypatch):
        clock = {"now": 1000.0}
        monkeypatch.setattr(
            "app.api.rate_limiter.time.monotonic", lambda: clock["now"]
        )
        bucket = TokenBucket(rate=2.0, capacity=2)  # 2 tokens per second

        bucket.consume()
        bucket.consume()
        assert bucket.consume() is False  # burst exhausted

        clock["now"] += 0.5  # exactly one token refilled
        assert bucket.consume() is True
        assert bucket.consume() is False

        clock["now"] += 10.0  # far more than needed — clamped at capacity
        assert bucket.consume() is True
        assert bucket.consume() is True
        assert bucket.consume() is False

    def test_refill_clamped_at_capacity(self, monkeypatch):
        clock = {"now": 0.0}
        monkeypatch.setattr(
            "app.api.rate_limiter.time.monotonic", lambda: clock["now"]
        )
        bucket = TokenBucket(rate=5.0, capacity=2)
        bucket.consume()          # tokens: 2 → 1
        clock["now"] += 100.0     # unclamped refill would add 500 tokens
        assert bucket.consume() is True
        # tokens stayed within capacity (clamped to 2, then consumed 1)
        assert bucket.tokens == pytest.approx(1.0)

    def test_retry_after_full_bucket_is_zero(self):
        bucket = TokenBucket(rate=0.5, capacity=1)
        assert bucket.retry_after_seconds() == 0.0

    def test_retry_after_empty_bucket_is_deficit_over_rate(self, monkeypatch):
        clock = {"now": 0.0}
        monkeypatch.setattr(
            "app.api.rate_limiter.time.monotonic", lambda: clock["now"]
        )
        bucket = TokenBucket(rate=0.5, capacity=1)
        bucket.consume()  # tokens = 0
        # one token at 0.5/s → 2 seconds
        assert bucket.retry_after_seconds() == pytest.approx(2.0)


class TestRateLimiter:
    def test_is_allowed_returns_retry_after_on_deny(self, monkeypatch):
        clock = {"now": 0.0}
        monkeypatch.setattr(
            "app.api.rate_limiter.time.monotonic", lambda: clock["now"]
        )
        limiter = RateLimiter(rate=0.5, capacity=1)
        allowed, retry_after = limiter.is_allowed("k")
        assert allowed is True
        assert retry_after == 0.0
        allowed, retry_after = limiter.is_allowed("k")
        assert allowed is False
        assert retry_after == pytest.approx(2.0)

    def test_buckets_are_isolated_per_key(self):
        limiter = RateLimiter(rate=1e-9, capacity=1)  # ~no refill in-test
        assert limiter.is_allowed("session-a")[0] is True
        assert limiter.is_allowed("session-b")[0] is True
        assert limiter.is_allowed("session-a")[0] is False
        assert limiter.is_allowed("session-b")[0] is False

    def test_resource_upload_limiter_sized_per_spec(self):
        """server-api: token bucket, rate 60 req/s, burst 100 per session."""
        assert resource_upload_limiter.rate == 60
        assert resource_upload_limiter.capacity == 100


# ---------------------------------------------------------------------------
# Route wiring: upload past the burst → 429 + Retry-After
# ---------------------------------------------------------------------------


class _AsyncUploadFile:
    """Minimal async-compatible upload file stub for testing."""

    def __init__(self, content: bytes, filename: str = "test.bin"):
        self._buf = content
        self._pos = 0
        self.filename = filename

    async def read(self, size: int = -1) -> bytes:
        if size == -1:
            chunk = self._buf[self._pos :]
            self._pos = len(self._buf)
        else:
            chunk = self._buf[self._pos : self._pos + size]
            self._pos += len(chunk)
        return chunk


def _mock_request(content_length: int | None = None) -> MagicMock:
    req = MagicMock()
    req.headers.get.return_value = (
        str(content_length) if content_length is not None else None
    )
    return req


def _scalar_one(value) -> MagicMock:
    r = MagicMock()
    r.scalar_one_or_none.return_value = value
    return r


def _scalar(value) -> MagicMock:
    r = MagicMock()
    r.scalar.return_value = value
    return r


def _mock_db(*execute_returns) -> AsyncMock:
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=list(execute_returns))
    db.flush = AsyncMock()
    db.rollback = AsyncMock()
    db.add = MagicMock()
    return db


def _mock_session(
    session_id: str = "sess-rl",
    client_id: str = "client-rl",
):
    from app.models.session import SessionStatus

    s = MagicMock()
    s.id = session_id
    s.client_id = client_id
    s.status = SessionStatus.SCRAPING
    return s


class TestResourceUploadRateLimited:
    @pytest.mark.asyncio
    async def test_upload_past_burst_returns_429_with_retry_after(
        self, tmp_path, monkeypatch
    ):
        """First upload within the burst succeeds; the next one is denied
        with 429 and a ceil'd Retry-After header (deterministic: the bucket
        clock is frozen so no refill can sneak in between calls)."""
        from app.api.routes.resources import upload_resource

        monkeypatch.setattr(
            "app.api.rate_limiter.time.monotonic", lambda: 1000.0
        )
        limiter = RateLimiter(rate=0.5, capacity=1)  # burst of 1, 1 token / 2s

        db = _mock_db(
            _scalar_one(_mock_session()),   # session lookup
            _scalar(0),                     # post-write size (passes)
            _scalar_one(None),              # dedup → no match
            MagicMock(),                    # counter UPDATE (Round 9)
        )

        def _upload():
            return upload_resource(
                session_id="sess-rl",
                request=_mock_request(content_length=None),
                file=_AsyncUploadFile(b"payload", "a.bin"),
                path="files/a.bin",
                originalUrl="https://example.com/a.bin",
                contentType="application/octet-stream",
                x_content_gzipped=False,
                client=MagicMock(id="client-rl"),
                db=db,
            )

        with patch("app.api.routes.resources.settings") as cfg, \
             patch("app.api.routes.resources.resource_upload_limiter", limiter), \
             patch("app.api.routes.resources.require_session_owner"):
            cfg.max_session_size_mb = 100
            cfg.storage_root = str(tmp_path)

            first = await _upload()
            assert first.deduplicated is False  # burst token consumed

            with pytest.raises(HTTPException) as exc:
                await _upload()

        assert exc.value.status_code == 429
        assert exc.value.detail["error"] == "rate_limit_exceeded"
        assert exc.value.detail["api_version"] == "v1"
        # tokens == 0 at rate 0.5/s → exactly 2.0s → ceil → "2"
        assert exc.value.headers["Retry-After"] == "2"

    @pytest.mark.asyncio
    async def test_retry_after_is_at_least_one_second(self, monkeypatch):
        """A sub-second deficit still ceilings to a usable header value."""
        import math

        bucket = TokenBucket(rate=60, capacity=1)
        monkeypatch.setattr(
            "app.api.rate_limiter.time.monotonic", lambda: 0.0
        )
        bucket.consume()
        bucket.tokens = 0.999  # tiny deficit → retry_after well under 1s
        retry_after = bucket.retry_after_seconds()
        assert retry_after < 1.0
        assert math.ceil(retry_after) == 1


# ---------------------------------------------------------------------------
# server-assembly-honesty 11.9 (D9): `_call_count` advances exactly once per
# is_allowed() call so stale-bucket pruning fires every ~100 calls, not
# twice as often.
# ---------------------------------------------------------------------------


class TestCleanupCadence:
    def test_is_allowed_increments_call_counter_exactly_once(self):
        """100 is_allowed() calls advance `_call_count` by exactly 100 (the
        pre-D9 double increment produced 200)."""
        limiter = RateLimiter(rate=1e-9, capacity=1000)  # ~no refill in-test
        for _ in range(100):
            limiter.is_allowed("k")
        assert limiter._call_count == 100

    def test_cleanup_if_needed_does_not_advance_counter(self):
        """Only is_allowed() owns the counter — a manual cleanup call must
        leave it alone (it is also invoked from inside is_allowed())."""
        limiter = RateLimiter(rate=1e-9, capacity=10)
        removed = limiter.cleanup_if_needed()
        assert removed == 0  # no buckets yet, nothing to prune
        assert limiter._call_count == 0

    def test_stale_pruning_fires_once_at_100_call_boundary(self, monkeypatch):
        """With the clock frozen past `_BUCKET_MAX_AGE`, the stale bucket is
        still present at call 99 and pruned exactly once at the 100th call
        boundary; the recent bucket survives."""
        clock = {"now": 1000.0}
        monkeypatch.setattr(
            "app.api.rate_limiter.time.monotonic", lambda: clock["now"]
        )
        limiter = RateLimiter(rate=1e-9, capacity=100)

        limiter.is_allowed("stale-key")  # call 1 → bucket stamped @1000s
        assert "stale-key" in limiter._buckets

        clock["now"] = 2000.0  # idle 1000s > _BUCKET_MAX_AGE (600s)
        for _ in range(98):  # calls 2..99 — boundary not yet reached
            limiter.is_allowed("fresh-key")

        assert limiter._call_count == 99
        assert "stale-key" in limiter._buckets, (
            "stale bucket pruned before the 100-call boundary "
            "(cleanup firing too often?)"
        )

        limiter.is_allowed("fresh-key")  # call 100 → cleanup fires here
        assert limiter._call_count == 100
        assert "stale-key" not in limiter._buckets
        assert "fresh-key" in limiter._buckets  # recent bucket survives
