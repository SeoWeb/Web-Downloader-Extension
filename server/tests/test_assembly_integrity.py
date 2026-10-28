"""Honest partial-assembly reporting tests (server-assembly-honesty 11.1, D1).

Covers the honesty chain end to end against a real SQLite database (same
pattern as test_finalize_race.py / test_finalize_resource_integrity.py):

  - A session whose resource file is missing from disk (and one whose
    ``zf.write`` fails) still assembles to ``ready`` — partial archives stay
    valid artifacts — and the session's persisted ``integrity`` object
    records ``assembly_missing`` / ``assembly_failed`` with an
    ``archive_warning`` summary.
  - ``/status`` (``get_session_status``) reports ``resources_missing`` /
    ``resources_failed`` > 0 with ``archive_warning`` set once accounting
    exists, and reports ``null``/``null``/``null`` before finalize.
  - The finalize payload (``FinalizeResponse``) carries the finalize-known
    counts: ``resources_discovered`` / ``resources_received`` /
    ``resources_missing`` (the clamped discovery deficit) and
    ``resources_failed`` — the 202 outcome is unchanged.
  - A complete session reports ``0``/``0`` with ``archive_warning = null``.
  - The assembler MERGES its totals into the options JSON ``integrity``
    object without clobbering the finalize-owned fields
    (``discovered_deficit`` / ``capture_failed``), and marking ``ready``
    does not clear them — ``/status`` reports the combined totals.

The real ``assemble_session`` pipeline runs (only the merger and the HTML
converters are stubbed, mirroring test_images_only_local.py), so the
resource snapshot, the ZIP skip accounting, the late-arrival recount, and
the options-JSON merge all execute for real.
"""

import hashlib
import os
import zipfile
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models import Base
from app.models.client import Client
from app.models.resource import Resource
from app.models.session import Session, SessionStatus
from app.services.assembly_manager import assembly_task_manager
from app.services.html_converter import html_converter_service
from app.services.html_merger import MergeResult


MAIN_HTML = (
    "<!DOCTYPE html><html><head><title>Integrity</title></head>"
    "<body><p>Main content</p></body></html>"
)

JPEG_BYTES = b"\xff\xd8\xff\xe0" + b"\x00" * 32
PDF_BYTES = b"%PDF-1.4" + b"\x00" * 32


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def db_env(tmp_path):
    """SQLite engine + factories with a seeded client (mirror test_finalize_race).

    ``committing_factory`` mirrors production's
    ``app.db.database.async_session_factory`` (commit on clean exit, rollback
    on exception) so the background assembly pipeline's flushes actually
    persist, exactly as they do in production.
    """
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/integrity.db")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    @asynccontextmanager
    async def committing_factory():
        async with factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    async with factory() as db:
        db.add(Client(
            id="client-1", api_key="key-1",
            api_key_hash=Client.hash_key("key-1"),
        ))
        await db.commit()

    env = SimpleNamespace(
        engine=engine,
        factory=factory,
        committing_factory=committing_factory,
        storage_root=str(tmp_path),
    )
    try:
        yield env
    finally:
        await engine.dispose()


@pytest.fixture(autouse=True)
def _noop_singleton_assembly(monkeypatch):
    """Replace the singleton assembly pipeline with a no-op.

    finalize_session triggers ``zip_assembler_service.assemble_session`` as a
    background task wired to the production MySQL factory — it must not run
    here. The real-pipeline tests below construct their OWN
    ``ZipAssemblerService`` instance and are unaffected by this patch.
    """
    from app.services.zip_assembler import zip_assembler_service

    async def _noop(session_id, db_session_factory):
        pass

    monkeypatch.setattr(zip_assembler_service, "assemble_session", _noop)


# ---------------------------------------------------------------------------
# Seed / drive helpers
# ---------------------------------------------------------------------------


def _url_hash(url: str) -> str:
    return hashlib.sha256(url.encode("utf-8")).hexdigest()


def _make_session_dir(storage_root: str, session_id: str) -> str:
    session_dir = os.path.join(storage_root, session_id)
    os.makedirs(os.path.join(session_dir, "resources"), exist_ok=True)
    return session_dir


def _stored_resource(
    storage_root: str, session_id: str, url: str, local_path: str,
    data: bytes = JPEG_BYTES,
) -> Resource:
    """Resource row whose bytes actually exist on disk (uploads wrote them)."""
    storage_path = os.path.join(
        storage_root, session_id, "resources",
        _url_hash(url)[:16] + "_" + os.path.basename(local_path),
    )
    os.makedirs(os.path.dirname(storage_path), exist_ok=True)
    with open(storage_path, "wb") as f:
        f.write(data)
    return Resource(
        session_id=session_id, original_url=url, url_hash=_url_hash(url),
        local_path=local_path, storage_path=storage_path,
        content_type="image/jpeg", size=len(data),
    )


