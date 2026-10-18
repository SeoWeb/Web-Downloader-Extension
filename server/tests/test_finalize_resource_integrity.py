"""Finalize-time resources_received reconciliation tests (fix-archived-page-pipeline, C).

Covers tasks 3.1–3.4 of the change:

  3.4a — resource uploads leave ``sessions.resources_received`` untouched
         mid-flight (deadlock fix: no per-upload session-row writes), and
         finalize sets it to the exact resources row count.
  3.4b — deduplicated re-uploads do not inflate the reconciled count.
  3.4c — ``resources_discovered > resources_received`` at finalize emits the
         loud structured deficit warning AND finalize still returns
         202/assembling — the warning is visibility, never a refusal.
  3.4d — ``discovered <= received`` (and ``discovered=None``) logs no
         warning; the 409 conflict path stays silent too.
  Status endpoint — keeps computing ``resources_received`` from the live
         aggregate and never reads the stored column.

Mirrors test_finalize_race.py: real SQLite database (see conftest), route
handlers called directly, real assembly pipeline replaced by a no-op.
"""

import logging
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
import pytest_asyncio
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models import Base
from app.models.client import Client
from app.models.html_chunk import HtmlChunk
from app.models.resource import Resource
from app.models.session import Session, SessionStatus
from app.services.assembly_manager import assembly_task_manager


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def db_env(tmp_path):
    """Engine + session factory with a seeded client and uploading session.

    The session row starts with the production mid-flight shape:
    ``resources_received`` defaults to 0 and stays 0 while uploads happen.
    """
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/integrity.db")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async with factory() as db:
        db.add(Client(
            id="client-1", api_key="key-1",
            api_key_hash=Client.hash_key("key-1"),
        ))
        db.add(Session(
            id="sess-1", client_id="client-1", url="https://example.com",
            status=SessionStatus.UPLOADING,
            expires_at=datetime.now(timezone.utc) + timedelta(days=1),
        ))
        await db.commit()

    try:
        yield factory
    finally:
        await engine.dispose()


@pytest.fixture(autouse=True)
def _noop_assembly(monkeypatch):
    """Replace the real assembly pipeline with a no-op."""
    from app.services.zip_assembler import zip_assembler_service

    async def _noop(session_id, db_session_factory):
        pass

    monkeypatch.setattr(zip_assembler_service, "assemble_session", _noop)


def _owner() -> Client:
    return Client(id="client-1", api_key="key-1")


async def _add_resources(factory, count, prefix="r"):
    """Insert ``count`` distinct resource rows for sess-1 (as uploads do)."""
    async with factory() as db:
        for i in range(count):
            url = f"https://example.com/{prefix}-{i}.png"
            db.add(Resource(
                session_id="sess-1", original_url=url,
                url_hash=f"{i:064x}", local_path=f"assets/{prefix}-{i}.png",
                storage_path=f"/tmp/{prefix}-{i}.png", size=10 + i,
            ))
        await db.commit()


async def _get_session_row(factory):
    async with factory() as db:
        return (await db.execute(
            select(Session).where(Session.id == "sess-1")
        )).scalar_one()


# ---------------------------------------------------------------------------
# 3.4a — mid-flight column untouched; finalize reconciles to exact count
# ---------------------------------------------------------------------------


