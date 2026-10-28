"""Tests for auth hardening: API-key hashing, registration throttling,
orphan-client cleanup (harden-backend-security-and-ops 7.5, 7.8, 6.4).

  7.5 — API keys are hashed at rest (SHA-256 lookup column). Fresh
        registrations store the hash immediately; legacy plaintext-only
        rows are migrated lazily on first successful auth; hash lookup
        works even when the plaintext column no longer matches.

  7.8 — registration is throttled per instance id AND per client IP; the
        client IP honors X-Forwarded-For ONLY when TRUST_PROXY is enabled.

  6.4 — orphan clients (no sessions, no auth activity beyond the configured
        age) are reaped by the existing cleanup cadence.

Route/cleanup tests run against a real SQLite database (see conftest).
"""

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.models.client import Client
from app.models.session import Session, SessionStatus


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_request(headers=None, peer=("5.6.7.8", 44344)):
    """Build a minimal starlette Request for the register route."""
    from starlette.requests import Request

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


async def _seed(factory, *objects):
    async with factory() as db:
        for obj in objects:
            db.add(obj)
        await db.commit()


# ---------------------------------------------------------------------------
# 7.5 — API-key hashing at rest
# ---------------------------------------------------------------------------


class TestApiKeyHashing:
    @pytest.mark.asyncio
    async def test_register_stores_hash_at_creation(self, sqlite_db):
        from app.api.routes.auth import RegisterRequest, register

        _engine, factory = sqlite_db
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("app.api.routes.auth.registration_limiter.is_allowed",
                       lambda key: (True, 0))
            mp.setattr("app.api.routes.auth.registration_instance_limiter.is_allowed",
                       lambda key: (True, 0))
            async with factory() as db:
                response = await register(
                    _make_request(), body=RegisterRequest(client_id="inst-x"), db=db,
                )
                await db.commit()

        async with factory() as db:
            row = (await db.execute(
                select(Client).where(Client.id == response.client_id)
            )).scalar_one()
        assert response.api_key == row.api_key  # plaintext kept until rotated
        assert row.api_key_hash == Client.hash_key(response.api_key)

    @pytest.mark.asyncio
    async def test_legacy_plaintext_key_works_and_gets_hashed(self, sqlite_db):
        """A legacy plaintext-only row authenticates and the hash column is
        populated lazily (7.5 migration path)."""
        from app.api.dependencies import authenticate_client

        _engine, factory = sqlite_db
        await _seed(factory, Client(id="legacy", api_key="legacy-plain-key"))

        async with factory() as db:
            client = await authenticate_client(db, "legacy-plain-key")
            assert client is not None
            assert client.id == "legacy"
            assert client.api_key_hash == Client.hash_key("legacy-plain-key")
            # last_auth_at touched for orphan cleanup (6.4)
            assert client.last_auth_at is not None
            await db.commit()

        # Persisted
        async with factory() as db:
            row = (await db.execute(
                select(Client).where(Client.id == "legacy")
            )).scalar_one()
        assert row.api_key_hash == Client.hash_key("legacy-plain-key")

    @pytest.mark.asyncio
    async def test_hash_lookup_works_without_matching_plaintext(self, sqlite_db):
        """Hash lookup is the primary path: the key authenticates via its
        hash even when the plaintext column holds a different value."""
        from app.api.dependencies import authenticate_client

        _engine, factory = sqlite_db
        await _seed(factory, Client(
            id="hashed", api_key="rotated-away-value",
            api_key_hash=Client.hash_key("the-real-key"),
        ))

        async with factory() as db:
            client = await authenticate_client(db, "the-real-key")
        assert client is not None
        assert client.id == "hashed"

    @pytest.mark.asyncio
    async def test_unknown_key_rejected(self, sqlite_db):
        from app.api.dependencies import authenticate_client

        _engine, factory = sqlite_db
        await _seed(factory, Client(id="c", api_key="k",
                                    api_key_hash=Client.hash_key("k")))

        async with factory() as db:
            assert await authenticate_client(db, "nope") is None

    @pytest.mark.asyncio
    async def test_get_current_client_401_for_unknown_key(self, sqlite_db):
        from app.api.dependencies import get_current_client

        _engine, factory = sqlite_db
        async with factory() as db:
            with pytest.raises(HTTPException) as exc:
                await get_current_client(x_api_key="missing", db=db)
        assert exc.value.status_code == 401

    @pytest.mark.asyncio
    async def test_last_auth_touch_is_coalesced(self, sqlite_db):
        """last_auth_at is not rewritten on every request (write coalescing)."""
        from app.api.dependencies import authenticate_client

        _engine, factory = sqlite_db
        recent = datetime.now(timezone.utc) - timedelta(minutes=5)
        await _seed(factory, Client(
            id="coalesced", api_key="k1", api_key_hash=Client.hash_key("k1"),
            last_auth_at=recent,
        ))

        async with factory() as db:
            client = await authenticate_client(db, "k1")
        # SQLite round-trips naive datetimes; normalize before comparing.
        returned = client.last_auth_at
        if returned.tzinfo is None:
            returned = returned.replace(tzinfo=timezone.utc)
        assert returned == recent  # unchanged — touched < 1h ago


