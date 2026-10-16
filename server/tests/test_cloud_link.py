"""Tests for cloud identity binding and push identity (3.1, 3.2).

Covers harden-backend-security-and-ops:

  3.1 — POST /api/v1/cloud/link: bind a PagePocket user (verified via
        AuthService.Verify) to the API-key client; session creation accepts
        options.pagepocketUserId only when it matches the binding.

  3.2 — the cloud push (IngestPageRequest) ALWAYS carries the bound
        user_id and the binding plan (never omitted, never client-supplied).

Binding/session tests run against a real SQLite database (see conftest) so
SQLAlchemy persistence semantics are exercised; push tests mock the gRPC
stub and assert on the built protobuf request.
"""

import asyncio
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

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


def _make_client(client_id="client-1", api_key="key-1", pagepocket_user_id=None,
                 pagepocket_plan=None) -> Client:
    return Client(
        id=client_id,
        api_key=api_key,
        api_key_hash=Client.hash_key(api_key),
        extension_instance_id=f"inst-{client_id}",
        pagepocket_user_id=pagepocket_user_id,
        pagepocket_plan=pagepocket_plan,
    )


async def _seed_db(factory, *objects):
    async with factory() as db:
        for obj in objects:
            db.add(obj)
        await db.commit()


# ---------------------------------------------------------------------------
# 3.1 — POST /api/v1/cloud/link
# ---------------------------------------------------------------------------


class TestCloudLink:
    """Binding flow: verify token via AuthService, store on the client row."""

    @pytest.fixture
    def linked_verify(self):
        """Patch auth_client with a successful verification."""
        from app.services import auth_client
        from app.services.auth_client import VerifyResult

        with patch.object(auth_client, "is_configured", return_value=True), \
             patch.object(
                 auth_client, "verify_token",
                 return_value=VerifyResult(
                     valid=True, user_id="pp-user-1", email="u@x.io", plan="pro",
                 ),
             ) as mock_verify:
            yield mock_verify

    @pytest.mark.asyncio
    async def test_bind_success_stores_user_and_plan(self, sqlite_db, linked_verify):
        from app.api.routes.cloud import CloudLinkRequest, cloud_link

        _engine, factory = sqlite_db
        client = _make_client()
        await _seed_db(factory, client)

        async with factory() as db:
            from sqlalchemy import select as sa_select
            # Re-attach the client to THIS db session (the binding write must
            # flow through the session that commits it).
            attached = (await db.execute(
                sa_select(Client).where(Client.id == client.id)
            )).scalar_one()
            response = await cloud_link(
                CloudLinkRequest(access_token="tok-123"),
                client=attached,
                db=db,
            )
            await db.commit()

        assert response.bound is True
        assert response.pagepocket_user_id == "pp-user-1"
        assert response.plan == "pro"

        # Binding persisted on the client row (server-side, not session data)
        async with factory() as db:
            from sqlalchemy import select as sa_select
            fresh = (await db.execute(
                sa_select(Client).where(Client.id == client.id)
            )).scalar_one()
            assert fresh.pagepocket_user_id == "pp-user-1"
            assert fresh.pagepocket_plan == "pro"
            assert fresh.pagepocket_linked_at is not None

        linked_verify.assert_called_once_with("tok-123")

    @pytest.mark.asyncio
    async def test_bind_invalid_token_returns_401_and_stores_nothing(self, sqlite_db):
        from app.api.routes.cloud import CloudLinkRequest, cloud_link
        from app.services import auth_client
        from app.services.auth_client import VerifyResult

        _engine, factory = sqlite_db
        client = _make_client()
        await _seed_db(factory, client)

        with patch.object(auth_client, "is_configured", return_value=True), \
             patch.object(
                 auth_client, "verify_token",
                 return_value=VerifyResult(valid=False, error="rejected"),
             ):
            async with factory() as db:
                with pytest.raises(HTTPException) as exc:
                    await cloud_link(
                        CloudLinkRequest(access_token="bad-token"),
                        client=client,
                        db=db,
                    )

        assert exc.value.status_code == 401
        assert exc.value.detail["error"] == "invalid_pagepocket_token"

        # Nothing stored
        async with factory() as db:
            from sqlalchemy import select as sa_select
            fresh = (await db.execute(
                sa_select(Client).where(Client.id == client.id)
            )).scalar_one()
            assert fresh.pagepocket_user_id is None
            assert fresh.pagepocket_plan is None

    @pytest.mark.asyncio
    async def test_rebind_updates_plan(self, sqlite_db):
        """Re-running the link flow refreshes the binding and plan (spec)."""
        from app.api.routes.cloud import CloudLinkRequest, cloud_link
        from app.services import auth_client
        from app.services.auth_client import VerifyResult

        _engine, factory = sqlite_db
        client = _make_client(
            pagepocket_user_id="pp-user-1", pagepocket_plan="free",
        )
        await _seed_db(factory, client)

        with patch.object(auth_client, "is_configured", return_value=True), \
             patch.object(
                 auth_client, "verify_token",
                 return_value=VerifyResult(
                     valid=True, user_id="pp-user-1", email="u@x.io", plan="pro",
                 ),
             ):
            async with factory() as db:
                from sqlalchemy import select as sa_select
                attached = (await db.execute(
                    sa_select(Client).where(Client.id == client.id)
                )).scalar_one()
                response = await cloud_link(
                    CloudLinkRequest(access_token="tok-new"),
                    client=attached,
                    db=db,
                )
                await db.commit()

        assert response.plan == "pro"
        async with factory() as db:
            from sqlalchemy import select as sa_select
            fresh = (await db.execute(
                sa_select(Client).where(Client.id == client.id)
            )).scalar_one()
            assert fresh.pagepocket_plan == "pro"

    @pytest.mark.asyncio
    async def test_bind_unconfigured_returns_503(self, sqlite_db):
        from app.api.routes.cloud import CloudLinkRequest, cloud_link
        from app.services import auth_client

        _engine, factory = sqlite_db
        client = _make_client()
        await _seed_db(factory, client)

        with patch.object(auth_client, "is_configured", return_value=False):
            async with factory() as db:
                with pytest.raises(HTTPException) as exc:
                    await cloud_link(
                        CloudLinkRequest(access_token="tok"),
                        client=client,
                        db=db,
                    )
        assert exc.value.status_code == 503

    @pytest.mark.asyncio
    async def test_bind_requires_valid_api_key(self, sqlite_db):
        """Unknown X-API-Key → 401 and no binding created (spec scenario)."""
        from app.api.dependencies import get_current_client

        _engine, factory = sqlite_db
        await _seed_db(factory, _make_client())

        async with factory() as db:
            with pytest.raises(HTTPException) as exc:
                await get_current_client(x_api_key="unknown-key", db=db)
        assert exc.value.status_code == 401


