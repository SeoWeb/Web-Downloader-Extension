"""Tests for resource upload streaming and quota enforcement (resources.py).

Covers the three behaviours introduced by the fix-oom-memory-pressure change:

  1. Content-Length pre-check: when the Content-Length header alone would
     breach the session quota, 413 is returned before any bytes are read from
     the upload body and no file is written to disk.

  2. Post-write aggregate size check: after the 256 KB chunked write completes,
     if existing_total + final_size > limit the newly written file is deleted
     and 413 is returned.

  3. Dedup check after size check: when the size check passes but the URL is a
     duplicate, the newly written file is deleted and 200/deduplicated=True is
     returned.

Implementation note: the module-level `engine = create_async_engine(...)` in
app/db/database.py requires aiomysql, which is not installed in the test
environment.  We stub that module via sys.modules before importing the route so
that no real connection is attempted.  Each test patches `settings` and the
rate-limiter to remain self-contained.
"""

import sys
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

# Stub the database module before any route import triggers engine creation
sys.modules.setdefault("app.db.database", MagicMock())

import io  # noqa: E402  (must come after sys.modules patch)
import os
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from app.api.routes.resources import upload_resource
from app.models.session import SessionStatus


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _AsyncUploadFile:
    """Minimal async-compatible upload file stub for testing."""

    def __init__(self, content: bytes, filename: str = "test.bin"):
        self._buf = content
        self._pos = 0
        self.filename = filename

    async def read(self, size: int = -1) -> bytes:
        if size == -1:
            chunk = self._buf[self._pos :]
            self._pos = len(self._buf)
        else:
            chunk = self._buf[self._pos : self._pos + size]
            self._pos += len(chunk)
        return chunk


def _mock_session(
    session_id: str = "test-session",
    client_id: str = "test-client",
    status: SessionStatus = SessionStatus.SCRAPING,
) -> MagicMock:
    s = MagicMock()
    s.id = session_id
    s.client_id = client_id
    s.status = status
    return s


def _scalar_one(value) -> MagicMock:
    r = MagicMock()
    r.scalar_one_or_none.return_value = value
    return r


def _scalar(value) -> MagicMock:
    r = MagicMock()
    r.scalar.return_value = value
    return r


def _mock_db(*execute_returns) -> AsyncMock:
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=list(execute_returns))
    db.flush = AsyncMock()
    db.rollback = AsyncMock()
    db.add = MagicMock()
    return db


def _mock_request(content_length: int | None = None) -> MagicMock:
    req = MagicMock()
    req.headers.get.return_value = (
        str(content_length) if content_length is not None else None
    )
    return req


# ---------------------------------------------------------------------------
# Tests — Content-Length pre-check
# ---------------------------------------------------------------------------


