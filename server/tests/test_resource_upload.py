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
