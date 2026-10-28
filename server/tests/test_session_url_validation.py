"""Tests for session-create hardening (api-abuse-hardening 5.4/5.5).

  URL validation (D4) — scheme allowlist (http/https only), rejection of
  private/loopback/link-local/unique-local IP literals (including
  ::ffff:-mapped, bracketed, and integer/hex-encoded forms), literal-only
  v1 (NO DNS resolution), and rejections that leave no session row and no
  storage directory.

  Session-creation quota (D5) — per-client active-session cap and rolling
  24h creation cap with the 429 ``session_limit_exceeded`` contract and an
  accurate ``Retry-After`` for the daily case.

Route-level tests run against a real SQLite database (see conftest).
"""

import os
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select, update

from app.config import settings
from app.models.client import Client
from app.models.session import Session, SessionStatus


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_client(client_id="sess-client", **kwargs) -> Client:
    return Client(id=client_id, api_key="k-" + client_id, **kwargs)


async def _seed(factory, *objects):
    async with factory() as db:
        for obj in objects:
            db.add(obj)
        await db.commit()


async def _seed_session(
    factory,
    *,
    session_id,
    client_id,
    status=SessionStatus.SCRAPING,
    created_at=None,
):
    """Insert a session row directly (bypassing the create route)."""
    async with factory() as db:
        db.add(Session(
            id=session_id,
            client_id=client_id,
            url="https://example.com/seeded",
            status=status,
            expires_at=datetime.now(timezone.utc) + timedelta(days=1),
            created_at=created_at,
        ))
        await db.commit()


async def _session_count(factory, client_id=None) -> int:
    async with factory() as db:
        stmt = select(func.count()).select_from(Session)
        if client_id is not None:
            stmt = stmt.where(Session.client_id == client_id)
        return (await db.execute(stmt)).scalar() or 0


def _body(url):
    from app.api.routes.sessions import CreateSessionRequest

    return CreateSessionRequest(url=url)


@pytest.fixture(autouse=True)
def _tmp_storage(tmp_path, monkeypatch):
    """Point the session storage root at a per-test temp directory.

    A ``storage/`` subdirectory of tmp_path keeps it disjoint from the
    SQLite test database the ``sqlite_db`` fixture writes to tmp_path.
    """
    storage_root = tmp_path / "storage"
    storage_root.mkdir()
    monkeypatch.setattr(settings, "storage_root", str(storage_root))
    return storage_root


# ---------------------------------------------------------------------------
# 5.4 — validator unit tests (pure function, no DB)
# ---------------------------------------------------------------------------


class TestValidateSessionUrlUnit:
    """Scheme allowlist + IP-literal blocklist per design D4."""

    def _validate(self, url):
        from app.services.url_validation import validate_session_url

        return validate_session_url(url)

    @pytest.mark.parametrize("url", [
        "https://example.com/page",
        "http://example.com/",
        "HTTPS://EXAMPLE.COM/PAGE",  # scheme comparison is case-insensitive
        "https://93.184.216.34/",  # public IPv4 literal
        "http://8.8.8.8:8080/path",
        "https://[2606:4700:4700::1111]/",  # public IPv6 literal
        "http://[::ffff:8.8.8.8]/",  # v4-mapped v6 whose v4 is public
        "https://172.32.0.1/",  # just outside 172.16.0.0/12
        "https://100.128.0.1/",  # just outside 100.64.0.0/10
        "http://2147483650/",  # integer form of a PUBLIC v4 (128.0.0.2)
        "https://internal-host.example/",  # hostname judged as written
    ])
    def test_allowed(self, url):
        verdict = self._validate(url)
        assert verdict.allowed is True, f"{url} should be allowed"
        assert verdict.reason is None

    @pytest.mark.parametrize("url", [
        "file:///etc/passwd",
        "data:text/html,hello",
        "ftp://example.com/pub",
        "blob:https://example.com/uuid",
        "javascript:alert(1)",
        "chrome-extension://abc/id.html",
    ])
    def test_scheme_not_allowed(self, url):
        verdict = self._validate(url)
        assert verdict.allowed is False
        assert verdict.reason == "scheme_not_allowed"

    @pytest.mark.parametrize("url", [
        "http:///no-host",
        "http://",
        "",
        "   ",
    ])
    def test_invalid_url(self, url):
        verdict = self._validate(url)
        assert verdict.allowed is False
        assert verdict.reason == "invalid_url"

    @pytest.mark.parametrize("host", [
        # IPv4 loopback / RFC1918 / link-local / unspecified / CGNAT
        "127.0.0.1",
        "127.8.8.8",
        "10.1.2.3",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.1",
        "169.254.169.254",  # cloud metadata endpoint
        "0.0.0.0",
        "0.1.2.3",
        "100.64.0.1",
        "100.127.255.255",
        # IPv6 loopback / unique-local / link-local / unspecified
        "::1",
        "fc00::1",
        "fd12:3456:789a::1",
        "fe80::1",
        "::",
        # v4-mapped IPv6 evaluated against the v4 rules
        "::ffff:127.0.0.1",
        "::ffff:169.254.169.254",
        # integer / hex encodings that normalize to blocked v4
        "2130706433",  # 127.0.0.1
        "0x7f000001",  # 127.0.0.1
        "0x0a000001",  # 10.0.0.1
    ])
    def test_private_address_not_allowed(self, host):
        verdict = self._validate(f"http://{host}/")
        assert verdict.allowed is False, f"http://{host}/ should be blocked"
        assert verdict.reason == "private_address_not_allowed"

    @pytest.mark.parametrize("host", [
        "[::1]",
        "[fc00::1]",
        "[fe80::1]",
        "[::ffff:127.0.0.1]",
    ])
    def test_bracketed_ipv6_blocked(self, host):
        verdict = self._validate(f"http://{host}/")
        assert verdict.allowed is False
        assert verdict.reason == "private_address_not_allowed"

    def test_hostname_is_never_resolved(self):
        """Literal-only v1: a hostname is judged as written — no DNS
        lookup happens (so a name that WOULD resolve private is allowed)."""
        verdict = self._validate("http://metadata.internal.example/")
        assert verdict.allowed is True