def _phantom_resource(session_id: str, url: str, local_path: str) -> Resource:
    """Resource row whose file is missing from disk (e.g. lost after upload)."""
    return Resource(
        session_id=session_id, original_url=url, url_hash=_url_hash(url),
        local_path=local_path,
        storage_path=os.path.join(
            "storage-root-that-no-longer-has-it", session_id,
            _url_hash(url)[:16] + ".bin",
        ),
        content_type="image/jpeg", size=64,
    )


async def _seed_session(
    env, session_id: str, *, discovered=None, options=None,
    status=SessionStatus.ASSEMBLING, resources=(),
) -> None:
    async with env.factory() as db:
        db.add(Session(
            id=session_id, client_id="client-1", url="https://example.com/page",
            status=status, resources_discovered=discovered,
            options=options or {},
            expires_at=datetime.now(timezone.utc) + timedelta(days=1),
        ))
        for row in resources:
            db.add(row)
        await db.commit()


async def _reload_session(env, session_id: str) -> Session:
    async with env.factory() as db:
        row = (await db.execute(
            select(Session).where(Session.id == session_id)
        )).scalar_one()
        db.expunge(row)
        return row


async def _get_status(env, session_id: str):
    """Call the /status handler directly (mirror test_finalize_race)."""
    from app.api.routes.sessions import get_session_status

    async with env.factory() as db:
        client = (await db.execute(
            select(Client).where(Client.id == "client-1")
        )).scalar_one()
        return await get_session_status(
            session_id,
            request=SimpleNamespace(base_url="http://test/"),
            client=client,
            db=db,
        )


async def _finalize(env, session_id: str):
    from app.api.routes.sessions import finalize_session

    async with env.factory() as db:
        client = (await db.execute(
            select(Client).where(Client.id == "client-1")
        )).scalar_one()
        response = await finalize_session(session_id, client=client, db=db)
    assembly_task_manager.unregister(session_id)
    return response


async def _run_real_assembly(env, session_id: str, monkeypatch) -> None:
    """Run the REAL assemble_session against the SQLite database.

    Only the heavy external collaborators are stubbed out (in-memory merger,
    HTML converters, progress flushing) — the resource snapshot, the 3.7
    collision resolution, the ZIP skip accounting, the post-snapshot
    late-arrival recount, and the options-JSON integrity merge all execute
    for real (same stubbing strategy as test_images_only_local.py).
    """
    from app.services import zip_assembler as za_module

    assembler = za_module.ZipAssemblerService(storage_root=env.storage_root)
    merge_results = {"main": MergeResult(success=True, html=MAIN_HTML)}

    def _identity(html, *args, **kwargs):
        return html

    async def _no_progress(db, sess, phase, pct, **kwargs):
        pass

    monkeypatch.setattr(
        za_module.html_merger_service, "merge_session",
        lambda sid: dict(merge_results),
    )
    monkeypatch.setattr(html_converter_service, "convert_html", _identity)
    monkeypatch.setattr(
        html_converter_service, "inline_css_into_html", _identity,
    )
    monkeypatch.setattr(assembler, "_update_progress", _no_progress)

    await assembler.assemble_session(session_id, env.committing_factory)


# ---------------------------------------------------------------------------
# Partial assembly stays ready and records the skips (spec scenarios 1–2)
# ---------------------------------------------------------------------------


