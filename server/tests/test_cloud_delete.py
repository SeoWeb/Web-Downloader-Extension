"""Tests for opt-in federated cloud delete + the DeletePage wrapper.

Covers close-cloud-lifecycle-gaps:

  2.1 — archive_client.delete_page: thin sync DeletePage wrapper on the
        push channel/identity, short single-attempt deadline, NOT_FOUND →
        already-deleted idempotent success.

  2.2/2.3 — delete_session with the delete_cloud query parameter: gate
        (opt-in AND cloud_status == "success" AND cloud_page_id AND binding
        match), local-first authoritative deletion, failure-isolated cloud
        outcome, and the new response shape
        {"deleted": true, "cloud": ..., "api_version": "v1"}.

Route tests run against a real SQLite database (see conftest) so the
local-deletion semantics are exercised; delete_page tests mock the gRPC
stub, following the push-test conventions in test_cloud_assembly.py.
"""

import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import func as sa_func
from sqlalchemy import select as sa_select

from app.models.client import Client
from app.models.session import Session, SessionStatus

# ---------------------------------------------------------------------------
# Proto stubs: make archive_pb2 importable the same way archive_client does.
# ---------------------------------------------------------------------------

_PROTO_DIR = os.path.normpath(os.path.join(
    os.path.dirname(__file__), "..", "..", "pagepocket", "shared", "proto_generated",
))
if os.path.isdir(_PROTO_DIR) and _PROTO_DIR not in sys.path:
    sys.path.insert(0, _PROTO_DIR)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_client(client_id="client-1", api_key="key-1",
                 pagepocket_user_id=None) -> Client:
    return Client(
        id=client_id,
        api_key=api_key,
        api_key_hash=Client.hash_key(api_key),
        extension_instance_id=f"inst-{client_id}",
        pagepocket_user_id=pagepocket_user_id,
    )


def _make_session(client_id="client-1", pagepocket_user_id=None,
                  cloud_status=None, cloud_page_id=None) -> Session:
    now = datetime.now(timezone.utc)
    return Session(
        id=str(uuid.uuid4()),
        client_id=client_id,
        url="https://example.com",
        status=SessionStatus.READY,
        options={"singleFile": False, "retentionDays": 3},
        expires_at=now + timedelta(days=3),
        pagepocket_user_id=pagepocket_user_id,
        cloud_status=cloud_status,
        cloud_page_id=cloud_page_id,
    )


async def _seed_db(factory, *objects):
    async with factory() as db:
        for obj in objects:
            db.add(obj)
        await db.commit()


@pytest.fixture(autouse=True)
def _tmp_storage(tmp_path, monkeypatch):
    """Session-dir removal stays inside the test sandbox."""
    from app.config import settings

    monkeypatch.setattr(settings, "storage_root", str(tmp_path))


class FakeRpcError(Exception):
    """Duck-typed grpc.RpcError carrying code()/details() for classification."""

    def __init__(self, code, details):
        super().__init__(details)
        self._code = code
        self._details = details

    def code(self):
        return self._code

    def details(self):
        return self._details


# ---------------------------------------------------------------------------
# 2.1 — archive_client.delete_page
# ---------------------------------------------------------------------------