# ---------------------------------------------------------------------------
# 7.8 — registration throttling
# ---------------------------------------------------------------------------


class TestRegistrationThrottling:
    @pytest.mark.asyncio
    async def test_instance_id_throttle_returns_429(self, sqlite_db):
        from app.api.routes.auth import RegisterRequest, register

        _engine, factory = sqlite_db

        def _denied(key):
            return (False, 42.0)

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("app.api.routes.auth.registration_limiter.is_allowed",
                       lambda key: (True, 0))
            mp.setattr("app.api.routes.auth.registration_instance_limiter.is_allowed",
                       _denied)
            async with factory() as db:
                with pytest.raises(HTTPException) as exc:
                    await register(
                        _make_request(),
                        body=RegisterRequest(client_id="spammy-inst"),
                        db=db,
                    )

        assert exc.value.status_code == 429
        assert "Retry-After" in exc.value.headers

    @pytest.mark.asyncio
    async def test_instance_throttle_keyed_by_instance_id(self, sqlite_db):
        """The per-instance limiter is keyed by the instance id, not the IP."""
        from app.api.routes.auth import RegisterRequest, register

        _engine, factory = sqlite_db
        seen_keys = []

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("app.api.routes.auth.registration_limiter.is_allowed",
                       lambda key: (True, 0))
            mp.setattr(
                "app.api.routes.auth.registration_instance_limiter.is_allowed",
                lambda key: (seen_keys.append(key) or (True, 0)),
            )
            async with factory() as db:
                await register(
                    _make_request(),
                    body=RegisterRequest(client_id="inst-abc"), db=db,
                )

        assert seen_keys == ["inst-abc"]

    @pytest.mark.asyncio
    async def test_ip_throttle_returns_429(self, sqlite_db):
        from app.api.routes.auth import RegisterRequest, register

        _engine, factory = sqlite_db
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("app.api.routes.auth.registration_limiter.is_allowed",
                       lambda key: (False, 30.0))
            async with factory() as db:
                with pytest.raises(HTTPException) as exc:
                    await register(
                        _make_request(),
                        body=RegisterRequest(client_id="inst-1"), db=db,
                    )
        assert exc.value.status_code == 429

    def test_instance_limiter_is_config_bounded(self):
        """Burst == configured daily limit; refill spreads over 24h."""
        from app.api import rate_limiter
        from app.config import settings

        limiter = rate_limiter.registration_instance_limiter
        limit = settings.registration_per_instance_daily_limit
        assert limiter.capacity == limit
        assert abs(limiter.rate - limit / 86400) < 1e-12