class TestFinalizeReconciliation:

    @pytest.mark.asyncio
    async def test_finalize_sets_column_to_exact_row_count(self, db_env):
        """Finalize writes resources_received = exact resources row count."""
        from app.api.routes.sessions import finalize_session

        factory = db_env
        await _add_resources(factory, 3)

        # Pre-finalize: column still at its mid-flight default (0) even
        # though 3 resource rows exist — the documented deadlock fix.
        row = await _get_session_row(factory)
        assert row.resources_received == 0

        async with factory() as db:
            resp = await finalize_session("sess-1", client=_owner(), db=db)
        assert resp.status == "assembling"
        assembly_task_manager.unregister("sess-1")

        row = await _get_session_row(factory)
        assert row.resources_received == 3

    @pytest.mark.asyncio
    async def test_real_uploads_leave_column_untouched_midflight(self, db_env, tmp_path):
        """Real upload_resource calls insert rows but never touch the column.

        Guards against a regression to per-upload session-row counter
        updates (the removed deadlock-prone behaviour).
        """
        from app.api.routes.resources import upload_resource
        from app.api.routes.sessions import finalize_session

        factory = db_env
        storage_root = str(tmp_path)

        request = MagicMock()
        request.headers.get.return_value = None  # no Content-Length → skip pre-check

        async with factory() as db:
            with patch("app.api.routes.resources.settings") as cfg, \
                 patch("app.api.routes.resources.resource_upload_limiter") as limiter:
                cfg.max_session_size_mb = 100
                cfg.storage_root = storage_root
                limiter.is_allowed.return_value = (True, 0)

                for i in range(2):
                    resp = await upload_resource(
                        session_id="sess-1",
                        request=request,
                        file=_AsyncUploadFile(b"x" * 64),
                        path=f"assets/img-{i}.png",
                        originalUrl=f"https://example.com/img-{i}.png",
                        contentType="image/png",
                        x_content_gzipped=False,
                        client=_owner(),
                        db=db,
                    )
                    assert resp.deduplicated is False
            await db.commit()

        # Two resource rows exist; the session-row column is untouched.
        async with factory() as db:
            resource_rows = (await db.execute(
                select(Resource).where(Resource.session_id == "sess-1")
            )).scalars().all()
        assert len(resource_rows) == 2
        row = await _get_session_row(factory)
        assert row.resources_received == 0, (
            "uploads must NOT update sessions.resources_received mid-flight "
            "(per-upload updates were removed by the deadlock fix)"
        )

        # Finalize reconciles the column to the exact row count.
        async with factory() as db:
            resp = await finalize_session("sess-1", client=_owner(), db=db)
        assert resp.status == "assembling"
        assembly_task_manager.unregister("sess-1")

        row = await _get_session_row(factory)
        assert row.resources_received == 2

    @pytest.mark.asyncio
    async def test_deduplicated_reuploads_do_not_inflate_count(self, db_env, tmp_path):
        """Dedup hits insert no rows, so the reconciled count stays exact."""
        from app.api.routes.resources import upload_resource
        from app.api.routes.sessions import finalize_session

        factory = db_env
        storage_root = str(tmp_path)

        request = MagicMock()
        request.headers.get.return_value = None

        async with factory() as db:
            with patch("app.api.routes.resources.settings") as cfg, \
                 patch("app.api.routes.resources.resource_upload_limiter") as limiter:
                cfg.max_session_size_mb = 100
                cfg.storage_root = storage_root
                limiter.is_allowed.return_value = (True, 0)

                first = await upload_resource(
                    session_id="sess-1",
                    request=request,
                    file=_AsyncUploadFile(b"x" * 64),
                    path="assets/dup.png",
                    originalUrl="https://example.com/dup.png",
                    contentType="image/png",
                    x_content_gzipped=False,
                    client=_owner(),
                    db=db,
                )
                assert first.deduplicated is False

                # Same originalUrl → URL-hash dedup hit, no new row.
                second = await upload_resource(
                    session_id="sess-1",
                    request=request,
                    file=_AsyncUploadFile(b"x" * 64),
                    path="assets/dup.png",
                    originalUrl="https://example.com/dup.png",
                    contentType="image/png",
                    x_content_gzipped=False,
                    client=_owner(),
                    db=db,
                )
                assert second.deduplicated is True
                assert second.resource_id == first.resource_id
            await db.commit()

        async with factory() as db:
            resource_rows = (await db.execute(
                select(Resource).where(Resource.session_id == "sess-1")
            )).scalars().all()
        assert len(resource_rows) == 1

        async with factory() as db:
            await finalize_session("sess-1", client=_owner(), db=db)
        assembly_task_manager.unregister("sess-1")

        row = await _get_session_row(factory)
        assert row.resources_received == 1, (
            "deduplicated re-uploads must not inflate the reconciled count"
        )


# ---------------------------------------------------------------------------
# 3.4c / 3.4d — the deficit warning: loud, but never blocking
# ---------------------------------------------------------------------------