class TestContentLengthPrecheck:
    """413 returned before any file I/O when Content-Length alone breaches quota."""

    @pytest.mark.asyncio
    async def test_rejects_before_writing(self, tmp_path):
        """existing=90 MB, Content-Length=20 MB, limit=100 MB → 413, no file written."""
        session_id = "sess-cl-precheck"
        client_id = "client-1"
        storage_root = str(tmp_path)

        db = _mock_db(
            _scalar_one(_mock_session(session_id, client_id)),  # session lookup
            _scalar(90 * 1024 * 1024),                          # pre-check size query
        )

        with patch("app.api.routes.resources.settings") as cfg, \
             patch("app.api.routes.resources.resource_upload_limiter") as limiter, \
             patch("app.api.routes.resources.require_session_owner"):
            cfg.max_session_size_mb = 100
            cfg.storage_root = storage_root
            limiter.is_allowed.return_value = (True, 0)

            with pytest.raises(HTTPException) as exc:
                await upload_resource(
                    session_id=session_id,
                    request=_mock_request(content_length=20 * 1024 * 1024),
                    file=_AsyncUploadFile(b"x" * 100),
                    path="images/photo.jpg",
                    originalUrl="https://example.com/photo.jpg",
                    contentType="image/jpeg",
                    x_content_gzipped=False,
                    client=MagicMock(id=client_id),
                    db=db,
                )

        assert exc.value.status_code == 413
        assert exc.value.detail["error"] == "session_size_exceeded"

        # Pre-check fires before os.makedirs / open, so no file should exist
        resources_dir = os.path.join(storage_root, session_id, "resources")
        written = os.listdir(resources_dir) if os.path.exists(resources_dir) else []
        assert written == [], (
            f"No file should be written on pre-check rejection; found: {written}"
        )

    @pytest.mark.asyncio
    async def test_allows_upload_when_within_quota(self, tmp_path):
        """existing=10 MB, Content-Length=5 MB, limit=100 MB → upload proceeds."""
        session_id = "sess-cl-ok"
        client_id = "client-ok"
        storage_root = str(tmp_path)

        existing_resource = MagicMock()
        existing_resource.id = "dup-id"
        existing_resource.local_path = "images/dup.jpg"
        existing_resource.size = 512

        db = _mock_db(
            _scalar_one(_mock_session(session_id, client_id)),  # session
            _scalar(10 * 1024 * 1024),                          # pre-check (passes)
            _scalar(10 * 1024 * 1024),                          # post-write size (passes)
            _scalar_one(existing_resource),                     # dedup → hit (early return)
        )

        with patch("app.api.routes.resources.settings") as cfg, \
             patch("app.api.routes.resources.resource_upload_limiter") as limiter, \
             patch("app.api.routes.resources.require_session_owner"):
            cfg.max_session_size_mb = 100
            cfg.storage_root = storage_root
            limiter.is_allowed.return_value = (True, 0)

            response = await upload_resource(
                session_id=session_id,
                request=_mock_request(content_length=5 * 1024 * 1024),
                file=_AsyncUploadFile(b"x" * 512),
                path="images/photo.jpg",
                originalUrl="https://example.com/photo.jpg",
                contentType="image/jpeg",
                x_content_gzipped=False,
                client=MagicMock(id=client_id),
                db=db,
            )

        assert response.deduplicated is True


# ---------------------------------------------------------------------------
# Tests — post-write aggregate size check
# ---------------------------------------------------------------------------


class TestPostWriteSizeCheck:
    """Newly written file is deleted on 413 when the post-write total exceeds quota."""

    @pytest.mark.asyncio
    async def test_file_deleted_on_413(self, tmp_path):
        """No Content-Length header, existing=95 MB, file=10 MB, limit=100 MB
        → file written then deleted, resources dir empty, 413 returned."""
        session_id = "sess-post-write"
        client_id = "client-2"
        storage_root = str(tmp_path)
        file_content = b"y" * (10 * 1024 * 1024)  # 10 MB

        db = _mock_db(
            _scalar_one(_mock_session(session_id, client_id)),  # session
            _scalar(95 * 1024 * 1024),                          # post-write size (fails)
        )

        with patch("app.api.routes.resources.settings") as cfg, \
             patch("app.api.routes.resources.resource_upload_limiter") as limiter, \
             patch("app.api.routes.resources.require_session_owner"):
            cfg.max_session_size_mb = 100
            cfg.storage_root = storage_root
            limiter.is_allowed.return_value = (True, 0)

            with pytest.raises(HTTPException) as exc:
                await upload_resource(
                    session_id=session_id,
                    request=_mock_request(content_length=None),
                    file=_AsyncUploadFile(file_content, "large.bin"),
                    path="files/large.bin",
                    originalUrl="https://example.com/large.bin",
                    contentType="application/octet-stream",
                    x_content_gzipped=False,
                    client=MagicMock(id=client_id),
                    db=db,
                )

        assert exc.value.status_code == 413
        assert exc.value.detail["error"] == "session_size_exceeded"

        # Streaming write created the file; size check must have deleted it
        resources_dir = os.path.join(storage_root, session_id, "resources")
        remaining = os.listdir(resources_dir) if os.path.exists(resources_dir) else []
        assert remaining == [], (
            f"File should be deleted after post-write 413; found: {remaining}"
        )

    @pytest.mark.asyncio
    async def test_file_preserved_when_within_quota(self, tmp_path):
        """When existing + file_size ≤ limit the file is kept and DB record created."""
        session_id = "sess-post-write-ok"
        client_id = "client-pw-ok"
        storage_root = str(tmp_path)
        file_content = b"z" * 512

        db = _mock_db(
            _scalar_one(_mock_session(session_id, client_id)),  # session
            _scalar(1 * 1024 * 1024),                           # post-write size (passes)
            _scalar_one(None),                                   # dedup → no match
            MagicMock(),                                        # counter UPDATE (Round 9)
        )

        with patch("app.api.routes.resources.settings") as cfg, \
             patch("app.api.routes.resources.resource_upload_limiter") as limiter, \
             patch("app.api.routes.resources.require_session_owner"):
            cfg.max_session_size_mb = 100
            cfg.storage_root = storage_root
            limiter.is_allowed.return_value = (True, 0)

            response = await upload_resource(
                session_id=session_id,
                request=_mock_request(content_length=None),
                file=_AsyncUploadFile(file_content, "small.bin"),
                path="files/small.bin",
                originalUrl="https://example.com/small.bin",
                contentType="application/octet-stream",
                x_content_gzipped=False,
                client=MagicMock(id=client_id),
                db=db,
            )

        assert response.deduplicated is False
        assert response.size == len(file_content)

        # File should still be on disk (not deleted)
        resources_dir = os.path.join(storage_root, session_id, "resources")
        remaining = os.listdir(resources_dir)
        assert len(remaining) == 1, (
            f"File should be kept when size check passes; found: {remaining}"
        )