# ---------------------------------------------------------------------------
# close-cloud-lifecycle-gaps 1.1/1.2 — DELETE /api/v1/cloud/link (unbind)
# ---------------------------------------------------------------------------


class TestCloudUnlink:
    """Unbind flow: clear the binding, keep the client authenticable (D1)."""

    @pytest.mark.asyncio
    async def test_unbind_clears_binding_keeps_client(self, sqlite_db):
        """Exactly the three binding columns are cleared; api_key and hash
        survive, and the client can still authenticate afterwards."""
        from sqlalchemy import select as sa_select

        from app.api.dependencies import authenticate_client
        from app.api.routes.cloud import cloud_unlink

        _engine, factory = sqlite_db
        client = _make_client(
            pagepocket_user_id="pp-user-1", pagepocket_plan="pro",
        )
        client.pagepocket_linked_at = datetime.now(timezone.utc)
        await _seed_db(factory, client)

        async with factory() as db:
            attached = (await db.execute(
                sa_select(Client).where(Client.id == client.id)
            )).scalar_one()
            response = await cloud_unlink(client=attached, db=db)
            await db.commit()

        assert response.bound is False
        assert response.api_version == "v1"

        async with factory() as db:
            fresh = (await db.execute(
                sa_select(Client).where(Client.id == client.id)
            )).scalar_one()
            assert fresh.pagepocket_user_id is None
            assert fresh.pagepocket_plan is None
            assert fresh.pagepocket_linked_at is None
            # The client identity itself is untouched
            assert fresh.api_key == client.api_key
            assert fresh.api_key_hash == client.api_key_hash

        # Still able to authenticate subsequent requests
        async with factory() as db:
            authed = await authenticate_client(db, client.api_key)
            assert authed is not None
            assert authed.id == client.id

    @pytest.mark.asyncio
    async def test_unbind_idempotent_on_unbound_client(self, sqlite_db):
        """Already-unbound client → still {bound: false} (never 404/409)."""
        from app.api.routes.cloud import cloud_unlink

        _engine, factory = sqlite_db
        client = _make_client()  # never bound
        await _seed_db(factory, client)

        async with factory() as db:
            response = await cloud_unlink(client=client, db=db)
            await db.commit()

        assert response.bound is False
        assert response.api_version == "v1"

    @pytest.mark.asyncio
    async def test_unbind_unknown_api_key_rejected_401_no_modification(self, sqlite_db):
        """Unknown X-API-Key → 401 and the binding stays untouched (spec)."""
        from sqlalchemy import select as sa_select

        from app.api.dependencies import get_current_client

        _engine, factory = sqlite_db
        client = _make_client(
            pagepocket_user_id="pp-user-1", pagepocket_plan="pro",
        )
        client.pagepocket_linked_at = datetime.now(timezone.utc)
        await _seed_db(factory, client)

        async with factory() as db:
            with pytest.raises(HTTPException) as exc:
                await get_current_client(x_api_key="unknown-key", db=db)
        assert exc.value.status_code == 401

        # No client row modification
        async with factory() as db:
            fresh = (await db.execute(
                sa_select(Client).where(Client.id == client.id)
            )).scalar_one()
            assert fresh.pagepocket_user_id == "pp-user-1"
            assert fresh.pagepocket_plan == "pro"
            assert fresh.pagepocket_linked_at is not None