class TestDeficitWarning:

    @pytest.mark.asyncio
    async def test_deficit_logs_warning_and_finalize_still_succeeds(self, db_env, caplog):
        """discovered=5 > received=2 → structured warning AND 202 outcome."""
        from app.api.routes.sessions import finalize_session

        factory = db_env
        async with factory() as db:
            row = (await db.execute(
                select(Session).where(Session.id == "sess-1")
            )).scalar_one()
            row.resources_discovered = 5
            await db.commit()
        await _add_resources(factory, 2)

        with caplog.at_level(logging.WARNING, logger="app.api.routes.sessions"):
            async with factory() as db:
                resp = await finalize_session("sess-1", client=_owner(), db=db)
        assembly_task_manager.unregister("sess-1")

        # Finalize semantics unchanged: success, no refusal.
        assert resp.status == "assembling"

        deficit_records = [
            r for r in caplog.records
            if "resources_received deficit at finalize" in r.getMessage()
        ]
        assert len(deficit_records) == 1
        message = deficit_records[0].getMessage()
        assert "session_id=sess-1" in message
        assert "resources_discovered=5" in message
        assert "resources_received=2" in message

    @pytest.mark.asyncio
    async def test_no_warning_when_counts_equal(self, db_env, caplog):
        """discovered == received → no deficit warning."""
        from app.api.routes.sessions import finalize_session

        factory = db_env
        async with factory() as db:
            row = (await db.execute(
                select(Session).where(Session.id == "sess-1")
            )).scalar_one()
            row.resources_discovered = 2
            await db.commit()
        await _add_resources(factory, 2)

        with caplog.at_level(logging.WARNING, logger="app.api.routes.sessions"):
            async with factory() as db:
                await finalize_session("sess-1", client=_owner(), db=db)
        assembly_task_manager.unregister("sess-1")

        assert not [
            r for r in caplog.records
            if "resources_received deficit at finalize" in r.getMessage()
        ]

    @pytest.mark.asyncio
    async def test_no_warning_when_discovered_is_none(self, db_env, caplog):
        """discovered=None (client never reported) → no deficit warning."""
        from app.api.routes.sessions import finalize_session

        factory = db_env
        await _add_resources(factory, 1)
        # resources_discovered stays None.

        with caplog.at_level(logging.WARNING, logger="app.api.routes.sessions"):
            async with factory() as db:
                await finalize_session("sess-1", client=_owner(), db=db)
        assembly_task_manager.unregister("sess-1")

        assert not [
            r for r in caplog.records
            if "resources_received deficit at finalize" in r.getMessage()
        ]

    @pytest.mark.asyncio
    async def test_no_warning_on_conflict_path(self, db_env, caplog):
        """The 409 already-finalizing path adds no deficit warning. Counts
        are equal so the winning finalize is also silent — any deficit
        record at all would mean the conflict path itself warned."""
        from app.api.routes.sessions import finalize_session

        factory = db_env
        async with factory() as db:
            row = (await db.execute(
                select(Session).where(Session.id == "sess-1")
            )).scalar_one()
            row.resources_discovered = 2
            await db.commit()
        await _add_resources(factory, 2)

        with caplog.at_level(logging.WARNING, logger="app.api.routes.sessions"):
            async with factory() as db:
                await finalize_session("sess-1", client=_owner(), db=db)  # wins
            assembly_task_manager.unregister("sess-1")
            with pytest.raises(HTTPException) as exc:
                async with factory() as db:
                    await finalize_session("sess-1", client=_owner(), db=db)
            assert exc.value.status_code == 409

        assert not [
            r for r in caplog.records
            if "resources_received deficit at finalize" in r.getMessage()
        ]


# ---------------------------------------------------------------------------
# Status endpoint keeps live-counting (never reads the stored column)
# ---------------------------------------------------------------------------


class TestStatusEndpointLiveCounts:

    @pytest.mark.asyncio
    async def test_status_reports_live_count_not_column(self, db_env):
        """The /status handler computes resources_received from the live
        aggregate — before finalize (column 0) and after (column stale on
        purpose if rows change post-finalize)."""
        from app.api.routes.sessions import finalize_session, get_session_status

        factory = db_env
        await _add_resources(factory, 2)

        async with factory() as db:
            client = (await db.execute(
                select(Client).where(Client.id == "client-1")
            )).scalar_one()
            resp = await get_session_status(
                "sess-1",
                request=SimpleNamespace(base_url="http://test/"),
                client=client,
                db=db,
            )
        # Mid-flight: column is 0, live aggregate is authoritative.
        assert resp.resources_received == 2

        async with factory() as db:
            await finalize_session("sess-1", client=_owner(), db=db)
        assembly_task_manager.unregister("sess-1")

        # Post-finalize the column is reconciled to 2; deleting a row must
        # still be reflected live by the endpoint (proving it never reads
        # the stored column).
        row = await _get_session_row(factory)
        assert row.resources_received == 2

        async with factory() as db:
            victim = (await db.execute(
                select(Resource).where(Resource.session_id == "sess-1")
            )).scalars().first()
            await db.delete(victim)
            await db.commit()

        async with factory() as db:
            client = (await db.execute(
                select(Client).where(Client.id == "client-1")
            )).scalar_one()
            resp = await get_session_status(
                "sess-1",
                request=SimpleNamespace(base_url="http://test/"),
                client=client,
                db=db,
            )
        assert resp.resources_received == 1

    @pytest.mark.asyncio
    async def test_response_model_unchanged_shape(self, db_env):
        """create/list response still exposes the stored (now reconciled at
        finalize) column — no wire contract change."""
        from app.api.routes.sessions import finalize_session, _session_to_response

        factory = db_env
        await _add_resources(factory, 2)

        # Before finalize: stored column is the documented-stale 0.
        row = await _get_session_row(factory)
        assert _session_to_response(row).resources_received == 0

        async with factory() as db:
            await finalize_session("sess-1", client=_owner(), db=db)
        assembly_task_manager.unregister("sess-1")

        row = await _get_session_row(factory)
        assert _session_to_response(row).resources_received == 2


# ---------------------------------------------------------------------------
# Minimal upload-file stub (mirrors test_resource_upload.py)
# ---------------------------------------------------------------------------


class _AsyncUploadFile:
    """Minimal async-compatible upload file stub for testing."""

    def __init__(self, content: bytes, filename: str = "test.bin"):
        self._buf = content
        self._pos = 0
        self.filename = filename

    async def read(self, size: int = -1) -> bytes:
        if size == -1:
            chunk = self._buf[self._pos:]
            self._pos = len(self._buf)
        else:
            chunk = self._buf[self._pos:self._pos + size]
            self._pos += len(chunk)
        return chunk