# ---------------------------------------------------------------------------
# Tests — dedup check after size check
# ---------------------------------------------------------------------------


class TestDedupAfterSizeCheck:
    """Newly written file is deleted when dedup match is found after size check."""

    @pytest.mark.asyncio
    async def test_file_deleted_on_dedup_match(self, tmp_path):
        """Size check passes, URL is a duplicate → file deleted, 200 returned
        with deduplicated=True and existing resource_id."""
        session_id = "sess-dedup"
        client_id = "client-3"
        storage_root = str(tmp_path)
        file_content = b"w" * 512

        existing = MagicMock()
        existing.id = "existing-resource-uuid"
        existing.local_path = "images/existing.png"
        existing.size = 512

        db = _mock_db(
            _scalar_one(_mock_session(session_id, client_id)),  # session
            _scalar(1 * 1024 * 1024),                           # post-write size (passes)
            _scalar_one(existing),                              # dedup → match
        )

        with patch("app.api.routes.resources.settings") as cfg, \
             patch("app.api.routes.resources.resource_upload_limiter") as limiter, \
             patch("app.api.routes.resources.require_session_owner"):
            cfg.max_session_size_mb = 100
            cfg.storage_root = storage_root
            limiter.is_allowed.return_value = (True, 0)

            response = await upload_resource(
                session_id=session_id,
                request=_mock_request(content_length=None),
                file=_AsyncUploadFile(file_content, "image.png"),
                path="images/image.png",
                originalUrl="https://example.com/image.png",
                contentType="image/png",
                x_content_gzipped=False,
                client=MagicMock(id=client_id),
                db=db,
            )

        assert response.deduplicated is True
        assert response.resource_id == "existing-resource-uuid"

        # Newly written file must have been deleted
        resources_dir = os.path.join(storage_root, session_id, "resources")
        remaining = os.listdir(resources_dir) if os.path.exists(resources_dir) else []
        assert remaining == [], (
            f"Newly written file should be deleted on dedup match; found: {remaining}"
        )

    @pytest.mark.asyncio
    async def test_dedup_check_runs_after_size_check(self, tmp_path):
        """Dedup must NOT run when the size check already rejected the request.

        Strategy: provide only 2 db.execute results (session + size); if dedup
        were triggered a third consume would raise StopIteration, not 413.
        """
        session_id = "sess-order"
        client_id = "client-order"
        storage_root = str(tmp_path)
        file_content = b"q" * (10 * 1024 * 1024)  # 10 MB

        db = _mock_db(
            _scalar_one(_mock_session(session_id, client_id)),
            _scalar(95 * 1024 * 1024),  # 95 + 10 > 100 → size check fails
        )

        with patch("app.api.routes.resources.settings") as cfg, \
             patch("app.api.routes.resources.resource_upload_limiter") as limiter, \
             patch("app.api.routes.resources.require_session_owner"):
            cfg.max_session_size_mb = 100
            cfg.storage_root = storage_root
            limiter.is_allowed.return_value = (True, 0)

            with pytest.raises(HTTPException) as exc:
                await upload_resource(
                    session_id=session_id,
                    request=_mock_request(content_length=None),
                    file=_AsyncUploadFile(file_content),
                    path="files/big.bin",
                    originalUrl="https://example.com/big.bin",
                    contentType="application/octet-stream",
                    x_content_gzipped=False,
                    client=MagicMock(id=client_id),
                    db=db,
                )

        # Must raise 413 (not StopIteration), confirming dedup was not called
        assert exc.value.status_code == 413


