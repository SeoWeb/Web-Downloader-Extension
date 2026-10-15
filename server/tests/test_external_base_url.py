"""Tests for external_base_url (deployment-routing: download_url behind proxy).

The monolith is reached in production as https://server.pagepocket.app through
a same-host nginx while uvicorn listens on plain http://0.0.0.0:8000. The
helper makes the forwarded-header preference explicit: X-Forwarded-Proto /
X-Forwarded-Host win when the peer is a trusted proxy (settings.trust_proxy —
the same gate as client-IP resolution, 7.8); anything else falls back to the
request's own base URL (which uvicorn's proxy_headers handling may already
have rewritten for forwarded_allow_ips peers).
"""

import pytest
from app.api.routes.sessions import external_base_url
from starlette.requests import Request


def _request(headers=None, scheme="http", host="internal:8000"):
    """Build a minimal starlette Request the way uvicorn would deliver it."""
    hdrs = [
        (k.lower().encode(), v.encode()) for k, v in (headers or {}).items()
    ]
    if not any(k == b"host" for k, _ in hdrs):
        hdrs.append((b"host", host.encode()))
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/api/v1/sessions/sess-1/status",
        "headers": hdrs,
        "query_string": b"",
        "client": ("127.0.0.1", 55555),
        "server": ("testserver", 80),
        "scheme": scheme,
    }
    return Request(scope)


class TestExternalBaseUrl:
    def test_no_proxy_headers_uses_request_base_url(self, monkeypatch):
        monkeypatch.setattr("app.config.settings.trust_proxy", True)
        assert external_base_url(_request()) == "http://internal:8000"

    def test_trusted_proxy_forwarded_proto_and_host_win(self, monkeypatch):
        monkeypatch.setattr("app.config.settings.trust_proxy", True)
        req = _request(headers={
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "server.pagepocket.app",
        })
        assert external_base_url(req) == "https://server.pagepocket.app"

    def test_untrusted_peer_forwarded_headers_ignored(self, monkeypatch):
        """Without trust_proxy the headers are spoofable — base_url wins."""
        monkeypatch.setattr("app.config.settings.trust_proxy", False)
        req = _request(headers={
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "evil.example.com",
        })
        assert external_base_url(req) == "http://internal:8000"

    def test_forwarded_proto_only_swaps_scheme(self, monkeypatch):
        monkeypatch.setattr("app.config.settings.trust_proxy", True)
        req = _request(headers={"X-Forwarded-Proto": "https"})
        assert external_base_url(req) == "https://internal:8000"

    def test_forwarded_host_only_swaps_host(self, monkeypatch):
        monkeypatch.setattr("app.config.settings.trust_proxy", True)
        req = _request(headers={"X-Forwarded-Host": "server.pagepocket.app"})
        assert external_base_url(req) == "http://server.pagepocket.app"

    def test_unknown_forwarded_scheme_ignored(self, monkeypatch):
        monkeypatch.setattr("app.config.settings.trust_proxy", True)
        req = _request(headers={"X-Forwarded-Proto": "ftp"})
        assert external_base_url(req) == "http://internal:8000"

    def test_malformed_forwarded_host_ignored(self, monkeypatch):
        """Path/authority characters in the header must not leak into URLs."""
        monkeypatch.setattr("app.config.settings.trust_proxy", True)
        for bad_host in ("evil.com/steal", "evil.com:8080/x", ""):
            req = _request(headers={"X-Forwarded-Host": bad_host})
            assert external_base_url(req) == "http://internal:8000"

    def test_forwarded_host_with_port_accepted(self, monkeypatch):
        monkeypatch.setattr("app.config.settings.trust_proxy", True)
        req = _request(headers={"X-Forwarded-Host": "server.pagepocket.app:8443"})
        assert external_base_url(req) == "http://server.pagepocket.app:8443"

    def test_first_value_of_chained_headers_wins(self, monkeypatch):
        """Leftmost value is the client-facing one in a proxy chain."""
        monkeypatch.setattr("app.config.settings.trust_proxy", True)
        req = _request(headers={
            "X-Forwarded-Proto": "https, http",
            "X-Forwarded-Host": "server.pagepocket.app, internal:8000",
        })
        assert external_base_url(req) == "https://server.pagepocket.app"


# ---------------------------------------------------------------------------
# Route wiring: the status route builds download_url via the helper
# ---------------------------------------------------------------------------


class TestStatusRouteDownloadUrl:
    @pytest.fixture
    def ready_session_factory(self):
        from datetime import datetime, timedelta, timezone

        from app.models.client import Client
        from app.models.session import Session, SessionStatus

        def _seed(factory):
            return [
                Client(id="client-dl", api_key="k-dl",
                       api_key_hash=Client.hash_key("k-dl")),
                Session(
                    id="sess-dl", client_id="client-dl",
                    url="https://example.com",
                    status=SessionStatus.READY,
                    zip_path="/nonexistent/nothing.zip",  # size lookup skipped
                    expires_at=datetime.now(timezone.utc) + timedelta(days=1),
                ),
            ]

        return _seed

    @pytest.mark.asyncio
    async def test_download_url_uses_forwarded_headers_when_trusted(
        self, sqlite_db, monkeypatch, ready_session_factory
    ):
        from app.api.routes.sessions import get_session_status
        from app.models.client import Client
        from sqlalchemy import select

        _engine, factory = sqlite_db
        monkeypatch.setattr("app.config.settings.trust_proxy", True)

        async with factory() as db:
            for obj in ready_session_factory(factory):
                db.add(obj)
            await db.commit()
            client = (await db.execute(
                select(Client).where(Client.id == "client-dl")
            )).scalar_one()

            resp = await get_session_status(
                session_id="sess-dl",
                request=_request(headers={
                    "X-Forwarded-Proto": "https",
                    "X-Forwarded-Host": "server.pagepocket.app",
                }),
                client=client,
                db=db,
            )

        assert resp.download_url == (
            "https://server.pagepocket.app/api/v1/sessions/sess-dl/download"
        )

    @pytest.mark.asyncio
    async def test_download_url_falls_back_without_trust(
        self, sqlite_db, monkeypatch, ready_session_factory
    ):
        from app.api.routes.sessions import get_session_status
        from app.models.client import Client
        from sqlalchemy import select

        _engine, factory = sqlite_db
        monkeypatch.setattr("app.config.settings.trust_proxy", False)

        async with factory() as db:
            for obj in ready_session_factory(factory):
                db.add(obj)
            await db.commit()
            client = (await db.execute(
                select(Client).where(Client.id == "client-dl")
            )).scalar_one()

            resp = await get_session_status(
                session_id="sess-dl",
                request=_request(headers={
                    "X-Forwarded-Proto": "https",
                    "X-Forwarded-Host": "evil.example.com",
                }),
                client=client,
                db=db,
            )

        assert resp.download_url == (
            "http://internal:8000/api/v1/sessions/sess-dl/download"
        )