# ---------------------------------------------------------------------------
# 3.1 — Session creation uses only the bound identity
# ---------------------------------------------------------------------------


def _session_body(pagepocket_user_id=None):
    from app.api.routes.sessions import CreateSessionRequest, SessionOptions

    options = SessionOptions(retentionDays=3)
    if pagepocket_user_id is not None:
        options.pagepocketUserId = pagepocket_user_id
    return CreateSessionRequest(url="https://example.com", options=options)


class TestSessionCreationBinding:
    """options.pagepocketUserId accepted only when it matches the binding."""

    @pytest.fixture(autouse=True)
    def _tmp_storage(self, tmp_path, monkeypatch):
        from app.config import settings
        monkeypatch.setattr(settings, "storage_root", str(tmp_path))

    @pytest.mark.asyncio
    async def test_matching_binding_accepted(self, sqlite_db):
        from app.api.routes.sessions import create_session

        _engine, factory = sqlite_db
        client = _make_client(
            pagepocket_user_id="pp-user-1", pagepocket_plan="pro",
        )
        await _seed_db(factory, client)

        async with factory() as db:
            response = await create_session(
                _session_body("pp-user-1"), client=client, db=db,
            )
            await db.commit()

        async with factory() as db:
            from sqlalchemy import select as sa_select
            row = (await db.execute(
                sa_select(Session).where(Session.client_id == client.id)
            )).scalar_one()
            assert row.pagepocket_user_id == "pp-user-1"
            assert row.pagepocket_plan == "pro"
            # The binding is NOT stored on the session as client-supplied data
            assert "pagepocketUserId" not in (row.options or {})

    @pytest.mark.asyncio
    async def test_forged_binding_rejected_403_no_session(self, sqlite_db):
        from app.api.routes.sessions import create_session

        _engine, factory = sqlite_db
        client = _make_client(pagepocket_user_id="pp-user-1")
        await _seed_db(factory, client)

        async with factory() as db:
            with pytest.raises(HTTPException) as exc:
                await create_session(
                    _session_body("pp-user-OTHER"), client=client, db=db,
                )

        assert exc.value.status_code == 403
        assert exc.value.detail["error"] == "cloud_identity_mismatch"

        from sqlalchemy import func as sa_func, select as sa_select
        async with factory() as db:
            count = (await db.execute(
                sa_select(sa_func.count()).select_from(Session)
            )).scalar()
        assert count == 0, "no session may be created on a forged identity"

    @pytest.mark.asyncio
    async def test_unbound_client_with_id_rejected_403(self, sqlite_db):
        from app.api.routes.sessions import create_session

        _engine, factory = sqlite_db
        client = _make_client()  # no binding
        await _seed_db(factory, client)

        async with factory() as db:
            with pytest.raises(HTTPException) as exc:
                await create_session(
                    _session_body("pp-anyone"), client=client, db=db,
                )

        assert exc.value.status_code == 403
        assert exc.value.detail["error"] == "cloud_not_linked"

    @pytest.mark.asyncio
    async def test_unbound_client_without_id_is_local_only(self, sqlite_db):
        from app.api.routes.sessions import create_session

        _engine, factory = sqlite_db
        client = _make_client()
        await _seed_db(factory, client)

        async with factory() as db:
            await create_session(_session_body(None), client=client, db=db)
            await db.commit()

        async with factory() as db:
            from sqlalchemy import select as sa_select
            row = (await db.execute(
                sa_select(Session).where(Session.client_id == client.id)
            )).scalar_one()
            assert row.pagepocket_user_id is None

    @pytest.mark.asyncio
    async def test_bound_client_without_id_uses_binding(self, sqlite_db):
        from app.api.routes.sessions import create_session

        _engine, factory = sqlite_db
        client = _make_client(
            pagepocket_user_id="pp-user-9", pagepocket_plan="free",
        )
        await _seed_db(factory, client)

        async with factory() as db:
            await create_session(_session_body(None), client=client, db=db)
            await db.commit()

        async with factory() as db:
            from sqlalchemy import select as sa_select
            row = (await db.execute(
                sa_select(Session).where(Session.client_id == client.id)
            )).scalar_one()
            assert row.pagepocket_user_id == "pp-user-9"
            assert row.pagepocket_plan == "free"