# ---------------------------------------------------------------------------
# 3.3 — filename map merge persistence (regression)
# ---------------------------------------------------------------------------


class TestFilenameMapMergePersistence:
    """The incremental merge MUST persist: a follow-up read returns the union.

    Regression for the audit finding: `existing_map.update(body.map)` mutated
    the already-persistent JSON object in place and re-assigned the SAME
    object, so SQLAlchemy never marked the attribute dirty — flush() emitted
    no UPDATE and the merge silently never committed.
    """

    @pytest.mark.asyncio
    async def test_second_merge_persists_union(self, sqlite_db, tmp_path):
        from sqlalchemy import select as sa_select

        from app.api.routes.resources import FilenameMapRequest, upload_filename_map
        from app.models.client import Client
        from app.models.session import Session

        _engine, factory = sqlite_db

        # Seed client + session in UPLOADING (accepted for map uploads)
        async with factory() as db:
            db.add(Client(
                id="client-map", api_key="k-map",
                api_key_hash=Client.hash_key("k-map"),
            ))
            db.add(Session(
                id="sess-map", client_id="client-map",
                url="https://example.com",
                status=SessionStatus.UPLOADING,
                expires_at=datetime.now(timezone.utc) + timedelta(days=1),
            ))
            await db.commit()

        # First upload from one db session
        async with factory() as db:
            client = (await db.execute(
                sa_select(Client).where(Client.id == "client-map")
            )).scalar_one()
            resp1 = await upload_filename_map(
                "sess-map",
                body=FilenameMapRequest(map={
                    "https://example.com/a.png": "images/a.png",
                }),
                client=client,
                db=db,
            )
            await db.commit()
        assert resp1.mappings_count == 1

        # Second (incremental) upload from a FRESH db session — this is the
        # merge that used to be silently dropped.
        async with factory() as db:
            client = (await db.execute(
                sa_select(Client).where(Client.id == "client-map")
            )).scalar_one()
            resp2 = await upload_filename_map(
                "sess-map",
                body=FilenameMapRequest(map={
                    "https://example.com/b.png": "images/b.png",
                }),
                client=client,
                db=db,
            )
            await db.commit()
        assert resp2.mappings_count == 2

        # Follow-up read in a third session returns the UNION, not the
        # original map.
        async with factory() as db:
            row = (await db.execute(
                sa_select(Session).where(Session.id == "sess-map")
            )).scalar_one()
            assert row.filename_map == {
                "https://example.com/a.png": "images/a.png",
                "https://example.com/b.png": "images/b.png",
            }

    @pytest.mark.asyncio
    async def test_merge_overwrites_same_url_keys(self, sqlite_db):
        """Re-uploading a URL key replaces its mapping (dict-merge semantics)."""
        from sqlalchemy import select as sa_select

        from app.api.routes.resources import FilenameMapRequest, upload_filename_map
        from app.models.client import Client
        from app.models.session import Session

        _engine, factory = sqlite_db

        async with factory() as db:
            db.add(Client(
                id="client-map2", api_key="k-map2",
                api_key_hash=Client.hash_key("k-map2"),
            ))
            db.add(Session(
                id="sess-map2", client_id="client-map2",
                url="https://example.com",
                status=SessionStatus.UPLOADING,
                expires_at=datetime.now(timezone.utc) + timedelta(days=1),
                filename_map={"https://example.com/a.png": "images/old.png"},
            ))
            await db.commit()

        async with factory() as db:
            client = (await db.execute(
                sa_select(Client).where(Client.id == "client-map2")
            )).scalar_one()
            await upload_filename_map(
                "sess-map2",
                body=FilenameMapRequest(map={
                    "https://example.com/a.png": "images/new.png",
                }),
                client=client,
                db=db,
            )
            await db.commit()

        async with factory() as db:
            row = (await db.execute(
                sa_select(Session).where(Session.id == "sess-map2")
            )).scalar_one()
            assert row.filename_map == {
                "https://example.com/a.png": "images/new.png",
            }


