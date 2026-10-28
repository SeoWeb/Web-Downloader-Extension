"""Tests for the finalize race guard and assembly status envelope (3.4, 6.1).

Covers harden-backend-security-and-ops:

  3.4 — double-finalize cannot start two assemblies: the uploading →
        assembling transition is a single guarded UPDATE
        (``WHERE status = 'uploading'`` + rowcount check), so concurrent
        finalize calls yield exactly one 202 and one 409.

  6.1 — the status response surfaces the assembly envelope additively:
        finalized_at, updated_at, assembly_elapsed_seconds alongside the
        existing assembly_phase / assembly_progress_pct.

Runs against a real SQLite database (see conftest) so the guarded UPDATE's
rowcount semantics are exercised through the ORM.
"""

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest
import pytest_asyncio
from fastapi import HTTPException
from sqlalchemy import func, select
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
    """Engine + session factory with a seeded client and uploading session."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/race.db")
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
        db.add(HtmlChunk(
            session_id="sess-1", scroll_index=0,
            content_hash="a" * 64, storage_path="/tmp/chunk0.html", size=10,
        ))
        db.add(Resource(
            session_id="sess-1", original_url="https://example.com/a.png",
            url_hash="b" * 64, local_path="images/a.png",
            storage_path="/tmp/a.png", size=5,
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


# ---------------------------------------------------------------------------
# 3.4 — concurrent finalize
# ---------------------------------------------------------------------------


class TestFinalizeRace:
    """Two concurrent finalize coroutines → exactly one assembly task."""

    @pytest.mark.asyncio
    async def test_double_finalize_single_assembly(self, db_env):
        from app.api.routes.sessions import finalize_session

        factory = db_env
        registered = []
        orig_register = assembly_task_manager.register

        def _spy_register(session_id, task):
            registered.append(session_id)
            orig_register(session_id, task)

        monkey_spy = patch.object(
            assembly_task_manager, "register", side_effect=_spy_register,
        )
        with monkey_spy:
            async with factory() as db1, factory() as db2:
                results = await asyncio.gather(
                    finalize_session("sess-1", client=_owner(), db=db1),
                    finalize_session("sess-1", client=_owner(), db=db2),
                    return_exceptions=True,
                )

        outcomes = []
        for r in results:
            if isinstance(r, HTTPException):
                outcomes.append(("409", r.status_code))
            elif isinstance(r, Exception):
                pytest.fail(f"finalize failed unexpectedly: {r!r}")
            else:
                outcomes.append(("202", r.status))

        codes = sorted(o[0] for o in outcomes)
        assert codes == ["202", "409"], f"expected one 202 and one 409, got {outcomes}"
        winner = next(o for o in outcomes if o[0] == "202")
        assert winner[1] == "assembling"

        # Exactly one assembly task was registered for the session
        assert registered.count("sess-1") == 1

        # The session row ends in exactly one assembling transition
        async with factory() as db:
            count = (await db.execute(
                select(func.count()).select_from(Session).where(
                    Session.id == "sess-1",
                    Session.status == SessionStatus.ASSEMBLING,
                )
            )).scalar()
            assert count == 1
            row = (await db.execute(
                select(Session).where(Session.id == "sess-1")
            )).scalar_one()
            assert row.finalized_at is not None
            assert row.assembly_phase == "merging_html"

        assembly_task_manager.unregister("sess-1")

    @pytest.mark.asyncio
    async def test_finalize_from_uploading_succeeds(self, db_env):
        from app.api.routes.sessions import finalize_session

        factory = db_env
        async with factory() as db:
            response = await finalize_session("sess-1", client=_owner(), db=db)
        assert response.status == "assembling"
        assembly_task_manager.unregister("sess-1")

    @pytest.mark.asyncio
    async def test_finalize_twice_sequentially_conflicts(self, db_env):
        """Sequential double-finalize: second call sees assembling → 409."""
        from app.api.routes.sessions import finalize_session

        factory = db_env
        async with factory() as db:
            await finalize_session("sess-1", client=_owner(), db=db)
        assembly_task_manager.unregister("sess-1")

        async with factory() as db:
            with pytest.raises(HTTPException) as exc:
                await finalize_session("sess-1", client=_owner(), db=db)
        assert exc.value.status_code == 409

    @pytest.mark.asyncio
    async def test_finalize_scraping_rejected(self, tmp_path):
        engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/s.db")
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        async with factory() as db:
            db.add(Client(id="c", api_key="k", api_key_hash=Client.hash_key("k")))
            db.add(Session(
                id="s", client_id="c", url="https://example.com",
                status=SessionStatus.SCRAPING,
                expires_at=datetime.now(timezone.utc) + timedelta(days=1),
            ))
            await db.commit()
        try:
            from app.api.routes.sessions import finalize_session

            async with factory() as db:
                with pytest.raises(HTTPException) as exc:
                    await finalize_session("s", client=Client(id="c"), db=db)
            assert exc.value.status_code == 409
            assert exc.value.detail["error"] == "scraping_not_complete"
        finally:
            await engine.dispose()


# ---------------------------------------------------------------------------
# 6.1 — status envelope fields
# ---------------------------------------------------------------------------


class TestStatusEnvelope:
    """Status response exposes elapsed/phase timestamps additively."""

    def test_response_model_has_envelope_fields(self):
        from app.api.routes.sessions import SessionStatusResponse

        resp = SessionStatusResponse(
            id="s", status="assembling", url="https://example.com",
            assembly_phase="converting_urls", assembly_progress_pct=40,
            finalized_at=datetime(2026, 10, 15, 12, 0, 0, tzinfo=timezone.utc),
            updated_at=datetime(2026, 10, 15, 12, 1, 0, tzinfo=timezone.utc),
            assembly_elapsed_seconds=60,
        )
        assert resp.assembly_phase == "converting_urls"
        assert resp.assembly_progress_pct == 40
        assert resp.assembly_elapsed_seconds == 60
        assert resp.finalized_at is not None

    def test_response_model_backward_compatible(self):
        """Old callers' fields alone still construct a valid response."""
        from app.api.routes.sessions import SessionStatusResponse

        resp = SessionStatusResponse(
            id="s", status="ready", url="https://example.com",
        )
        assert resp.finalized_at is None
        assert resp.updated_at is None
        assert resp.assembly_elapsed_seconds is None

    @pytest.mark.asyncio
    async def test_status_handler_reports_elapsed_while_assembling(self, db_env):
        from app.api.routes.sessions import get_session_status

        factory = db_env
        # Force the session into assembling with a finalized_at in the past
        async with factory() as db:
            row = (await db.execute(
                select(Session).where(Session.id == "sess-1")
            )).scalar_one()
            row.status = SessionStatus.ASSEMBLING
            row.assembly_phase = "converting_css"
            row.assembly_progress_pct = 25
            row.finalized_at = datetime.now(timezone.utc) - timedelta(minutes=2)
            row.updated_at = datetime.now(timezone.utc) - timedelta(seconds=30)
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

        assert resp.status == "assembling"
        assert resp.assembly_phase == "converting_css"
        assert resp.assembly_progress_pct == 25
        assert resp.finalized_at is not None
        assert resp.updated_at is not None
        # Elapsed since last progress touch ≈ 30s (30–120s window)
        assert 25 <= resp.assembly_elapsed_seconds <= 125

    @pytest.mark.asyncio
    async def test_status_ready_has_no_elapsed(self, db_env):
        from app.api.routes.sessions import get_session_status

        factory = db_env
        async with factory() as db:
            row = (await db.execute(
                select(Session).where(Session.id == "sess-1")
            )).scalar_one()
            row.status = SessionStatus.READY
            row.finalized_at = datetime.now(timezone.utc) - timedelta(hours=1)
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

        assert resp.status == "ready"
        assert resp.assembly_elapsed_seconds is None