class TestTrustProxyClientIP:
    """X-Forwarded-For is honored ONLY when TRUST_PROXY is enabled (7.8)."""

    def _request_with_xff(self, xff="9.9.9.9, 10.0.0.1"):
        return _make_request(
            headers={"X-Forwarded-For": xff}, peer=("203.0.113.7", 1234),
        )

    def test_peer_used_by_default(self, monkeypatch):
        from app.api.routes.auth import get_client_ip

        monkeypatch.setattr("app.config.settings.trust_proxy", False)
        assert get_client_ip(self._request_with_xff()) == "203.0.113.7"

    def test_xff_rightmost_used_when_trust_proxy(self, monkeypatch):
        from app.api.routes.auth import get_client_ip

        monkeypatch.setattr("app.config.settings.trust_proxy", True)
        # Rightmost entry is the one the trusted proxy observed
        assert get_client_ip(self._request_with_xff()) == "10.0.0.1"

    def test_xff_ignored_spoofable_when_untrusted(self, monkeypatch):
        from app.api.routes.auth import get_client_ip

        monkeypatch.setattr("app.config.settings.trust_proxy", False)
        req = _make_request(
            headers={"X-Forwarded-For": "1.2.3.4"}, peer=("5.5.5.5", 9),
        )
        assert get_client_ip(req) == "5.5.5.5"

    def test_falls_back_to_peer_when_no_header_and_trusting(self, monkeypatch):
        from app.api.routes.auth import get_client_ip

        monkeypatch.setattr("app.config.settings.trust_proxy", True)
        assert get_client_ip(_make_request(peer=("7.7.7.7", 1))) == "7.7.7.7"

    @pytest.mark.asyncio
    async def test_ip_limiter_keyed_by_proxy_ip_when_trusted(self, sqlite_db, monkeypatch):
        """With TRUST_PROXY on, the registration limiter sees the XFF IP."""
        from app.api.routes.auth import RegisterRequest, register

        _engine, factory = sqlite_db
        seen = []
        monkeypatch.setattr("app.config.settings.trust_proxy", True)
        monkeypatch.setattr(
            "app.api.routes.auth.registration_limiter.is_allowed",
            lambda key: (seen.append(key) or (True, 0)),
        )
        monkeypatch.setattr(
            "app.api.routes.auth.registration_instance_limiter.is_allowed",
            lambda key: (True, 0),
        )

        async with factory() as db:
            await register(
                _make_request(headers={"X-Forwarded-For": "8.8.8.8, 10.1.1.1"},
                              peer=("198.51.100.9", 5)),
                body=RegisterRequest(client_id="inst-px"), db=db,
            )

        assert seen == ["10.1.1.1"]


# ---------------------------------------------------------------------------
# 6.4 — orphan client cleanup
# ---------------------------------------------------------------------------


class TestOrphanClientCleanup:
    def _cleanup(self, tmp_path, age_days=30):
        from app.services.cleanup import CleanupService

        return CleanupService(
            storage_root=str(tmp_path),
            stale_timeout_minutes=30,
            orphaned_key_age_days=age_days,
            cleanup_interval_hours=1,
        )

    async def _reap(self, factory, cleanup):
        async with factory() as db:
            count = await cleanup._cleanup_orphaned_api_keys(db)
            await db.commit()
        return count

    async def _remaining_ids(self, factory):
        async with factory() as db:
            rows = (await db.execute(select(Client))).scalars().all()
            return sorted(r.id for r in rows)

    @pytest.mark.asyncio
    async def test_stale_unauthed_client_reaped(self, sqlite_db, tmp_path):
        _engine, factory = sqlite_db
        old = datetime.now(timezone.utc) - timedelta(days=45)
        await _seed(factory, Client(id="dead", api_key="k", created_at=old))

        cleanup = self._cleanup(tmp_path)
        assert await self._reap(factory, cleanup) == 1
        assert await self._remaining_ids(factory) == []

    @pytest.mark.asyncio
    async def test_recently_authed_client_survives(self, sqlite_db, tmp_path):
        """Old registration but recent auth activity → kept (6.4 semantics)."""
        _engine, factory = sqlite_db
        old = datetime.now(timezone.utc) - timedelta(days=45)
        recent_auth = datetime.now(timezone.utc) - timedelta(days=1)
        await _seed(factory, Client(
            id="active", api_key="k", created_at=old, last_auth_at=recent_auth,
        ))

        cleanup = self._cleanup(tmp_path)
        assert await self._reap(factory, cleanup) == 0
        assert await self._remaining_ids(factory) == ["active"]

    @pytest.mark.asyncio
    async def test_authed_then_stale_client_reaped(self, sqlite_db, tmp_path):
        """No auth activity beyond the threshold → reaped even if it authed
        once long ago."""
        _engine, factory = sqlite_db
        old = datetime.now(timezone.utc) - timedelta(days=90)
        stale_auth = datetime.now(timezone.utc) - timedelta(days=60)
        await _seed(factory, Client(
            id="stale-auth", api_key="k", created_at=old, last_auth_at=stale_auth,
        ))

        cleanup = self._cleanup(tmp_path)
        assert await self._reap(factory, cleanup) == 1
        assert await self._remaining_ids(factory) == []

    @pytest.mark.asyncio
    async def test_client_with_sessions_kept(self, sqlite_db, tmp_path):
        """Clients with sessions are never reaped (session expiry handles
        their sessions; the next pass may reap the then-empty client)."""
        _engine, factory = sqlite_db
        old = datetime.now(timezone.utc) - timedelta(days=45)
        await _seed(
            factory,
            Client(id="busy", api_key="k", created_at=old),
            Session(
                id="sess-of-busy", client_id="busy", url="https://example.com",
                status=SessionStatus.READY,
                expires_at=datetime.now(timezone.utc) + timedelta(days=1),
                created_at=old,
            ),
        )

        cleanup = self._cleanup(tmp_path)
        assert await self._reap(factory, cleanup) == 0
        assert await self._remaining_ids(factory) == ["busy"]

    @pytest.mark.asyncio
    async def test_young_client_kept(self, sqlite_db, tmp_path):
        _engine, factory = sqlite_db
        await _seed(factory, Client(
            id="young", api_key="k",
            created_at=datetime.now(timezone.utc) - timedelta(days=2),
        ))

        cleanup = self._cleanup(tmp_path)
        assert await self._reap(factory, cleanup) == 0
        assert await self._remaining_ids(factory) == ["young"]

    @pytest.mark.asyncio
    async def test_cleanup_hooked_into_startup_and_periodic(self, tmp_path):
        """The orphan pass remains part of both cleanup cadences (6.4)."""
        import inspect

        from app.services.cleanup import CleanupService

        startup_src = inspect.getsource(CleanupService.run_startup_cleanup)
        periodic_src = inspect.getsource(CleanupService.run_periodic_cleanup)
        assert "_cleanup_orphaned_api_keys" in startup_src
        assert "_cleanup_orphaned_api_keys" in periodic_src