# ---------------------------------------------------------------------------
# 3.5 — gzip bomb guard
# ---------------------------------------------------------------------------


class TestGzipBombGuard:
    """Bounded decompression: small gzipped payloads inflating past the
    per-resource ceiling / session budget are rejected with 413 BEFORE the
    full inflated buffer is allocated."""

    def _gz(self, payload: bytes) -> bytes:
        import gzip as _gzip
        return _gzip.compress(payload)

    @pytest.mark.asyncio
    async def test_gzip_bomb_rejected_413(self, tmp_path):
        """~10 KB compressed inflating to 10 MB with a 1 MB ceiling → 413."""
        import gzip as _gzip

        session_id = "sess-bomb"
        client_id = "client-bomb"
        storage_root = str(tmp_path)

        db = _mock_db(
            _scalar_one(_mock_session(session_id, client_id)),  # session lookup
            _scalar(0),                                          # session size query
        )

        bomb = self._gz(b"A" * (10 * 1024 * 1024))
        assert len(bomb) < 100_000  # genuinely small compressed payload

        with patch("app.api.routes.resources.settings") as cfg, \
             patch("app.api.routes.resources.resource_upload_limiter") as limiter, \
             patch("app.api.routes.resources.require_session_owner"):
            cfg.max_session_size_mb = 100
            cfg.max_resource_inflate_mb = 1  # hard ceiling: 1 MB
            cfg.storage_root = storage_root
            limiter.is_allowed.return_value = (True, 0)

            with pytest.raises(HTTPException) as exc:
                await upload_resource(
                    session_id=session_id,
                    request=_mock_request(content_length=None),
                    file=_AsyncUploadFile(bomb, "bomb.css"),
                    path="styles/bomb.css",
                    originalUrl="https://example.com/bomb.css",
                    contentType="text/css",
                    x_content_gzipped=True,
                    client=MagicMock(id=client_id),
                    db=db,
                )

        assert exc.value.status_code == 413
        assert exc.value.detail["error"] == "inflated_size_exceeded"

        # Nothing written to disk
        resources_dir = os.path.join(storage_root, session_id, "resources")
        assert not os.path.exists(resources_dir) or os.listdir(resources_dir) == []

    @pytest.mark.asyncio
    async def test_gzip_within_budget_is_stored(self, tmp_path):
        """A gzipped payload inflating under the cap is stored decompressed."""
        session_id = "sess-gz-ok"
        client_id = "client-gz-ok"
        storage_root = str(tmp_path)

        payload = b"body { color: red; }\n" * 20  # 420 bytes inflated
        gz = self._gz(payload)

        db = _mock_db(
            _scalar_one(_mock_session(session_id, client_id)),  # session lookup
            _scalar(0),                                          # session size query
            _scalar_one(None),                                   # dedup → no match
            MagicMock(),                                        # counter UPDATE (Round 9)
        )

        with patch("app.api.routes.resources.settings") as cfg, \
             patch("app.api.routes.resources.resource_upload_limiter") as limiter, \
             patch("app.api.routes.resources.require_session_owner"):
            cfg.max_session_size_mb = 100
            cfg.max_resource_inflate_mb = 1
            cfg.storage_root = storage_root
            limiter.is_allowed.return_value = (True, 0)

            response = await upload_resource(
                session_id=session_id,
                request=_mock_request(content_length=None),
                file=_AsyncUploadFile(gz, "main.css"),
                path="styles/main.css",
                originalUrl="https://example.com/main.css",
                contentType="text/css",
                x_content_gzipped=True,
                client=MagicMock(id=client_id),
                db=db,
            )

        assert response.deduplicated is False
        assert response.size == len(payload)

        # The stored file holds the DECOMPRESSED content
        resources_dir = os.path.join(storage_root, session_id, "resources")
        written = os.listdir(resources_dir)
        assert len(written) == 1
        with open(os.path.join(resources_dir, written[0]), "rb") as f:
            assert f.read() == payload

    @pytest.mark.asyncio
    async def test_gzip_rejected_when_session_budget_exhausted(self, tmp_path):
        """No remaining session budget → 413 before any decompression."""
        session_id = "sess-gz-full"
        client_id = "client-gz-full"
        storage_root = str(tmp_path)

        db = _mock_db(
            _scalar_one(_mock_session(session_id, client_id)),  # session lookup
            _scalar(100 * 1024 * 1024),                          # session already full
        )

        with patch("app.api.routes.resources.settings") as cfg, \
             patch("app.api.routes.resources.resource_upload_limiter") as limiter, \
             patch("app.api.routes.resources.require_session_owner"):
            cfg.max_session_size_mb = 100
            cfg.max_resource_inflate_mb = 1
            cfg.storage_root = storage_root
            limiter.is_allowed.return_value = (True, 0)

            with pytest.raises(HTTPException) as exc:
                await upload_resource(
                    session_id=session_id,
                    request=_mock_request(content_length=None),
                    file=_AsyncUploadFile(self._gz(b"tiny"), "x.css"),
                    path="styles/x.css",
                    originalUrl="https://example.com/x.css",
                    contentType="text/css",
                    x_content_gzipped=True,
                    client=MagicMock(id=client_id),
                    db=db,
                )

        assert exc.value.status_code == 413
        assert exc.value.detail["error"] == "session_size_exceeded"


