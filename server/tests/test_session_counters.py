"""Round 9: session counter fixes (total_size + html_chunks).

Prod evidence (session e083f542): a LOCAL session with 35.4 MB of image
resources reported ``total_size=0``, and a session with an uploaded
1,000,602 B main skeleton chunk reported ``html_chunks=0``.

Root cause: the deadlock fix removed ALL per-upload session-row counter
writes, but only ``resources_received`` got a reconcile point (finalize).
``sessions.total_size`` and ``sessions.html_chunks`` were never written
again anywhere, so every surface reading the stored columns (create/list
responses, DB inspection) reported 0 forever.

Fixes under test:
  - POST /sessions/:id/resources accumulates the RAW logical upload size
    (decompressed size for X-Content-Gzipped payloads, received size
    otherwise) into ``sessions.total_size`` via one atomic Core UPDATE.
  - POST /sessions/:id/html increments ``sessions.html_chunks`` per
    non-duplicate chunk — including the very first "main" skeleton chunk
    (pageType "main" / page_url_hash "main", scrollIndex 0).

The /status endpoint keeps computing both counters from live aggregates;
those tests live in test_finalize_resource_integrity.py.
"""

import gzip as gzip_mod
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models import Base
from app.models.client import Client
from app.models.session import Session, SessionStatus


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def db_env(tmp_path):
    """Engine + factory with a seeded client and scraping session."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/counters.db")
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


class _AsyncUploadFile:
    """Minimal async-compatible upload file stub."""

    def __init__(self, content: bytes):
        self._buf = content
        self._pos = 0

    async def read(self, size: int = -1) -> bytes:
        if size == -1:
            chunk, self._pos = self._buf[self._pos:], len(self._buf)
            return chunk
        chunk = self._buf[self._pos:self._pos + size]
        self._pos += len(chunk)
        return chunk


def _owner() -> Client:
    return Client(id="client-1", api_key="key-1")


def _upload_request() -> MagicMock:
    request = MagicMock()
    request.headers.get.return_value = None  # no Content-Length pre-check
    return request


async def _get_session_row(factory):
    async with factory() as db:
        return (await db.execute(
            select(Session).where(Session.id == "sess-1")
        )).scalar_one()


# ---------------------------------------------------------------------------
# total_size accumulation (resource upload endpoint)
# ---------------------------------------------------------------------------


class TestTotalSizeAccumulation:
    """POST /sessions/:id/resources feeds sessions.total_size."""

    @pytest.mark.asyncio
    async def test_upload_n_resources_sums_raw_sizes(self, db_env, tmp_path):
        """Three uploads → column equals the sum of the raw sizes."""
        from app.api.routes.resources import upload_resource

        factory = db_env
        request = _upload_request()

        async with factory() as db:
            with patch("app.api.routes.resources.settings") as cfg, \
                 patch("app.api.routes.resources.resource_upload_limiter") as limiter:
                cfg.max_session_size_mb = 100
                cfg.max_resource_inflate_mb = 50
                cfg.storage_root = str(tmp_path)
                limiter.is_allowed.return_value = (True, 0)

                for i, size in enumerate((64, 128, 4096)):
                    resp = await upload_resource(
                        session_id="sess-1",
                        request=request,
                        file=_AsyncUploadFile(b"x" * size),
                        path=f"images/img-{i}.png",
                        originalUrl=f"https://example.com/img-{i}.png",
                        contentType="image/png",
                        x_content_gzipped=False,
                        client=_owner(),
                        db=db,
                    )
                    assert resp.deduplicated is False
                    assert resp.size == size
            await db.commit()

        row = await _get_session_row(factory)
        assert row.total_size == 64 + 128 + 4096

    @pytest.mark.asyncio
    async def test_gzipped_upload_counts_raw_decompressed_size(
        self, db_env, tmp_path,
    ):
        """X-Content-Gzipped payloads count the RAW (decompressed) logical
        size — the size of the stored file — not the compressed wire size."""
        from app.api.routes.resources import upload_resource

        factory = db_env
        original = b"hello text resource " * 50  # 1000 bytes raw
        compressed = gzip_mod.compress(original)
        assert len(compressed) < len(original)  # wire size is smaller

        async with factory() as db:
            with patch("app.api.routes.resources.settings") as cfg, \
                 patch("app.api.routes.resources.resource_upload_limiter") as limiter:
                cfg.max_session_size_mb = 100
                cfg.max_resource_inflate_mb = 50
                cfg.storage_root = str(tmp_path)
                limiter.is_allowed.return_value = (True, 0)

                resp = await upload_resource(
                    session_id="sess-1",
                    request=_upload_request(),
                    file=_AsyncUploadFile(compressed),
                    path="content/page.html",
                    originalUrl="https://example.com/page.html",
                    contentType="text/html",
                    x_content_gzipped=True,
                    client=_owner(),
                    db=db,
                )
                assert resp.deduplicated is False
                assert resp.size == len(original)
            await db.commit()

        row = await _get_session_row(factory)
        assert row.total_size == len(original)

    @pytest.mark.asyncio
    async def test_deduplicated_upload_not_counted_twice(self, db_env, tmp_path):
        """A dedup hit stores no new bytes → total_size counts it once."""
        from app.api.routes.resources import upload_resource

        factory = db_env
        request = _upload_request()

        async with factory() as db:
            with patch("app.api.routes.resources.settings") as cfg, \
                 patch("app.api.routes.resources.resource_upload_limiter") as limiter:
                cfg.max_session_size_mb = 100
                cfg.max_resource_inflate_mb = 50
                cfg.storage_root = str(tmp_path)
                limiter.is_allowed.return_value = (True, 0)

                first = await upload_resource(
                    session_id="sess-1",
                    request=request,
                    file=_AsyncUploadFile(b"y" * 512),
                    path="images/dup.png",
                    originalUrl="https://example.com/dup.png",
                    contentType="image/png",
                    x_content_gzipped=False,
                    client=_owner(),
                    db=db,
                )
                assert first.deduplicated is False

                second = await upload_resource(
                    session_id="sess-1",
                    request=request,
                    file=_AsyncUploadFile(b"y" * 512),
                    path="images/dup.png",
                    originalUrl="https://example.com/dup.png",
                    contentType="image/png",
                    x_content_gzipped=False,
                    client=_owner(),
                    db=db,
                )
                assert second.deduplicated is True
            await db.commit()

        row = await _get_session_row(factory)
        assert row.total_size == 512

    @pytest.mark.asyncio
    async def test_column_agrees_with_resource_rows(self, db_env, tmp_path):
        """The stored column matches SUM(Resource.size) — the /status live
        aggregate — so both truth sources agree (documented choice)."""
        from app.api.routes.resources import upload_resource
        from app.models.resource import Resource
        from sqlalchemy import func

        factory = db_env
        request = _upload_request()

        async with factory() as db:
            with patch("app.api.routes.resources.settings") as cfg, \
                 patch("app.api.routes.resources.resource_upload_limiter") as limiter:
                cfg.max_session_size_mb = 100
                cfg.max_resource_inflate_mb = 50
                cfg.storage_root = str(tmp_path)
                limiter.is_allowed.return_value = (True, 0)

                await upload_resource(
                    session_id="sess-1",
                    request=request,
                    file=_AsyncUploadFile(b"z" * 777),
                    path="images/only.png",
                    originalUrl="https://example.com/only.png",
                    contentType="image/png",
                    x_content_gzipped=False,
                    client=_owner(),
                    db=db,
                )
            await db.commit()

        async with factory() as db:
            resource_sum = (await db.execute(
                select(func.coalesce(func.sum(Resource.size), 0)).where(
                    Resource.session_id == "sess-1"
                )
            )).scalar()
        row = await _get_session_row(factory)
        assert row.total_size == resource_sum == 777


# ---------------------------------------------------------------------------
# html_chunks counter (chunk upload endpoint)
# ---------------------------------------------------------------------------


class TestHtmlChunksCounter:
    """POST /sessions/:id/html feeds sessions.html_chunks."""

    async def _upload_chunk(self, factory, tmp_path, *, html, scroll_index,
                            page_type="main", page_url=None):
        from app.api.routes.html import HtmlChunkRequest, upload_html_chunk

        async with factory() as db:
            with patch("app.api.routes.html.settings") as cfg:
                cfg.max_session_size_mb = 100
                cfg.max_html_chunk_size_mb = 5
                cfg.storage_root = str(tmp_path)
                resp = await upload_html_chunk(
                    session_id="sess-1",
                    body=HtmlChunkRequest(
                        html=html,
                        scrollIndex=scroll_index,
                        pageType=page_type,
                        pageUrl=page_url,
                    ),
                    client=_owner(),
                    db=db,
                )
            # get_db() commits after the response in production; direct
            # route invocation must commit explicitly.
            await db.commit()
            return resp

    @pytest.mark.asyncio
    async def test_main_skeleton_chunk_counts(self, db_env, tmp_path):
        """The very first main chunk (pageType "main", scrollIndex 0) — the
        one prod reported as html_chunks=0 despite 1,000,602 B uploaded —
        must count."""
        factory = db_env

        resp = await self._upload_chunk(
            factory, tmp_path, html="<html><body>Main</body></html>",
            scroll_index=0,
        )
        assert resp.deduplicated is False
        assert resp.chunk_count == 1

        row = await _get_session_row(factory)
        assert row.html_chunks == 1

    @pytest.mark.asyncio
    async def test_main_linked_and_append_chunks_all_count(self, db_env, tmp_path):
        factory = db_env

        await self._upload_chunk(
            factory, tmp_path, html="<html><body>main-0</body></html>",
            scroll_index=0,
        )
        await self._upload_chunk(
            factory, tmp_path, html="<html><body>main-1</body></html>",
            scroll_index=1,
        )
        await self._upload_chunk(
            factory, tmp_path, html="<html><body>about</body></html>",
            scroll_index=0, page_type="linked",
            page_url="https://example.com/about",
        )

        row = await _get_session_row(factory)
        assert row.html_chunks == 3

    @pytest.mark.asyncio
    async def test_duplicate_chunk_not_counted_twice(self, db_env, tmp_path):
        """Exact retransmission (same content hash + scroll index) dedups
            before insert → no double increment."""
        factory = db_env
        html = "<html><body>same</body></html>"

        first = await self._upload_chunk(
            factory, tmp_path, html=html, scroll_index=0,
        )
        second = await self._upload_chunk(
            factory, tmp_path, html=html, scroll_index=0,
        )

        assert first.deduplicated is False
        assert second.deduplicated is True

        row = await _get_session_row(factory)
        assert row.html_chunks == 1