# ---------------------------------------------------------------------------
# server-assembly-honesty 11.3 — D3 upload-vs-finalize race closure
# ---------------------------------------------------------------------------


class TestUploadVsFinalizeRaceClosure:
    """D3: an upload that passed the request-time pre-check is never 409'd.

    Two halves, both against the real SQLite database:

    1. A gated ``upload_resource`` call is paused AFTER its status pre-check
       observed ``uploading`` (the gate sits in the upload stream read).
       ``finalize_session``'s guarded transition then commits; the upload
       resumes, inserts and commits → success (never 409), row + file
       stored — the accept-and-account contract.
    2. A resource committing after the assembler's start-of-pipeline
       snapshot is a late arrival: the REAL pipeline's
       ``_account_and_persist_integrity`` recounts the live rows after the
       artifact build and lands the delta in ``integrity.assembly_missing``
       and ``archive_warning`` while the row + file remain stored.
    """

    @pytest.mark.asyncio
    async def test_upload_passing_precheck_commits_after_finalize_transition(
        self, db_env, tmp_path, monkeypatch,
    ):
        """Pre-check passed + finalize committed + upload commits → 200, row+file."""
        import io
        import os
        from types import SimpleNamespace as _NS

        from fastapi import UploadFile
        from fastapi import HTTPException

        from app.api.routes.resources import upload_resource
        from app.api.routes.sessions import finalize_session
        from app.config import settings

        monkeypatch.setattr(settings, "storage_root", str(tmp_path))

        payload = b"PNGDATA" * 16
        reached_read = asyncio.Event()
        release = asyncio.Event()

        class _GatedUploadFile(UploadFile):
            """UploadFile that blocks in read() after the pre-check passed."""

            async def read(self, size: int = -1) -> bytes:
                reached_read.set()
                await release.wait()
                return await super().read(size)

        upload_file = _GatedUploadFile(
            file=io.BytesIO(payload), filename="late.png",
        )
        # headers mapping so the (pre-9.4) Content-Length pre-check, if
        # present, reads an absent header instead of crashing the harness.
        request = _NS(headers={})

        async def _run_upload():
            async with factory() as db:
                client = (await db.execute(
                    select(Client).where(Client.id == "client-1")
                )).scalar_one()
                return await upload_resource(
                    "sess-1",
                    request=request,
                    file=upload_file,
                    path="images/late.png",
                    originalUrl="https://example.com/late.png",
                    contentType="image/png",
                    x_content_gzipped=False,
                    client=client,
                    db=db,
                )

        factory = db_env
        upload_task = asyncio.create_task(_run_upload())
        # The upload is now past the status pre-check (session was
        # `uploading`) and parked inside the gated read.
        await asyncio.wait_for(reached_read.wait(), timeout=5)

        # Finalize's guarded transition commits while the upload is in flight.
        async with factory() as db:
            client = (await db.execute(
                select(Client).where(Client.id == "client-1")
            )).scalar_one()
            await finalize_session("sess-1", client=client, db=db)
        assembly_task_manager.unregister("sess-1")

        release.set()
        response = await asyncio.wait_for(upload_task, timeout=5)
        # NOT a 409: an upload that passed the pre-check is never rejected
        # mid-flight, even though the session transitioned underneath it.
        assert not isinstance(response, HTTPException)
        assert response.deduplicated is False
        assert response.local_path == "images/late.png"
        assert response.size == len(payload)

        # Row + file are durably stored (D2: 200 ⇒ committed row + file).
        async with factory() as db:
            stored = (await db.execute(
                select(Resource).where(
                    Resource.session_id == "sess-1",
                    Resource.local_path == "images/late.png",
                )
            )).scalar_one()
            assert stored is not None
            assert stored.size == len(payload)
            storage_path = stored.storage_path
            session_row = (await db.execute(
                select(Session).where(Session.id == "sess-1")
            )).scalar_one()
        assert session_row.status == SessionStatus.ASSEMBLING
        assert os.path.isfile(storage_path)

    @pytest.mark.asyncio
    async def test_post_snapshot_late_arrival_lands_in_integrity_counts(
        self, db_env, tmp_path, monkeypatch,
    ):
        """Resource committing after the snapshot → accounted, not silent."""
        import os

        from app.services import zip_assembler as za_module
        from app.services.html_converter import html_converter_service
        from app.services.html_merger import MergeResult

        sid = "sess-late"
        factory = db_env
        snapshot_file = tmp_path / "snapshot.png"
        snapshot_file.write_bytes(b"SNAPSHOTPNG")
        late_file = tmp_path / "late.png"
        late_file.write_bytes(b"LATEPNG")
        # The assembler writes the ZIP into the session directory (uploads
        # create it in production).
        (tmp_path / sid).mkdir(parents=True, exist_ok=True)

        async with factory() as db:
            db.add(Session(
                id=sid, client_id="client-1", url="https://example.com",
                status=SessionStatus.ASSEMBLING,
                expires_at=datetime.now(timezone.utc) + timedelta(days=1),
            ))
            db.add(Resource(
                session_id=sid,
                original_url="https://example.com/snapshot.png",
                url_hash="c" * 64,
                local_path="images/snapshot.png",
                storage_path=str(snapshot_file),
                size=snapshot_file.stat().st_size,
            ))
            await db.commit()

        assembler = za_module.ZipAssemblerService(storage_root=str(tmp_path))

        # Plant a resource DURING the pipeline: the snapshot
        # (`_get_all_resources` at Phase-2 start) has already run when the
        # CSS phase progress fires, so the planted row commits after the
        # snapshot — exactly the D3 late-arrival window.
        planted = {"done": False}

        async def _planting_progress(db, session, phase, pct, **kwargs):
            if not planted["done"] and phase == "converting_css":
                planted["done"] = True
                async with factory() as pdb:
                    pdb.add(Resource(
                        session_id=sid,
                        original_url="https://example.com/late.png",
                        url_hash="d" * 64,
                        local_path="images/late.png",
                        storage_path=str(late_file),
                        size=late_file.stat().st_size,
                    ))
                    await pdb.commit()

        def _identity(html, *args, **kwargs):
            return html

        monkeypatch.setattr(
            za_module.html_merger_service, "merge_session",
            lambda sid_: {"main": MergeResult(success=True, html="<html><body>x</body></html>")},
        )
        monkeypatch.setattr(html_converter_service, "convert_html", _identity)
        monkeypatch.setattr(
            html_converter_service, "inline_css_into_html", _identity,
        )
        monkeypatch.setattr(assembler, "_update_progress", _planting_progress)

        from contextlib import asynccontextmanager

        @asynccontextmanager
        async def committing_factory():
            async with factory() as session:
                try:
                    yield session
                    await session.commit()
                except Exception:
                    await session.rollback()
                    raise

        await assembler.assemble_session(sid, committing_factory)

        # Archive membership defined by the snapshot: only the snapshot
        # resource is in the artifact.
        async with factory() as db:
            session_row = (await db.execute(
                select(Session).where(Session.id == sid)
            )).scalar_one()
            late_row = (await db.execute(
                select(Resource).where(
                    Resource.session_id == sid,
                    Resource.local_path == "images/late.png",
                )
            )).scalar_one()

        assert session_row.status == SessionStatus.READY
        assert session_row.zip_path and os.path.isfile(session_row.zip_path)
        import zipfile as _zipfile

        with _zipfile.ZipFile(session_row.zip_path) as zf:
            names = zf.namelist()
        assert "images/snapshot.png" in names
        assert "images/late.png" not in names

        # The late arrival is accounted, not silent — and never orphaned.
        integrity = session_row.options["integrity"]
        assert integrity["assembly_missing"] == 1
        assert "arrived after assembly started" in integrity["archive_warning"]
        assert late_row is not None
        assert os.path.isfile(late_row.storage_path)