class TestDeletePage:
    """Thin sync DeletePage wrapper on the push channel/identity."""

    def _patch_stub(self, monkeypatch, stub):
        from app.services import archive_client

        monkeypatch.setattr(archive_client, "_get_stub", lambda: stub)
        return archive_client

    def test_delete_page_success(self, monkeypatch):
        """Deleted → result carries the request identity + short deadline."""
        pytest.importorskip("archive_pb2", reason="proto stubs not available")
        from app.services import archive_client

        captured = {}
        stub = MagicMock()

        def _capture(request, timeout=None):
            captured["request"] = request
            captured["timeout"] = timeout
            return SimpleNamespace(success=True, message="")

        stub.DeletePage.side_effect = _capture
        self._patch_stub(monkeypatch, stub)

        result = archive_client.delete_page("pp-user-1", "page-1")

        assert result.deleted is True
        assert result.error is None
        assert captured["request"].user_id == "pp-user-1"
        assert captured["request"].page_id == "page-1"
        # Short unary deadline, single attempt — no retry budget.
        assert captured["timeout"] == archive_client.DELETE_TIMEOUT_SECONDS
        assert stub.DeletePage.call_count == 1

    def test_delete_page_not_found_rpc_error_maps_to_success(self, monkeypatch):
        """Raised NOT_FOUND → already-deleted idempotent success."""
        from app.services import archive_client

        stub = MagicMock()
        stub.DeletePage.side_effect = FakeRpcError("NOT_FOUND", "Page not found")
        self._patch_stub(monkeypatch, stub)

        result = archive_client.delete_page("pp-user-1", "page-gone")

        assert result.deleted is True
        assert result.error is None

    def test_delete_page_not_found_status_response_maps_to_success(self, monkeypatch):
        """The archive servicer signals a missing page as success=False,
        message="not found" (no abort) — also idempotent success."""
        from app.services import archive_client

        stub = MagicMock()
        stub.DeletePage.return_value = SimpleNamespace(
            success=False, message="not found",
        )
        self._patch_stub(monkeypatch, stub)

        result = archive_client.delete_page("pp-user-1", "page-gone")

        assert result.deleted is True
        assert result.error is None

    def test_delete_page_other_rpc_error_is_failure(self, monkeypatch):
        """UNAVAILABLE (etc.) → not deleted, error detail carried."""
        from app.services import archive_client

        stub = MagicMock()
        stub.DeletePage.side_effect = FakeRpcError("UNAVAILABLE", "connection refused")
        self._patch_stub(monkeypatch, stub)

        result = archive_client.delete_page("pp-user-1", "page-1")

        assert result.deleted is False
        assert "connection refused" in result.error

    def test_delete_page_failure_status_is_error(self, monkeypatch):
        """success=False without a not-found message → failure."""
        from app.services import archive_client

        stub = MagicMock()
        stub.DeletePage.return_value = SimpleNamespace(
            success=False, message="backend error",
        )
        self._patch_stub(monkeypatch, stub)

        result = archive_client.delete_page("pp-user-1", "page-1")

        assert result.deleted is False
        assert result.error == "backend error"

    def test_delete_page_unconfigured_service_is_failure(self, monkeypatch):
        from app.services import archive_client

        monkeypatch.setattr(archive_client, "_get_stub", lambda: None)

        result = archive_client.delete_page("pp-user-1", "page-1")

        assert result.deleted is False
        assert "not configured" in result.error


# ---------------------------------------------------------------------------
# 2.2/2.3/2.5 — delete_session opt-in cloud delete
# ---------------------------------------------------------------------------