# ---------------------------------------------------------------------------
# server-assembly-honesty 11.4 (D5) — dedup'd registrations don't consume
# instance budget; Retry-After on registration 429s is capped.
# ---------------------------------------------------------------------------


def _instance_sentinel(capacity: int | None = None):
    """A fresh RateLimiter with the instance limiter's production shape.

    The real ``registration_instance_limiter`` is a module-level singleton;
    patching a same-shaped sentinel in keeps tests isolated from cross-test
    bucket state while still exercising real token-bucket math.
    """
    from app.api import rate_limiter as rl
    from app.config import settings

    daily = max(1, settings.registration_per_instance_daily_limit)
    return rl.RateLimiter(rate=daily / 86400, capacity=capacity or daily)


def _retry_after_cap():
    """The D5 cap. getattr fallback keeps the assertion meaningful against
    pre-D5 source (which lacks the setting): the header must still respect
    the documented 300 s bound there, so the test fails on the value
    comparison instead of erroring on a missing attribute."""
    from app.config import settings

    return getattr(settings, "registration_retry_after_max_seconds", 300)


class TestDedupRegistrationBudget:
    """D5: a registration resolved by the instance-id dedup lookup consumes
    NO per-instance budget; fresh registrations still do."""

    DUP_INSTANCE_ID = "dup-budget-inst"

    @pytest.mark.asyncio
    async def test_fifteen_dedup_registrations_same_key_no_budget(
        self, sqlite_db
    ):
        """15 consecutive proof-of-possession re-registrations of an
        already-registered instance id all return the SAME key, and the
        instance limiter bucket is never even created (api-abuse-hardening:
        the dedup path requires the current key as ``X-API-Key`` proof; the
        per-instance budget remains fresh-registration-only)."""
        from app.api.routes.auth import RegisterRequest, register

        _engine, factory = sqlite_db
        await _seed(factory, Client(
            id="dup-client",
            api_key="dup-key",
            extension_instance_id=self.DUP_INSTANCE_ID,
        ))
        sentinel = _instance_sentinel()

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("app.api.routes.auth.registration_limiter.is_allowed",
                       lambda key: (True, 0))
            mp.setattr("app.api.routes.auth.registration_instance_limiter",
                       sentinel)

            for attempt in range(1, 16):
                async with factory() as db:
                    response = await register(
                        _make_request(headers={"X-API-Key": "dup-key"}),
                        body=RegisterRequest(client_id=self.DUP_INSTANCE_ID),
                        db=db,
                    )
                assert response.api_key == "dup-key", (
                    f"attempt {attempt}: proof-bearing re-registration did "
                    "not return the existing key (instance budget burned?)"
                )
                assert response.client_id == "dup-client"
                assert response.extension_instance_id == self.DUP_INSTANCE_ID

        # No duplicate rows appeared either.
        async with factory() as db:
            rows = (await db.execute(select(Client))).scalars().all()
        assert len(rows) == 1

        # The bucket for this id is untouched — never even created
        # (``in`` on a defaultdict does not insert).
        assert self.DUP_INSTANCE_ID not in sentinel._buckets

    @pytest.mark.asyncio
    async def test_dedup_hit_skips_instance_limiter(self, sqlite_db):
        """A re-registration of a known id must not consult the per-instance
        limiter at all (the lookup-first ordering IS the cheap path)."""
        from app.api.routes.auth import RegisterRequest, register

        _engine, factory = sqlite_db
        sentinel = _instance_sentinel()
        consulted = []
        original = sentinel.is_allowed

        def _spy(key, tokens=1):
            consulted.append(key)
            return original(key, tokens)

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("app.api.routes.auth.registration_limiter.is_allowed",
                       lambda key: (True, 0))
            mp.setattr(sentinel, "is_allowed", _spy)
            mp.setattr("app.api.routes.auth.registration_instance_limiter",
                       sentinel)

            async with factory() as db:
                first = await register(
                    _make_request(),
                    body=RegisterRequest(client_id="spy-inst"),
                    db=db,
                )
                await db.commit()  # persist the fresh registration

            async with factory() as db:
                second = await register(
                    _make_request(headers={"X-API-Key": first.api_key}),
                    body=RegisterRequest(client_id="spy-inst"),
                    db=db,
                )

        assert first.api_key == second.api_key
        # Only the fresh registration consulted the limiter.
        assert consulted == ["spy-inst"]

    @pytest.mark.asyncio
    async def test_fresh_registration_still_consumes_budget(self, sqlite_db):
        """Preservation pin (scenario: fresh registration still consumes
        budget): once an id's daily bucket is exhausted, a further fresh
        registration of that (never-registered) id is rejected with 429."""
        from app.api.routes.auth import RegisterRequest, register

        _engine, factory = sqlite_db
        sentinel = _instance_sentinel(capacity=1)
        # Simulate the day's earlier fresh attempts: the bucket is spent.
        assert sentinel.is_allowed("exhausted-inst")[0] is True

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("app.api.routes.auth.registration_limiter.is_allowed",
                       lambda key: (True, 0))
            mp.setattr("app.api.routes.auth.registration_instance_limiter",
                       sentinel)
            async with factory() as db:
                with pytest.raises(HTTPException) as exc:
                    await register(
                        _make_request(),
                        body=RegisterRequest(client_id="exhausted-inst"),
                        db=db,
                    )

        assert exc.value.status_code == 429

    @pytest.mark.asyncio
    async def test_instance_429_retry_after_is_capped(self, sqlite_db):
        """D5: the Retry-After emitted on a per-instance 429 is capped at
        ``registration_retry_after_max_seconds`` — the honest refill
        estimate is ~8640s at capacity 10, and that is useless as a hint."""
        from app.api.routes.auth import RegisterRequest, register

        _engine, factory = sqlite_db
        sentinel = _instance_sentinel(capacity=1)
        assert sentinel.is_allowed("cap-inst")[0] is True  # drain the bucket

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("app.api.routes.auth.registration_limiter.is_allowed",
                       lambda key: (True, 0))
            mp.setattr("app.api.routes.auth.registration_instance_limiter",
                       sentinel)
            async with factory() as db:
                with pytest.raises(HTTPException) as exc:
                    await register(
                        _make_request(),
                        body=RegisterRequest(client_id="cap-inst"),
                        db=db,
                    )

        assert exc.value.status_code == 429
        cap = _retry_after_cap()
        retry_after = int(exc.value.headers["Retry-After"])
        assert 1 <= retry_after <= cap, (
            f"Retry-After={retry_after} exceeds the {cap}s cap (uncapped "
            "hours-scale refill estimate leaked into the header?)"
        )

    @pytest.mark.asyncio
    async def test_per_ip_429_retry_after_is_capped(self, sqlite_db):
        """D5: the per-IP 429 site caps Retry-After too (spec: 'per-IP or
        per-instance')."""
        from app.api.routes.auth import RegisterRequest, register

        _engine, factory = sqlite_db
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("app.api.routes.auth.registration_limiter.is_allowed",
                       lambda key: (False, 5000.0))
            mp.setattr(
                "app.api.routes.auth.registration_instance_limiter.is_allowed",
                lambda key: (True, 0),
            )
            async with factory() as db:
                with pytest.raises(HTTPException) as exc:
                    await register(
                        _make_request(),
                        body=RegisterRequest(client_id="ip-cap-inst"),
                        db=db,
                    )

        assert exc.value.status_code == 429
        cap = _retry_after_cap()
        retry_after = int(exc.value.headers["Retry-After"])
        assert 1 <= retry_after <= cap