# ---------------------------------------------------------------------------
# 3.2 — IngestPageRequest always carries identity + plan
# ---------------------------------------------------------------------------


class TestPushCarriesIdentityAndPlan:
    """The built IngestPageRequest never omits user_id or plan."""

    def _stub_and_request(self, monkeypatch):
        """Patch the gRPC stub; return (stub_mock, captured-request getter)."""
        pytest.importorskip("archive_pb2", reason="proto stubs not available")
        from app.services import archive_client

        captured = {}
        stub = MagicMock()

        def _capture(request, timeout=None):
            captured["request"] = request
            return SimpleNamespace(success=True, page_id="page-1")

        stub.IngestPage.side_effect = _capture
        monkeypatch.setattr(archive_client, "_get_stub", lambda: stub)
        return captured

    def test_request_carries_bound_user_and_plan(self, monkeypatch):
        from app.services.archive_client import push_to_archive

        captured = self._stub_and_request(monkeypatch)

        result = push_to_archive(
            user_id="pp-user-1",
            session_id="sess-1",
            url="https://example.com",
            title="T",
            html_content=b"<html></html>",
            assets=[],
            plan="pro",
        )

        assert result.page_id == "page-1"
        request = captured["request"]
        assert request.user_id == "pp-user-1"
        # The assertion that matters: plan is NEVER omitted
        assert request.plan == "pro"
        assert request.extension_job_id == "sess-1"

    def test_request_defaults_to_free_plan_when_binding_plan_missing(self, monkeypatch):
        from app.services.archive_client import push_to_archive

        captured = self._stub_and_request(monkeypatch)

        push_to_archive(
            user_id="pp-user-2",
            session_id="sess-2",
            url="https://example.com",
            title="T",
            html_content=b"<html></html>",
            assets=[],
        )

        assert captured["request"].plan == "free"
        assert captured["request"].user_id == "pp-user-2"

    def test_request_never_omits_plan_on_empty_plan(self, monkeypatch):
        from app.services.archive_client import push_to_archive

        captured = self._stub_and_request(monkeypatch)

        push_to_archive(
            user_id="u",
            session_id="s",
            url="https://example.com",
            title="T",
            html_content=b"<html></html>",
            assets=[],
            plan="",
        )

        assert captured["request"].plan == "free"

    @pytest.mark.asyncio
    async def test_assembler_passes_binding_plan(self, tmp_path):
        """_assemble_cloud_push forwards the session's binding plan."""
        from app.services.zip_assembler import ZipAssemblerService

        assembler = ZipAssemblerService(storage_root=str(tmp_path))
        session = SimpleNamespace(
            id="sess-plan",
            url="https://example.com",
            status="assembling",
            assembly_phase=None,
            assembly_progress_pct=None,
            options={"singleFile": False},
            pagepocket_user_id="pp-user-1",
            pagepocket_plan="pro",
            cloud_status=None,
            cloud_page_id=None,
            cloud_error=None,
            zip_path=None,
            error_message=None,
        )

        class _DB:
            async def flush(self):
                pass

        async def _no_assets(sid, db, archive_paths=None):
            return []

        assembler._build_cloud_assets = _no_assets

        with patch(
            "app.services.archive_client.push_to_archive",
            return_value=SimpleNamespace(page_id="p", error=None),
        ) as mock_push:
            await assembler._assemble_cloud_push(
                "sess-plan", _DB(), session, "<html></html>", {}, {},
            )

        assert mock_push.call_args.kwargs["plan"] == "pro"
        assert mock_push.call_args.kwargs["user_id"] == "pp-user-1"

    @pytest.mark.asyncio
    async def test_assembler_falls_back_to_free_plan(self, tmp_path):
        """Legacy sessions without a stamped plan push with plan="free"."""
        from app.services.zip_assembler import ZipAssemblerService

        assembler = ZipAssemblerService(storage_root=str(tmp_path))
        session = SimpleNamespace(
            id="sess-noplan",
            url="https://example.com",
            status="assembling",
            assembly_phase=None,
            assembly_progress_pct=None,
            options={"singleFile": False},
            pagepocket_user_id="pp-user-2",
            # no pagepocket_plan attribute — pre-migration session row
            cloud_status=None,
            cloud_page_id=None,
            cloud_error=None,
            zip_path=None,
            error_message=None,
        )

        class _DB:
            async def flush(self):
                pass

        async def _no_assets(sid, db, archive_paths=None):
            return []

        assembler._build_cloud_assets = _no_assets

        with patch(
            "app.services.archive_client.push_to_archive",
            return_value=SimpleNamespace(page_id="p", error=None),
        ) as mock_push:
            await assembler._assemble_cloud_push(
                "sess-noplan", _DB(), session, "<html></html>", {}, {},
            )

        assert mock_push.call_args.kwargs["plan"] == "free"