class TestPartialAssemblyHonesty:

    @pytest.mark.asyncio
    async def test_missing_file_and_write_failure_still_ready_with_counts(
        self, db_env, monkeypatch, caplog,
    ):
        """Missing-on-disk + zf.write-failure resources: ready, counted, warned."""
        import logging

        sid = "sess-partial"
        root = db_env.storage_root
        _make_session_dir(root, sid)
        ok_row = _stored_resource(root, sid, "https://example.com/ok.jpg", "images/ok.jpg")
        missing_row = _phantom_resource(sid, "https://example.com/gone.jpg", "images/gone.jpg")
        bad_row = _stored_resource(
            root, sid, "https://example.com/bad.pdf", "documents/bad.pdf",
            data=PDF_BYTES,
        )
        await _seed_session(
            db_env, sid, discovered=3, resources=[ok_row, missing_row, bad_row],
        )

        # Make zf.write fail ONLY for the bad resource's archive path —
        # simulating an unwritable target without touching other writes.
        original_write = zipfile.ZipFile.write

        def _selective_write(self, filename, arcname=None, *args, **kwargs):
            if arcname == "documents/bad.pdf":
                raise OSError("simulated unwritable target")
            return original_write(self, filename, arcname, *args, **kwargs)

        monkeypatch.setattr(zipfile.ZipFile, "write", _selective_write)

        with caplog.at_level(logging.WARNING):
            await _run_real_assembly(db_env, sid, monkeypatch)

        # The archive is still produced and the session becomes ready.
        row = await _reload_session(db_env, sid)
        assert row.status == SessionStatus.READY
        assert row.zip_path and os.path.isfile(row.zip_path)
        assert zipfile.is_zipfile(row.zip_path)
        with zipfile.ZipFile(row.zip_path) as zf:
            names = zf.namelist()
        assert "images/ok.jpg" in names            # healthy resource present
        assert "images/gone.jpg" not in names      # missing file skipped
        assert "documents/bad.pdf" not in names    # write failure skipped

        # Persisted integrity: one missing, one failed, warning summarizing both.
        integrity = row.options["integrity"]
        assert integrity["assembly_missing"] == 1
        assert integrity["assembly_failed"] == 1
        warning = integrity["archive_warning"]
        assert warning
        assert "1 resource(s) missing from archive" in warning
        assert "1 resource(s) failed to write" in warning

        # The skip sites still log resource identity.
        assert any(
            "documents/bad.pdf" in record.getMessage()
            and "Failed to add resource to ZIP" in record.getMessage()
            for record in caplog.records
        )
        assert any(
            "images/gone.jpg" in record.getMessage()
            and "Missing resource file skipped" in record.getMessage()
            for record in caplog.records
        )

        # /status reports the honesty fields.
        status = await _get_status(db_env, sid)
        assert status.status == "ready"
        assert status.resources_missing == 1
        assert status.resources_failed == 1
        assert status.archive_warning

    @pytest.mark.asyncio
    async def test_ready_does_not_clear_counts_on_reassembly(
        self, db_env, monkeypatch,
    ):
        """Re-assembling (marking ready again) keeps the recorded counts."""
        sid = "sess-partial-again"
        root = db_env.storage_root
        _make_session_dir(root, sid)
        ok_row = _stored_resource(root, sid, "https://example.com/ok.jpg", "images/ok.jpg")
        missing_row = _phantom_resource(sid, "https://example.com/gone.jpg", "images/gone.jpg")
        await _seed_session(
            db_env, sid, discovered=2, resources=[ok_row, missing_row],
        )

        await _run_real_assembly(db_env, sid, monkeypatch)
        first = (await _reload_session(db_env, sid)).options["integrity"]
        assert first["assembly_missing"] == 1

        # Session is now ready; a re-run must merge, not reset.
        await _run_real_assembly(db_env, sid, monkeypatch)
        second = (await _reload_session(db_env, sid)).options["integrity"]
        assert second["assembly_missing"] == 1
        assert second["archive_warning"]


# ---------------------------------------------------------------------------
# Finalize payload surfaces the discovery deficit (spec scenario 3)
# ---------------------------------------------------------------------------


class TestFinalizeIntegrityPayload:

    @pytest.mark.asyncio
    async def test_finalize_response_carries_deficit_and_persists_counts(
        self, db_env,
    ):
        """202 payload includes discovered/received/missing/failed counts."""
        sid = "sess-deficit"
        root = db_env.storage_root
        _make_session_dir(root, sid)
        rows = [
            _stored_resource(root, sid, "https://example.com/1.jpg", "images/1.jpg"),
            _stored_resource(root, sid, "https://example.com/2.jpg", "images/2.jpg"),
        ]
        # scrape-complete stashed capture failures the same way in production
        await _seed_session(
            db_env, sid, discovered=5, options={"resourcesFailed": 2},
            status=SessionStatus.UPLOADING, resources=rows,
        )

        # /status BEFORE finalize: accounting not yet done → nulls.
        pre = await _get_status(db_env, sid)
        assert pre.resources_missing is None
        assert pre.resources_failed is None
        assert pre.archive_warning is None

        response = await _finalize(db_env, sid)
        # The deficit never blocks finalize: 202, assembling.
        assert response.status == "assembling"
        assert response.resources_discovered == 5
        assert response.resources_received == 2
        assert response.resources_missing == 3
        assert response.resources_failed == 2

        # Persisted finalize-owned counts in the options JSON integrity object.
        row = await _reload_session(db_env, sid)
        integrity = row.options["integrity"]
        assert integrity["discovered_deficit"] == 3
        assert integrity["capture_failed"] == 2

        # /status AFTER finalize (before assembly): finalize-known totals only.
        post = await _get_status(db_env, sid)
        assert post.resources_missing == 3
        assert post.resources_failed == 2
        assert post.archive_warning
        assert "3 resource(s) missing from archive" in post.archive_warning

    @pytest.mark.asyncio
    async def test_finalize_without_deficit_reports_zeros(self, db_env):
        """discovered == received and no capture failures → zero counts."""
        sid = "sess-even"
        root = db_env.storage_root
        _make_session_dir(root, sid)
        rows = [
            _stored_resource(root, sid, "https://example.com/a.png", "images/a.png"),
            _stored_resource(root, sid, "https://example.com/b.png", "images/b.png"),
        ]
        await _seed_session(
            db_env, sid, discovered=2, status=SessionStatus.UPLOADING,
            resources=rows,
        )

        response = await _finalize(db_env, sid)
        assert response.status == "assembling"
        assert response.resources_discovered == 2
        assert response.resources_received == 2
        assert response.resources_missing == 0
        assert response.resources_failed == 0

        status = await _get_status(db_env, sid)
        assert status.resources_missing == 0
        assert status.resources_failed == 0
        assert status.archive_warning is None