# ---------------------------------------------------------------------------
# api-abuse-hardening 5.1 (D1/D2) — proof-of-possession re-registration
# ---------------------------------------------------------------------------


def _ip_sentinel(capacity: int = 2):
    """A fresh RateLimiter with the per-IP registration limiter's production
    shape (5/min), at a small capacity so bursts are cheap to test."""
    from app.api import rate_limiter as rl

    return rl.RateLimiter(rate=5 / 60, capacity=capacity)


class TestProofOfPossessionRegistration:
    """D1/D2: a registered instance ID alone no longer yields a key.

    Re-registration of an existing ``extension_instance_id`` must present
    that client's current API key in the ``X-API-Key`` header:

    - proof matches        → 200 RegisterResponse with the existing
                             key/identity (re-unlock, no duplicate row)
    - no proof header      → 409 ``reauth_required``
    - proof doesn't verify → 401 ``reauth_proof_invalid``

    Proof verification uses the same lookup strategy as
    ``authenticate_client`` scoped to the resolved row: SHA-256 compare on
    ``api_key_hash`` first, plaintext ``api_key`` fallback for legacy rows
    (with lazy hash migration).
    """

    INSTANCE_ID = "pop-inst"

    def _seed_client(self, **kwargs) -> Client:
        params = {
            "id": "pop-client",
            "api_key": "pop-key",
            "extension_instance_id": self.INSTANCE_ID,
        }
        params.update(kwargs)
        return Client(**params)

    @pytest.mark.asyncio
    async def test_fresh_registration_is_unchanged(self, sqlite_db):
        """A never-registered id needs no proof and mints a fresh key."""
        from fastapi import Response

        from app.api.routes.auth import RegisterRequest, register

        _engine, factory = sqlite_db
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("app.api.routes.auth.registration_limiter.is_allowed",
                       lambda key: (True, 0))
            mp.setattr(
                "app.api.routes.auth.registration_instance_limiter.is_allowed",
                lambda key: (True, 0),
            )
            async with factory() as db:
                route_response = Response()
                response = await register(
                    _make_request(),
                    body=RegisterRequest(client_id="brand-new-inst"),
                    db=db,
                    response=route_response,
                )
                await db.commit()

        assert route_response.status_code == 201
        assert response.api_key != "pop-key"  # freshly minted
        assert response.extension_instance_id == "brand-new-inst"

    @pytest.mark.asyncio
    async def test_reunlock_with_correct_proof_returns_200_same_key(
        self, sqlite_db
    ):
        """Proof-bearing re-registration re-unlocks the same identity with
        200 and creates no duplicate row."""
        from fastapi import Response

        from app.api.routes.auth import RegisterRequest, register

        _engine, factory = sqlite_db
        await _seed(factory, self._seed_client(
            api_key_hash=Client.hash_key("pop-key"),
        ))

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("app.api.routes.auth.registration_limiter.is_allowed",
                       lambda key: (True, 0))
            async with factory() as db:
                route_response = Response()
                response = await register(
                    _make_request(headers={"X-API-Key": "pop-key"}),
                    body=RegisterRequest(client_id=self.INSTANCE_ID),
                    db=db,
                    response=route_response,
                )

        assert route_response.status_code == 200, (
            "the re-unlock path must return 200, not the 201 of a fresh "
            "registration"
        )
        assert response.api_key == "pop-key"
        assert response.client_id == "pop-client"
        assert response.extension_instance_id == self.INSTANCE_ID

        async with factory() as db:
            rows = (await db.execute(select(Client))).scalars().all()
        assert len(rows) == 1, "re-unlock must not create a duplicate row"

    @pytest.mark.asyncio
    async def test_reunlock_via_hash_when_plaintext_rotated(self, sqlite_db):
        """Hash lookup is the primary proof path: a row whose plaintext
        column is stale still re-unlocks on the current (hashed) key."""
        from fastapi import Response

        from app.api.routes.auth import RegisterRequest, register

        _engine, factory = sqlite_db
        await _seed(factory, self._seed_client(
            api_key="rotated-away-value",
            api_key_hash=Client.hash_key("the-real-key"),
        ))

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("app.api.routes.auth.registration_limiter.is_allowed",
                       lambda key: (True, 0))
            async with factory() as db:
                route_response = Response()
                response = await register(
                    _make_request(headers={"X-API-Key": "the-real-key"}),
                    body=RegisterRequest(client_id=self.INSTANCE_ID),
                    db=db,
                    response=route_response,
                )

        assert route_response.status_code == 200
        assert response.client_id == "pop-client"
        assert response.extension_instance_id == self.INSTANCE_ID

    @pytest.mark.asyncio
    async def test_id_only_reregistration_rejected_409_no_key_material(
        self, sqlite_db
    ):
        """ID-only re-registration of a registered id is rejected 409
        ``reauth_required`` — and the body carries no key material."""
        from app.api.routes.auth import RegisterRequest, register

        _engine, factory = sqlite_db
        await _seed(factory, self._seed_client())

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("app.api.routes.auth.registration_limiter.is_allowed",
                       lambda key: (True, 0))
            async with factory() as db:
                with pytest.raises(HTTPException) as exc:
                    await register(
                        _make_request(),  # no X-API-Key header at all
                        body=RegisterRequest(client_id=self.INSTANCE_ID),
                        db=db,
                    )

        assert exc.value.status_code == 409
        assert exc.value.detail["error"] == "reauth_required"
        assert "api_version" in exc.value.detail
        assert "pop-key" not in str(exc.value.detail), (
            "the 409 body must not leak key material"
        )

        async with factory() as db:
            rows = (await db.execute(select(Client))).scalars().all()
        assert len(rows) == 1, "rejection must not create a row"

    @pytest.mark.asyncio
    async def test_wrong_key_proof_rejected_401(self, sqlite_db):
        """A proof that doesn't verify against the resolved client is
        rejected 401 ``reauth_proof_invalid`` without leaking the key."""
        from app.api.routes.auth import RegisterRequest, register

        _engine, factory = sqlite_db
        await _seed(factory, self._seed_client())

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("app.api.routes.auth.registration_limiter.is_allowed",
                       lambda key: (True, 0))
            async with factory() as db:
                with pytest.raises(HTTPException) as exc:
                    await register(
                        _make_request(headers={"X-API-Key": "not-the-key"}),
                        body=RegisterRequest(client_id=self.INSTANCE_ID),
                        db=db,
                    )

        assert exc.value.status_code == 401
        assert exc.value.detail["error"] == "reauth_proof_invalid"
        assert "api_version" in exc.value.detail
        assert "pop-key" not in str(exc.value.detail), (
            "the 401 body must not leak the target identity's key"
        )

        async with factory() as db:
            rows = (await db.execute(select(Client))).scalars().all()
        assert len(rows) == 1, "rejection must not create a row"

    @pytest.mark.asyncio
    async def test_legacy_plaintext_row_reunlock_migrates_hash(self, sqlite_db):
        """A legacy plaintext-only row re-unlocks via the plaintext fallback
        and its hash column is populated lazily (same migration as auth)."""
        from fastapi import Response

        from app.api.routes.auth import RegisterRequest, register

        _engine, factory = sqlite_db
        await _seed(factory, self._seed_client())  # no api_key_hash

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("app.api.routes.auth.registration_limiter.is_allowed",
                       lambda key: (True, 0))
            async with factory() as db:
                route_response = Response()
                await register(
                    _make_request(headers={"X-API-Key": "pop-key"}),
                    body=RegisterRequest(client_id=self.INSTANCE_ID),
                    db=db,
                    response=route_response,
                )
                await db.commit()

        assert route_response.status_code == 200
        async with factory() as db:
            row = (await db.execute(
                select(Client).where(Client.id == "pop-client")
            )).scalar_one()
        assert row.api_key_hash == Client.hash_key("pop-key")