class TestDeleteSessionCloudGate:
    """delete_session: gate, failure isolation, and the new response shape."""

    async def _seed_bound_pair(self, factory, *, client_user="pp-user-1",
                               session_user="pp-user-1", cloud_status="success",
                               cloud_page_id="page-1"):
        client = _make_client(pagepocket_user_id=client_user)
        session = _make_session(
            client_id=client.id,
            pagepocket_user_id=session_user,
            cloud_status=cloud_status,
            cloud_page_id=cloud_page_id,
        )
        await _seed_db(factory, client, session)
        return client, session

    async def _session_count(self, factory) -> int:
        async with factory() as db:
            return (await db.execute(
                sa_select(sa_func.count()).select_from(Session)
            )).scalar()

    @pytest.mark.asyncio
    async def test_opted_in_delete_calls_cloud_rpc_with_page_id(self, sqlite_db):
        from app.api.routes.sessions import delete_session
        from app.services import archive_client

        _engine, factory = sqlite_db
        client, session = await self._seed_bound_pair(factory)

        with patch.object(
            archive_client, "delete_page",
            return_value=archive_client.CloudDeleteResult(deleted=True),
        ) as mock_delete:
            async with factory() as db:
                attached = (await db.execute(
                    sa_select(Client).where(Client.id == client.id)
                )).scalar_one()
                response = await delete_session(
                    session.id, delete_cloud=True, client=attached, db=db,
                )
                await db.commit()

        mock_delete.assert_called_once_with("pp-user-1", "page-1")
        assert response == {
            "deleted": True,
            "cloud": {"deleted": True},
            "api_version": "v1",
        }
        assert await self._session_count(factory) == 0

    @pytest.mark.asyncio
    async def test_opted_in_delete_missing_cloud_page_is_success(self, sqlite_db,
                                                                 monkeypatch):
        """Real delete_page + NOT_FOUND stub → cloud {deleted: true}."""
        pytest.importorskip("archive_pb2", reason="proto stubs not available")
        from app.api.routes.sessions import delete_session
        from app.services import archive_client

        _engine, factory = sqlite_db
        client, session = await self._seed_bound_pair(factory)

        stub = MagicMock()
        stub.DeletePage.side_effect = FakeRpcError("NOT_FOUND", "not found")
        monkeypatch.setattr(archive_client, "_get_stub", lambda: stub)

        async with factory() as db:
            attached = (await db.execute(
                sa_select(Client).where(Client.id == client.id)
            )).scalar_one()
            response = await delete_session(
                session.id, delete_cloud=True, client=attached, db=db,
            )
            await db.commit()

        stub.DeletePage.assert_called_once()
        assert response == {
            "deleted": True,
            "cloud": {"deleted": True},
            "api_version": "v1",
        }

    @pytest.mark.asyncio
    async def test_default_delete_makes_no_cloud_rpc(self, sqlite_db):
        """No delete_cloud param → local-only delete, zero cloud calls."""
        from app.api.routes.sessions import delete_session
        from app.services import archive_client

        _engine, factory = sqlite_db
        client, session = await self._seed_bound_pair(factory)

        with patch.object(archive_client, "delete_page") as mock_delete, \
             patch.object(archive_client, "_get_stub") as mock_stub:
            async with factory() as db:
                attached = (await db.execute(
                    sa_select(Client).where(Client.id == client.id)
                )).scalar_one()
                response = await delete_session(
                    session.id, client=attached, db=db,
                )
                await db.commit()

        mock_delete.assert_not_called()
        mock_stub.assert_not_called()
        assert response == {
            "deleted": True,
            "cloud": {"deleted": False, "reason": "not_requested"},
            "api_version": "v1",
        }
        assert await self._session_count(factory) == 0

    @pytest.mark.asyncio
    async def test_binding_mismatch_skips_cloud_delete(self, sqlite_db):
        """Caller re-bound to another PP user → skip, local delete proceeds."""
        from app.api.routes.sessions import delete_session
        from app.services import archive_client

        _engine, factory = sqlite_db
        client, session = await self._seed_bound_pair(
            factory, client_user="pp-user-OTHER",
        )

        with patch.object(archive_client, "delete_page") as mock_delete:
            async with factory() as db:
                attached = (await db.execute(
                    sa_select(Client).where(Client.id == client.id)
                )).scalar_one()
                response = await delete_session(
                    session.id, delete_cloud=True, client=attached, db=db,
                )
                await db.commit()

        mock_delete.assert_not_called()
        assert response["cloud"] == {
            "deleted": False, "reason": "binding_mismatch",
        }
        assert response["deleted"] is True
        assert await self._session_count(factory) == 0

    @pytest.mark.asyncio
    async def test_unbound_caller_skips_with_binding_mismatch(self, sqlite_db):
        """D1 tie-in: an unbound client (e.g. after logout) is not the owner."""
        from app.api.routes.sessions import delete_session
        from app.services import archive_client

        _engine, factory = sqlite_db
        client, session = await self._seed_bound_pair(
            factory, client_user=None,
        )

        with patch.object(archive_client, "delete_page") as mock_delete:
            async with factory() as db:
                attached = (await db.execute(
                    sa_select(Client).where(Client.id == client.id)
                )).scalar_one()
                response = await delete_session(
                    session.id, delete_cloud=True, client=attached, db=db,
                )
                await db.commit()

        mock_delete.assert_not_called()
        assert response["cloud"] == {
            "deleted": False, "reason": "binding_mismatch",
        }
        assert await self._session_count(factory) == 0

    @pytest.mark.parametrize(
        "cloud_status,cloud_page_id",
        [
            ("failed", "page-1"),   # push never succeeded
            ("success", None),      # no cloud page id
            (None, None),           # local-only session
        ],
    )
    @pytest.mark.asyncio
    async def test_non_cloud_session_skips_with_not_cloud(
        self, sqlite_db, cloud_status, cloud_page_id,
    ):
        from app.api.routes.sessions import delete_session
        from app.services import archive_client

        _engine, factory = sqlite_db
        client, session = await self._seed_bound_pair(
            factory, cloud_status=cloud_status, cloud_page_id=cloud_page_id,
        )

        with patch.object(archive_client, "delete_page") as mock_delete:
            async with factory() as db:
                attached = (await db.execute(
                    sa_select(Client).where(Client.id == client.id)
                )).scalar_one()
                response = await delete_session(
                    session.id, delete_cloud=True, client=attached, db=db,
                )
                await db.commit()

        mock_delete.assert_not_called()
        assert response["cloud"] == {"deleted": False, "reason": "not_cloud"}
        assert response["deleted"] is True
        assert await self._session_count(factory) == 0

    @pytest.mark.asyncio
    async def test_cloud_rpc_crash_never_fails_local_delete(self, sqlite_db):
        """DeletePage raising → 200, cloud_error reason, session still gone."""
        from app.api.routes.sessions import delete_session
        from app.services import archive_client

        _engine, factory = sqlite_db
        client, session = await self._seed_bound_pair(factory)

        with patch.object(
            archive_client, "delete_page",
            side_effect=RuntimeError("grpc channel closed"),
        ):
            async with factory() as db:
                attached = (await db.execute(
                    sa_select(Client).where(Client.id == client.id)
                )).scalar_one()
                response = await delete_session(
                    session.id, delete_cloud=True, client=attached, db=db,
                )
                await db.commit()

        assert response["deleted"] is True
        assert response["cloud"] == {"deleted": False, "reason": "cloud_error"}
        assert response["api_version"] == "v1"
        assert await self._session_count(factory) == 0
