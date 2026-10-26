"""resourcesFailed observability on scrape-complete (capture-failure visibility).

The extension reports an optional ``resourcesFailed`` count on
POST /api/v1/sessions/{id}/scrape-complete. When > 0 the route logs a
WARNING and stashes the count in the session's ``options`` JSON (no
dedicated column — no migration for v1); finalize repeats the warning so
the finalize record carries it too. Both warnings are visibility only —
they never change status transitions, the 202 outcome, or the existing
discovery/received deficit logic.

Mirrors test_finalize_resource_integrity.py: real SQLite database (see
conftest), route handlers called directly, assembly pipeline no-op'd.
"""

import logging
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models import Base
from app.models.client import Client
from app.models.html_chunk import HtmlChunk
from app.models.resource import Resource
from app.models.session import Session, SessionStatus
from app.services.assembly_manager import assembly_task_manager

FAILED_MSG = "resource fetch(es) failed during capture"


@pytest_asyncio.fixture
async def db_env(tmp_path):
    """Engine + session factory with a seeded client and scraping session."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/failed.db")
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
            status=SessionStatus.SCRAPING,
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


async def _seed_uploads(factory):
    """One HTML chunk + one resource row so finalize's empty check passes."""
    async with factory() as db:
        db.add(HtmlChunk(
            session_id="sess-1", scroll_index=0,
            content_hash="a" * 64, storage_path="/tmp/chunk0.html", size=10,
        ))
        db.add(Resource(
            session_id="sess-1",
            original_url="https://example.com/a.png",
            url_hash=f"{1:064x}",
            local_path="assets/a.png",
            storage_path="/tmp/a.png",
            size=10,
        ))
        await db.commit()


async def _get_session_row(factory):
    async with factory() as db:
        return (await db.execute(
            select(Session).where(Session.id == "sess-1")
        )).scalar_one()


class TestScrapeCompleteResourcesFailed:

    @pytest.mark.asyncio
    async def test_resources_failed_logs_warning_and_is_stashed(self, db_env, caplog):
        """resourcesFailed=3 → WARNING at scrape-complete + options stash."""
        from app.api.routes.sessions import ScrapeCompleteRequest, scrape_complete

        factory = db_env
        with caplog.at_level(logging.WARNING, logger="app.api.routes.sessions"):
            async with factory() as db:
                resp = await scrape_complete(
                    "sess-1",
                    body=ScrapeCompleteRequest(resourceCount=10, resourcesFailed=3),
                    client=_owner(),
                    db=db,
                )

        assert resp["status"] == "uploading"

        records = [r for r in caplog.records if FAILED_MSG in r.getMessage()]
        assert len(records) == 1, (
            f"expected exactly one failure warning, got: "
            f"{[r.getMessage() for r in caplog.records]}"
        )
        message = records[0].getMessage()
        assert "3 resource fetch(es) failed during capture" in message
        assert "sess-1" in message

        # Stashed in the options JSON (no migration), merged with existing keys.
        row = await _get_session_row(factory)
        assert row.options.get("resourcesFailed") == 3
        assert row.resources_discovered == 10

    @pytest.mark.asyncio
    async def test_absent_resources_failed_defaults_to_zero_and_no_warning(
        self, db_env, caplog
    ):
        """No resourcesFailed field → accepted, no warning, nothing stashed."""
        from app.api.routes.sessions import ScrapeCompleteRequest, scrape_complete

        factory = db_env
        with caplog.at_level(logging.WARNING, logger="app.api.routes.sessions"):
            async with factory() as db:
                resp = await scrape_complete(
                    "sess-1",
                    body=ScrapeCompleteRequest(resourceCount=10),
                    client=_owner(),
                    db=db,
                )

        assert resp["status"] == "uploading"
        assert not [r for r in caplog.records if FAILED_MSG in r.getMessage()]

        row = await _get_session_row(factory)
        assert (row.options or {}).get("resourcesFailed") is None

    @pytest.mark.asyncio
    async def test_finalize_repeats_failed_fetch_warning(self, db_env, caplog):
        """Finalize logs the stashed count again — deficit logic untouched."""
        from app.api.routes.sessions import ScrapeCompleteRequest, finalize_session, scrape_complete

        factory = db_env
        await _seed_uploads(factory)

        async with factory() as db:
            await scrape_complete(
                "sess-1",
                body=ScrapeCompleteRequest(resourceCount=1, resourcesFailed=3),
                client=_owner(),
                db=db,
            )
        caplog.clear()

        # discovered(1) == received(1): no deficit warning — only the
        # capture-failure warning may appear.
        with caplog.at_level(logging.WARNING, logger="app.api.routes.sessions"):
            async with factory() as db:
                resp = await finalize_session("sess-1", client=_owner(), db=db)
        assembly_task_manager.unregister("sess-1")

        assert resp.status == "assembling"

        records = [r for r in caplog.records if FAILED_MSG in r.getMessage()]
        assert len(records) == 1, (
            f"expected exactly one finalize failure warning, got: "
            f"{[r.getMessage() for r in caplog.records]}"
        )
        assert "3 resource fetch(es) failed during capture" in records[0].getMessage()
        assert "sess-1" in records[0].getMessage()

        # The existing deficit-at-finalize logic is untouched: no deficit here.
        assert not [
            r for r in caplog.records
            if "resources_received deficit at finalize" in r.getMessage()
        ]

    @pytest.mark.asyncio
    async def test_finalize_silent_when_no_failures_reported(self, db_env, caplog):
        """No resourcesFailed anywhere → finalize emits no failure warning."""
        from app.api.routes.sessions import ScrapeCompleteRequest, finalize_session, scrape_complete

        factory = db_env
        await _seed_uploads(factory)

        async with factory() as db:
            await scrape_complete(
                "sess-1",
                body=ScrapeCompleteRequest(resourceCount=1),
                client=_owner(),
                db=db,
            )
        caplog.clear()

        with caplog.at_level(logging.WARNING, logger="app.api.routes.sessions"):
            async with factory() as db:
                await finalize_session("sess-1", client=_owner(), db=db)
        assembly_task_manager.unregister("sess-1")

        assert not [r for r in caplog.records if FAILED_MSG in r.getMessage()]