class TestRegistrationLimiterCoverage:
    """api-abuse-hardening 5.3 / resource-guards spec: EVERY register
    outcome consumes the per-IP bucket (fresh 201, re-unlock 200, 409, 401)
    — the PoP gate cannot be probed at unbounded volume — while the
    per-instance daily budget stays fresh-registration-only."""

    INSTANCE_ID = "lim-inst"

    async def _seed_registered(self, factory):
        await _seed(factory, Client(
            id="lim-client",
            api_key="lim-key",
            extension_instance_id=self.INSTANCE_ID,
        ))

    def _patches(self, mp, ip_sentinel, instance_sentinel=None):
        mp.setattr("app.api.routes.auth.registration_limiter", ip_sentinel)
        mp.setattr(
            "app.api.routes.auth.registration_instance_limiter",
            instance_sentinel if instance_sentinel is not None
            else _instance_sentinel(),
        )

    @pytest.mark.asyncio
    async def test_id_only_409s_exhaust_per_ip_bucket(self, sqlite_db):
        """Repeated ID-only re-registrations (rejected 409) each consume a
        per-IP token; the burst ends in 429 rate_limit_exceeded."""
        from app.api.routes.auth import RegisterRequest, register

        _engine, factory = sqlite_db
        await self._seed_registered(factory)
        ip_sentinel = _ip_sentinel(capacity=2)

        with pytest.MonkeyPatch.context() as mp:
            self._patches(mp, ip_sentinel)
            for _ in range(2):
                async with factory() as db:
                    with pytest.raises(HTTPException) as exc:
                        await register(
                            _make_request(),
                            body=RegisterRequest(client_id=self.INSTANCE_ID),
                            db=db,
                        )
                assert exc.value.status_code == 409

            async with factory() as db:
                with pytest.raises(HTTPException) as exc:
                    await register(
                        _make_request(),
                        body=RegisterRequest(client_id=self.INSTANCE_ID),
                        db=db,
                    )

        assert exc.value.status_code == 429
        assert exc.value.detail["error"] == "rate_limit_exceeded"

    @pytest.mark.asyncio
    async def test_reunlock_200s_exhaust_per_ip_bucket(self, sqlite_db):
        """Proof-bearing re-unlocks (200) each consume a per-IP token too."""
        from app.api.routes.auth import RegisterRequest, register

        _engine, factory = sqlite_db
        await self._seed_registered(factory)
        ip_sentinel = _ip_sentinel(capacity=2)

        with pytest.MonkeyPatch.context() as mp:
            self._patches(mp, ip_sentinel)
            for _ in range(2):
                async with factory() as db:
                    response = await register(
                        _make_request(headers={"X-API-Key": "lim-key"}),
                        body=RegisterRequest(client_id=self.INSTANCE_ID),
                        db=db,
                    )
                assert response.api_key == "lim-key"

            async with factory() as db:
                with pytest.raises(HTTPException) as exc:
                    await register(
                        _make_request(headers={"X-API-Key": "lim-key"}),
                        body=RegisterRequest(client_id=self.INSTANCE_ID),
                        db=db,
                    )

        assert exc.value.status_code == 429
        assert exc.value.detail["error"] == "rate_limit_exceeded"

    @pytest.mark.asyncio
    async def test_dedup_and_pop_hits_leave_instance_budget_intact(
        self, sqlite_db
    ):
        """The per-instance daily budget is consumed by fresh registrations
        only: 409/200 re-registration outcomes must leave its bucket
        untouched (capacity 1 — a single burned token would 429 the rest)."""
        from app.api.routes.auth import RegisterRequest, register

        _engine, factory = sqlite_db
        await self._seed_registered(factory)
        instance_sentinel = _instance_sentinel(capacity=1)
        ip_sentinel = _ip_sentinel(capacity=100)

        with pytest.MonkeyPatch.context() as mp:
            self._patches(mp, ip_sentinel, instance_sentinel)
            # 5× ID-only (409) and 5× proof-bearing (200) re-registrations.
            for proof in [None] * 5 + ["lim-key"] * 5:
                request = _make_request(
                    headers={"X-API-Key": proof} if proof else None,
                )
                async with factory() as db:
                    if proof is None:
                        with pytest.raises(HTTPException) as exc:
                            await register(
                                request,
                                body=RegisterRequest(client_id=self.INSTANCE_ID),
                                db=db,
                            )
                        assert exc.value.status_code == 409
                    else:
                        response = await register(
                            request,
                            body=RegisterRequest(client_id=self.INSTANCE_ID),
                            db=db,
                        )
                        assert response.api_key == "lim-key"

        assert self.INSTANCE_ID not in instance_sentinel._buckets, (
            "dedup/PoP hits must not consume the per-instance budget"
        )

    @pytest.mark.asyncio
    async def test_distinct_id_flood_from_one_ip_is_bounded(self, sqlite_db):
        """Guessing many distinct instance ids from one IP stays per-IP
        bounded — and each unregistered id yields only a fresh client."""
        from app.api.routes.auth import RegisterRequest, register

        _engine, factory = sqlite_db
        ip_sentinel = _ip_sentinel(capacity=2)

        with pytest.MonkeyPatch.context() as mp:
            self._patches(mp, ip_sentinel)
            for suffix in (1, 2):
                async with factory() as db:
                    response = await register(
                        _make_request(),
                        body=RegisterRequest(
                            client_id=f"flood-{suffix}",
                        ),
                        db=db,
                    )
                    await db.commit()
                assert response.api_key  # fresh key minted

            async with factory() as db:
                with pytest.raises(HTTPException) as exc:
                    await register(
                        _make_request(),
                        body=RegisterRequest(client_id="flood-3"),
                        db=db,
                    )

        assert exc.value.status_code == 429
        assert exc.value.detail["error"] == "rate_limit_exceeded"