# ---------------------------------------------------------------------------
# 3.5 helper — bounded decompression unit checks
# ---------------------------------------------------------------------------


class TestDecompressBounded:
    """Unit tests for the _decompress_bounded helper."""

    def test_rejects_output_past_cap(self):
        import gzip as _gzip

        from app.api.routes.resources import _GzipBombError, _decompress_bounded

        bomb = _gzip.compress(b"x" * 5_000_000)
        with pytest.raises(_GzipBombError):
            _decompress_bounded(bomb, 1024 * 1024)

    def test_accepts_output_within_cap(self):
        import gzip as _gzip

        from app.api.routes.resources import _decompress_bounded

        payload = b"y" * 4096
        assert _decompress_bounded(_gzip.compress(payload), 1 << 20) == payload

    def test_rejects_truncated_stream(self):
        import gzip as _gzip

        from app.api.routes.resources import _decompress_bounded

        blob = _gzip.compress(b"z" * 100)
        with pytest.raises(EOFError):
            _decompress_bounded(blob[: len(blob) // 2], 1 << 20)

    def test_rejects_malformed_stream(self):
        import zlib

        from app.api.routes.resources import _decompress_bounded

        with pytest.raises(zlib.error):
            _decompress_bounded(b"not-gzip-at-all", 1 << 20)

    def test_handles_multimember_stream(self):
        import gzip as _gzip

        from app.api.routes.resources import _decompress_bounded

        payload1 = b"a" * 2048
        payload2 = b"b" * 2048
        blob = _gzip.compress(payload1) + _gzip.compress(payload2)
        assert _decompress_bounded(blob, 1 << 20) == payload1 + payload2

    def test_multimember_bomb_still_rejected(self):
        import gzip as _gzip

        from app.api.routes.resources import _GzipBombError, _decompress_bounded

        blob = _gzip.compress(b"a" * 2048) + _gzip.compress(b"b" * 5_000_000)
        with pytest.raises(_GzipBombError):
            _decompress_bounded(blob, 1 << 20)


# ---------------------------------------------------------------------------
# server-api — mutations rejected while status=assembling
# ---------------------------------------------------------------------------


class TestAssemblingStatusRejected:
    """Resource uploads and filename-map merges are rejected with 409 once a
    session has moved past scraping/uploading (i.e. status='assembling')."""

    @pytest.mark.asyncio
    async def test_resource_upload_rejected_when_assembling(self):
        session = _mock_session(
            session_id="sess-asm", client_id="client-asm",
            status=SessionStatus.ASSEMBLING,
        )
        db = _mock_db(_scalar_one(session))  # session lookup → 409 before size queries

        with patch("app.api.routes.resources.settings") as cfg, \
             patch("app.api.routes.resources.resource_upload_limiter") as limiter, \
             patch("app.api.routes.resources.require_session_owner"):
            cfg.max_session_size_mb = 100
            cfg.storage_root = "/tmp/unused"
            limiter.is_allowed.return_value = (True, 0)

            with pytest.raises(HTTPException) as exc:
                await upload_resource(
                    session_id="sess-asm",
                    request=_mock_request(content_length=None),
                    file=_AsyncUploadFile(b"x"),
                    path="images/late.png",
                    originalUrl="https://example.com/late.png",
                    contentType="image/png",
                    x_content_gzipped=False,
                    client=MagicMock(id="client-asm"),
                    db=db,
                )

        assert exc.value.status_code == 409
        assert exc.value.detail["error"] == "invalid_status"
        assert exc.value.detail["api_version"] == "v1"
        assert "assembling" in exc.value.detail["message"]

    @pytest.mark.asyncio
    async def test_resource_upload_rejected_when_ready(self):
        """The guard covers every non scraping/uploading status (e.g. ready)."""
        session = _mock_session(
            session_id="sess-ready", client_id="client-ready",
            status=SessionStatus.READY,
        )
        db = _mock_db(_scalar_one(session))

        with patch("app.api.routes.resources.settings") as cfg, \
             patch("app.api.routes.resources.resource_upload_limiter") as limiter, \
             patch("app.api.routes.resources.require_session_owner"):
            cfg.max_session_size_mb = 100
            cfg.storage_root = "/tmp/unused"
            limiter.is_allowed.return_value = (True, 0)

            with pytest.raises(HTTPException) as exc:
                await upload_resource(
                    session_id="sess-ready",
                    request=_mock_request(content_length=None),
                    file=_AsyncUploadFile(b"x"),
                    path="images/late.png",
                    originalUrl="https://example.com/late.png",
                    contentType="image/png",
                    x_content_gzipped=False,
                    client=MagicMock(id="client-ready"),
                    db=db,
                )

        assert exc.value.status_code == 409
        assert exc.value.detail["error"] == "invalid_status"

    @pytest.mark.asyncio
    async def test_filename_map_rejected_when_assembling(self):
        from app.api.routes.resources import FilenameMapRequest, upload_filename_map

        session = _mock_session(
            session_id="sess-map-asm", client_id="client-map-asm",
            status=SessionStatus.ASSEMBLING,
        )
        db = _mock_db(_scalar_one(session))

        with pytest.raises(HTTPException) as exc:
            await upload_filename_map(
                "sess-map-asm",
                body=FilenameMapRequest(map={"https://example.com/a.png": "images/a.png"}),
                client=MagicMock(id="client-map-asm"),
                db=db,
            )

        assert exc.value.status_code == 409
        assert exc.value.detail["error"] == "invalid_status"
        assert exc.value.detail["api_version"] == "v1"
        # The map must not have been touched on the rejected session
        db.flush.assert_not_called()