# ---------------------------------------------------------------------------
# Complete session reports zero with no warning (spec scenario 4)
# ---------------------------------------------------------------------------


class TestCompleteSessionZero:

    @pytest.mark.asyncio
    async def test_complete_session_reports_zero_and_no_warning(
        self, db_env, monkeypatch,
    ):
        sid = "sess-complete"
        root = db_env.storage_root
        _make_session_dir(root, sid)
        rows = [
            _stored_resource(root, sid, "https://example.com/a.jpg", "images/a.jpg"),
            _stored_resource(root, sid, "https://example.com/b.jpg", "images/b.jpg"),
        ]
        await _seed_session(
            db_env, sid, discovered=2, status=SessionStatus.UPLOADING,
            resources=rows,
        )

        response = await _finalize(db_env, sid)
        assert response.resources_missing == 0
        assert response.resources_failed == 0

        await _run_real_assembly(db_env, sid, monkeypatch)

        row = await _reload_session(db_env, sid)
        assert row.status == SessionStatus.READY
        assert row.zip_path and os.path.isfile(row.zip_path)
        integrity = row.options["integrity"]
        assert integrity["assembly_missing"] == 0
        assert integrity["assembly_failed"] == 0
        assert integrity["archive_warning"] is None
        assert integrity["discovered_deficit"] == 0
        assert integrity["capture_failed"] == 0

        status = await _get_status(db_env, sid)
        assert status.resources_missing == 0
        assert status.resources_failed == 0
        assert status.archive_warning is None


# ---------------------------------------------------------------------------
# Merge semantics: assembly must not clobber finalize-owned counts (1.2)
# ---------------------------------------------------------------------------


class TestIntegrityMergePreservesFinalizeFields:

    @pytest.mark.asyncio
    async def test_assembly_merges_and_status_sums_both_sources(
        self, db_env, monkeypatch,
    ):
        """/status totals = finalize-owned + assembly-owned; merge, not overwrite."""
        sid = "sess-merge"
        root = db_env.storage_root
        _make_session_dir(root, sid)
        ok_row = _stored_resource(root, sid, "https://example.com/ok.jpg", "images/ok.jpg")
        missing_row = _phantom_resource(sid, "https://example.com/gone.jpg", "images/gone.jpg")
        await _seed_session(
            db_env, sid, discovered=5, options={"resourcesFailed": 2},
            status=SessionStatus.UPLOADING, resources=[ok_row, missing_row],
        )

        response = await _finalize(db_env, sid)
        assert response.resources_missing == 3      # 5 discovered - 2 received

        await _run_real_assembly(db_env, sid, monkeypatch)

        row = await _reload_session(db_env, sid)
        assert row.status == SessionStatus.READY
        integrity = row.options["integrity"]
        # Finalize-owned fields survived the assembler's merge…
        assert integrity["discovered_deficit"] == 3
        assert integrity["capture_failed"] == 2
        # …and the assembly-owned fields were added.
        assert integrity["assembly_missing"] == 1
        assert integrity["assembly_failed"] == 0

        status = await _get_status(db_env, sid)
        # resources_missing = deficit (3) + assembly skip (1)
        assert status.resources_missing == 4
        # resources_failed = capture failures (2) + assembly write failures (0)
        assert status.resources_failed == 2
        assert status.archive_warning