# ---------------------------------------------------------------------------
# 5.4 — route-level: create_session rejects before any persistence
# ---------------------------------------------------------------------------


class TestSessionCreateUrlValidation:
    """create_session validates the URL before any DB write, directory
    creation, or quota accounting; rejections are 400 url_not_allowed."""

    @pytest.mark.asyncio
    async def test_valid_https_creates_session(self, sqlite_db, _tmp_storage):
        from app.api.routes.sessions import create_session

        _engine, factory = sqlite_db
        client = _make_client()
        await _seed(factory, client)

        async with factory() as db:
            await create_session(
                _body("https://example.com/page"), client=client, db=db,
            )
            await db.commit()

        async with factory() as db:
            row = (await db.execute(
                select(Session).where(Session.client_id == client.id)
            )).scalar_one()
        assert row.url == "https://example.com/page"
        # The session storage directory IS created for accepted URLs.
        assert os.path.isdir(os.path.join(str(_tmp_storage), row.id, "resources"))

    @pytest.mark.asyncio
    async def test_public_ip_literal_creates_session(self, sqlite_db):
        from app.api.routes.sessions import create_session

        _engine, factory = sqlite_db
        client = _make_client()
        await _seed(factory, client)

        async with factory() as db:
            await create_session(
                _body("http://93.184.216.34/"), client=client, db=db,
            )
            await db.commit()

        assert await _session_count(factory, client.id) == 1

    @pytest.mark.parametrize("url,reason", [
        ("file:///etc/passwd", "scheme_not_allowed"),
        ("data:text/html,hello", "scheme_not_allowed"),
        ("ftp://example.com/pub", "scheme_not_allowed"),
        ("http:///no-host", "invalid_url"),
        ("http://127.0.0.1/", "private_address_not_allowed"),
        ("http://10.0.0.5/", "private_address_not_allowed"),
        ("http://172.16.1.1/", "private_address_not_allowed"),
        ("http://192.168.0.42/", "private_address_not_allowed"),
        ("http://169.254.169.254/latest/meta-data/",
         "private_address_not_allowed"),
        ("http://0.0.0.0/", "private_address_not_allowed"),
        ("http://100.64.1.1/", "private_address_not_allowed"),
        ("http://[::1]/", "private_address_not_allowed"),
        ("http://[fc00::1]/", "private_address_not_allowed"),
        ("http://[fe80::1]/", "private_address_not_allowed"),
        ("http://[::]/", "private_address_not_allowed"),
        ("http://[::ffff:127.0.0.1]/", "private_address_not_allowed"),
        ("http://2130706433/", "private_address_not_allowed"),
        ("http://0x7f000001/", "private_address_not_allowed"),
    ])
    @pytest.mark.asyncio
    async def test_rejected_url_leaves_no_row_and_no_directory(
        self, sqlite_db, _tmp_storage, url, reason,
    ):
        from app.api.routes.sessions import create_session

        _engine, factory = sqlite_db
        client = _make_client()
        await _seed(factory, client)

        async with factory() as db:
            with pytest.raises(HTTPException) as exc:
                await create_session(_body(url), client=client, db=db)

        assert exc.value.status_code == 400
        assert exc.value.detail["error"] == "url_not_allowed"
        assert exc.value.detail["reason"] == reason
        assert exc.value.detail["api_version"] == "v1"
        assert "message" in exc.value.detail

        # No session row persisted.
        assert await _session_count(factory) == 0, (
            f"a rejected url ({url}) must not create a session row"
        )
        # No session storage directory created either.
        assert os.listdir(str(_tmp_storage)) == [], (
            f"a rejected url ({url}) must not create a storage directory"
        )

    @pytest.mark.asyncio
    async def test_rejection_precedes_quota_accounting(
        self, sqlite_db, monkeypatch,
    ):
        """A URL-rejected request consumes no daily quota budget: the same
        client can still create up to the full daily cap afterwards."""
        from app.api.routes.sessions import create_session

        _engine, factory = sqlite_db
        client = _make_client()
        await _seed(factory, client)
        monkeypatch.setattr(settings, "max_sessions_per_client_per_day", 2)

        async with factory() as db:
            with pytest.raises(HTTPException):
                await create_session(
                    _body("file:///etc/passwd"), client=client, db=db,
                )

        for i in range(2):
            async with factory() as db:
                await create_session(
                    _body(f"https://example.com/{i}"), client=client, db=db,
                )
                await db.commit()

        # Exactly the cap was accepted — the rejected request burned nothing.
        async with factory() as db:
            with pytest.raises(HTTPException) as exc:
                await create_session(
                    _body("https://example.com/over"), client=client, db=db,
                )
        assert exc.value.status_code == 429
        assert exc.value.detail["limit_type"] == "daily_creations"


# ---------------------------------------------------------------------------
# 5.5 — per-client session-creation quota
# ---------------------------------------------------------------------------


class TestSessionCreationQuota:
    """D5: active-session cap + rolling 24h creation cap, enforced before
    insert; 429 session_limit_exceeded with limit_type/limit/retry_after."""

    CLIENT_ID = "quota-client"

    async def _seed_active(self, factory, n):
        for i in range(n):
            await _seed_session(
                factory, session_id=f"{self.CLIENT_ID}-act-{i}",
                client_id=self.CLIENT_ID, status=SessionStatus.SCRAPING,
            )

    @pytest.mark.asyncio
    async def test_active_cap_rejects_further_creation(
        self, sqlite_db, monkeypatch,
    ):
        from app.api.routes.sessions import create_session

        _engine, factory = sqlite_db
        client = _make_client(self.CLIENT_ID)
        await _seed(factory, client)
        await self._seed_active(factory, 3)
        monkeypatch.setattr(settings, "max_active_sessions_per_client", 3)

        async with factory() as db:
            with pytest.raises(HTTPException) as exc:
                await create_session(
                    _body("https://example.com/over-cap"), client=client,
                    db=db,
                )

        assert exc.value.status_code == 429
        assert exc.value.detail["error"] == "session_limit_exceeded"
        assert exc.value.detail["limit_type"] == "active_sessions"
        assert exc.value.detail["limit"] == 3
        assert exc.value.detail["api_version"] == "v1"
        # Completion time is unknowable — no Retry-After header (D5).
        assert "Retry-After" not in (exc.value.headers or {})
        # Rejection leaves no row.
        assert await _session_count(factory, self.CLIENT_ID) == 3

    @pytest.mark.asyncio
    async def test_terminal_transition_frees_active_budget(
        self, sqlite_db, monkeypatch,
    ):
        from app.api.routes.sessions import create_session

        _engine, factory = sqlite_db
        client = _make_client(self.CLIENT_ID)
        await _seed(factory, client)
        await self._seed_active(factory, 3)
        monkeypatch.setattr(settings, "max_active_sessions_per_client", 3)

        async with factory() as db:
            with pytest.raises(HTTPException):
                await create_session(
                    _body("https://example.com/at-cap"), client=client,
                    db=db,
                )

        # One session reaches a terminal status.
        async with factory() as db:
            await db.execute(
                update(Session)
                .where(Session.id == f"{self.CLIENT_ID}-act-0")
                .values(status=SessionStatus.READY)
            )
            await db.commit()

        async with factory() as db:
            response = await create_session(
                _body("https://example.com/freed"), client=client, db=db,
            )
            await db.commit()
        assert response.status == SessionStatus.SCRAPING.value

    @pytest.mark.asyncio
    async def test_daily_cap_rejects_with_accurate_retry_after(
        self, sqlite_db, monkeypatch,
    ):
        from app.api.routes.sessions import create_session

        _engine, factory = sqlite_db
        client = _make_client(self.CLIENT_ID)
        await _seed(factory, client)
        monkeypatch.setattr(settings, "max_sessions_per_client_per_day", 5)
        hour_ago = datetime.now(timezone.utc) - timedelta(hours=1)
        for i in range(5):
            await _seed_session(
                factory, session_id=f"{self.CLIENT_ID}-day-{i}",
                client_id=self.CLIENT_ID, status=SessionStatus.READY,
                created_at=hour_ago,
            )

        async with factory() as db:
            with pytest.raises(HTTPException) as exc:
                await create_session(
                    _body("https://example.com/over-daily"), client=client,
                    db=db,
                )

        assert exc.value.status_code == 429
        assert exc.value.detail["error"] == "session_limit_exceeded"
        assert exc.value.detail["limit_type"] == "daily_creations"
        assert exc.value.detail["limit"] == 5

        # Oldest in-window creation is 1h old → ~23h until it ages out.
        expected = 23 * 3600
        body_retry = exc.value.detail["retry_after"]
        assert abs(body_retry - expected) <= 90, (
            f"retry_after={body_retry} not ≈ {expected}s"
        )
        # The daily case emits the accurate Retry-After HEADER.
        assert exc.value.headers is not None
        assert exc.value.headers["Retry-After"] == str(body_retry)
        # Monotonic-clock-safe: never negative.
        assert body_retry >= 0

        assert await _session_count(factory, self.CLIENT_ID) == 5, (
            "a quota-rejected create must leave no session row"
        )

    @pytest.mark.asyncio
    async def test_daily_retry_after_tracks_oldest_in_window(
        self, sqlite_db, monkeypatch,
    ):
        """The hint ages with the OLDEST in-window creation, not the newest."""
        from app.api.routes.sessions import create_session

        _engine, factory = sqlite_db
        client = _make_client(self.CLIENT_ID)
        await _seed(factory, client)
        monkeypatch.setattr(settings, "max_sessions_per_client_per_day", 2)
        nearly_day_old = datetime.now(timezone.utc) - timedelta(hours=23)
        await _seed_session(
            factory, session_id=f"{self.CLIENT_ID}-old",
            client_id=self.CLIENT_ID, status=SessionStatus.READY,
            created_at=nearly_day_old,
        )
        await _seed_session(
            factory, session_id=f"{self.CLIENT_ID}-new",
            client_id=self.CLIENT_ID, status=SessionStatus.READY,
            created_at=datetime.now(timezone.utc),
        )

        async with factory() as db:
            with pytest.raises(HTTPException) as exc:
                await create_session(
                    _body("https://example.com/oldest-wins"), client=client,
                    db=db,
                )

        expected = 1 * 3600  # oldest is 23h old → ~1h left
        assert abs(exc.value.detail["retry_after"] - expected) <= 90

    @pytest.mark.asyncio
    async def test_out_of_window_creations_do_not_count(
        self, sqlite_db, monkeypatch,
    ):
        """The rolling window is trailing-24h: older creations don't count."""
        from app.api.routes.sessions import create_session

        _engine, factory = sqlite_db
        client = _make_client(self.CLIENT_ID)
        await _seed(factory, client)
        monkeypatch.setattr(settings, "max_sessions_per_client_per_day", 2)
        day_and_a_half = datetime.now(timezone.utc) - timedelta(hours=36)
        await _seed_session(
            factory, session_id=f"{self.CLIENT_ID}-stale-1",
            client_id=self.CLIENT_ID, status=SessionStatus.READY,
            created_at=day_and_a_half,
        )
        await _seed_session(
            factory, session_id=f"{self.CLIENT_ID}-stale-2",
            client_id=self.CLIENT_ID, status=SessionStatus.READY,
            created_at=day_and_a_half,
        )

        # Both in-window slots are free despite 2 existing rows.
        async with factory() as db:
            await create_session(
                _body("https://example.com/fresh-1"), client=client, db=db,
            )
            await db.commit()

        assert await _session_count(factory, self.CLIENT_ID) == 3

    @pytest.mark.asyncio
    async def test_quota_independent_per_client(self, sqlite_db, monkeypatch):
        from app.api.routes.sessions import create_session

        _engine, factory = sqlite_db
        client_a = _make_client(self.CLIENT_ID)
        client_b = _make_client("other-client")
        await _seed(factory, client_a, client_b)
        await self._seed_active(factory, 3)
        monkeypatch.setattr(settings, "max_active_sessions_per_client", 3)

        # Client A is at the cap…
        async with factory() as db:
            with pytest.raises(HTTPException) as exc:
                await create_session(
                    _body("https://example.com/a-blocked"), client=client_a,
                    db=db,
                )
        assert exc.value.status_code == 429
        assert exc.value.detail["limit_type"] == "active_sessions"

        # …but client B is unaffected.
        async with factory() as db:
            response = await create_session(
                _body("https://example.com/b-fine"), client=client_b, db=db,
            )
            await db.commit()
        assert response.url == "https://example.com/b-fine"
