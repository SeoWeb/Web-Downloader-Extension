"""Tests for resource upload streaming and quota enforcement (resources.py).

Covers the quota/durability behaviours of fix-oom-memory-pressure and the
server-assembly-honesty change:

  1. Accurate quota measurement (D10, task 9.4): the whole-multipart
     Content-Length pre-check is REMOVED — the quota is measured on the
     decoded blob byte count. A near-limit upload whose multipart envelope
     (boundaries, form fields) would have breached the old pre-check is now
     accepted, while an oversized non-gzip stream is rejected MID-STREAM on
     bytes actually written and the partial file is removed.

  2. Post-write aggregate size check: after the 256 KB chunked write completes,
     if existing_total + final_size > limit the newly written file is deleted
     and 413 is returned.

  3. Dedup check after size check: when the size check passes but the URL is a
     duplicate, the newly written file is deleted and 200/deduplicated=True is
     returned.

  4. Durable uploads (D2, task 11.2): resource and filename-map uploads commit
     BEFORE the success response; a commit failure surfaces as an error and
     leaves no orphan row or file. Proven against a real SQLite database
     (fresh-session visibility).

  5. Bounded bodies/counts (D7, task 11.5): the per-session resource count cap
     (with dedup bypass) and the filename-map byte/entry caps return 413.

Implementation note: the module-level `engine = create_async_engine(...)` in
app/db/database.py requires aiomysql, which is not installed in the test
environment.  We stub that module via sys.modules before importing the route so
that no real connection is attempted.  Each test patches `settings` and the
rate-limiter to remain self-contained.  The SQLite-backed tests use the
shared `sqlite_db` fixture from conftest.py.
"""

import sys
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

# Stub the database module before any route import triggers engine creation
sys.modules.setdefault("app.db.database", MagicMock())

import hashlib  # noqa: E402  (must come after sys.modules patch)
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
# Tests — accurate quota measurement (D10, task 9.4): envelope vs decoded bytes
# ---------------------------------------------------------------------------


class TestAccurateQuotaMeasurement:
    """Quota enforcement measures the DECODED blob, not the multipart envelope.

    Realigns the removed whole-multipart Content-Length pre-check (task 9.4 /
    spec scenario "Multipart overhead does not reject a legitimate upload"):
    the old handler consulted ``request.headers['content-length']`` — which
    measures boundaries and form fields too — and 413-ed legitimate uploads
    near the limit. The new handler ignores the header entirely, enforces the
    remaining budget mid-stream on bytes actually written, and keeps the
    post-write aggregate check as the authoritative gate.
    """

    @pytest.mark.asyncio
    async def test_multipart_envelope_overhead_does_not_reject(self, tmp_path):
        """Decoded blob fits the budget; envelope-padded Content-Length does not.

        existing=9 MB, limit=10 MB → remaining 1_048_576 B. The blob is
        1_048_000 B (fits), but the multipart envelope adds ~600 B, so the old
        Content-Length pre-check saw 1_048_600 B > remaining and rejected.
        The upload must now be ACCEPTED on the decoded byte count.
        """
        session_id = "sess-envelope-ok"
        client_id = "client-envelope"
        storage_root = str(tmp_path)

        max_bytes = 10 * 1024 * 1024
        existing_bytes = 9 * 1024 * 1024
        remaining = max_bytes - existing_bytes  # 1_048_576
        envelope_overhead = 600  # boundaries + form fields (simulated)
        # Decoded blob fits (≤ remaining) but blob + envelope breaches it.
        blob = b"x" * (remaining - 576)  # 1_048_000
        announced = len(blob) + envelope_overhead  # 1_048_600 > remaining
        assert len(blob) <= remaining < announced

        db = _mock_db(
            _scalar_one(_mock_session(session_id, client_id)),  # session lookup
            _scalar(existing_bytes),                            # budget round-trip
            _scalar_one(None),                                  # dedup → no match
            MagicMock(),                                        # total_size UPDATE
        )

        with patch("app.api.routes.resources.settings") as cfg, \
             patch("app.api.routes.resources.resource_upload_limiter") as limiter, \
             patch("app.api.routes.resources.require_session_owner"):
            cfg.max_session_size_mb = 10
            cfg.max_resources_per_session = 10000
            cfg.storage_root = storage_root
            limiter.is_allowed.return_value = (True, 0)

            # content_length simulates the whole multipart body size, which the
            # old pre-check consumed and the new handler must ignore.
            response = await upload_resource(
                session_id=session_id,
                request=_mock_request(content_length=announced),
                file=_AsyncUploadFile(blob, "near-limit.bin"),
                path="files/near-limit.bin",
                originalUrl="https://example.com/near-limit.bin",
                contentType="application/octet-stream",
                x_content_gzipped=False,
                client=MagicMock(id=client_id),
                db=db,
            )

        assert response.deduplicated is False
        assert response.size == len(blob)

        # The full decoded blob is on disk.
        resources_dir = os.path.join(storage_root, session_id, "resources")
        written = os.listdir(resources_dir)
        assert len(written) == 1
        with open(os.path.join(resources_dir, written[0]), "rb") as f:
            assert len(f.read()) == len(blob)

    @pytest.mark.asyncio
    async def test_allows_upload_when_within_quota(self, tmp_path):
        """existing=10 MB, decoded blob=512 B, limit=100 MB → upload proceeds.

        Realigned mock script for the folded single-round-trip budget query
        (_SESSION_BUDGET_QUERY): the handler consumes exactly three execute()
        results — session lookup, budget, dedup — before the dedup early
        return; the old script's separate post-write size query no longer
        exists. The Content-Length header is irrelevant now (set large to
        prove the handler ignores it).
        """
        session_id = "sess-cl-ok"
        client_id = "client-ok"
        storage_root = str(tmp_path)

        existing_resource = MagicMock()
        existing_resource.id = "dup-id"
        existing_resource.local_path = "images/dup.jpg"
        existing_resource.size = 512

        db = _mock_db(
            _scalar_one(_mock_session(session_id, client_id)),  # session
            _scalar(10 * 1024 * 1024),                          # budget round-trip
            _scalar_one(existing_resource),                     # dedup → hit (early return)
        )

        with patch("app.api.routes.resources.settings") as cfg, \
             patch("app.api.routes.resources.resource_upload_limiter") as limiter, \
             patch("app.api.routes.resources.require_session_owner"):
            cfg.max_session_size_mb = 100
            cfg.max_resources_per_session = 10000
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

    @pytest.mark.asyncio
    async def test_oversized_stream_rejected_mid_stream(self, tmp_path):
        """Bytes written beyond the remaining budget abort MID-STREAM: 413 with
        written-byte accounting in the detail, partial file removed, no row.

        existing=9 MB, limit=10 MB → remaining 1_048_576 B; the stream is
        3 MB. Four 256 KB chunks (1_048_576 B) are written, then the fifth
        breaches the budget and the write aborts — the 413 detail reports
        baseline + bytes-actually-written, proving the rejection happened
        mid-stream (the old post-write-only check reported the untouched
        baseline and the full 3 MB).
        """
        session_id = "sess-midstream"
        client_id = "client-midstream"
        storage_root = str(tmp_path)

        max_bytes = 10 * 1024 * 1024
        existing_bytes = 9 * 1024 * 1024
        remaining = max_bytes - existing_bytes  # 1_048_576
        blob = b"y" * (3 * 1024 * 1024)

        # Only two results are scripted: after the budget round-trip the
        # handler must abort mid-stream WITHOUT ever reaching the dedup query
        # (a third consume would raise StopIteration).
        db = _mock_db(
            _scalar_one(_mock_session(session_id, client_id)),  # session lookup
            _scalar(existing_bytes),                            # budget round-trip
        )

        with patch("app.api.routes.resources.settings") as cfg, \
             patch("app.api.routes.resources.resource_upload_limiter") as limiter, \
             patch("app.api.routes.resources.require_session_owner"):
            cfg.max_session_size_mb = 10
            cfg.max_resources_per_session = 10000
            cfg.storage_root = storage_root
            limiter.is_allowed.return_value = (True, 0)

            with pytest.raises(HTTPException) as exc:
                await upload_resource(
                    session_id=session_id,
                    request=_mock_request(content_length=None),
                    file=_AsyncUploadFile(blob, "big.bin"),
                    path="files/big.bin",
                    originalUrl="https://example.com/big.bin",
                    contentType="application/octet-stream",
                    x_content_gzipped=False,
                    client=MagicMock(id=client_id),
                    db=db,
                )

        assert exc.value.status_code == 413
        assert exc.value.detail["error"] == "session_size_exceeded"

        # 4 whole 256 KB chunks fit before the budget is breached.
        written_before_abort = remaining // 262144 * 262144
        assert exc.value.detail["current_size"] == existing_bytes + written_before_abort, (
            "current_size must be baseline + bytes actually written when the "
            "stream was aborted (mid-stream enforcement), not the bare baseline"
        )
        assert exc.value.detail["upload_size"] > remaining

        # The partial file was removed and no row was ever created.
        resources_dir = os.path.join(storage_root, session_id, "resources")
        assert not os.path.exists(resources_dir) or os.listdir(resources_dir) == []
        db.flush.assert_not_called()


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


# ---------------------------------------------------------------------------
# D2 (task 11.2) — commit BEFORE the success response (SQLite-backed)
# ---------------------------------------------------------------------------


def _seed_client_and_session(factory, session_id, client_id, status=SessionStatus.UPLOADING):
    """Seed a Client + Session row pair and commit it (setup, not under test)."""
    from app.models.client import Client
    from app.models.session import Session

    async def _seed():
        async with factory() as db:
            db.add(Client(
                id=client_id, api_key=f"key-{client_id}",
                api_key_hash=Client.hash_key(f"key-{client_id}"),
            ))
            db.add(Session(
                id=session_id, client_id=client_id,
                url="https://example.com",
                status=status,
                expires_at=datetime.now(timezone.utc) + timedelta(days=1),
            ))
            await db.commit()

    return _seed()


class TestResourceCommitBeforeRespond:
    """D2 (task 11.2): upload_resource commits BEFORE the 200.

    Called directly with a REAL (SQLite) session whose commit is patched to
    raise — the handler must surface the failure (5xx in the app) and leave
    no orphan row/file, and on success the row must already be visible to a
    FRESH session (get_db()'s teardown commit runs after the response is
    sent, so only an in-handler commit can provide this guarantee).
    """

    @pytest.mark.asyncio
    async def test_commit_failure_raises_no_row_no_file_no_accounting(
        self, sqlite_db, tmp_path
    ):
        """commit() raising once → the error propagates, no row/file survives,
        and total_size accounting is unchanged."""
        from sqlalchemy import select

        from app.models.resource import Resource
        from app.models.session import Session

        _engine, factory = sqlite_db
        session_id, client_id = "sess-d2-fail", "client-d2-fail"
        await _seed_client_and_session(factory, session_id, client_id)

        blob = b"d2-failure-blob" * 32

        async with factory() as db:
            db.commit = AsyncMock(
                side_effect=RuntimeError("pool exhausted (simulated D2 commit failure)")
            )
            # Wrap (not replace) the real rollback so the discipline is both
            # asserted AND performed.
            real_rollback = db.rollback
            db.rollback = AsyncMock(side_effect=real_rollback)
            with patch("app.api.routes.resources.settings") as cfg, \
                 patch("app.api.routes.resources.resource_upload_limiter") as limiter, \
                 patch("app.api.routes.resources.require_session_owner"):
                cfg.max_session_size_mb = 1000
                cfg.max_resources_per_session = 10000
                cfg.storage_root = str(tmp_path)
                limiter.is_allowed.return_value = (True, 0)

                # The route re-raises after rollback → the app maps this to 5xx.
                with pytest.raises(RuntimeError, match="pool exhausted"):
                    await upload_resource(
                        session_id=session_id,
                        request=_mock_request(content_length=None),
                        file=_AsyncUploadFile(blob, "d2.bin"),
                        path="files/d2.bin",
                        originalUrl="https://example.com/d2.bin",
                        contentType="application/octet-stream",
                        x_content_gzipped=False,
                        client=MagicMock(id=client_id),
                        db=db,
                    )
                db.rollback.assert_awaited()

        # A FRESH session proves the rollback left nothing behind.
        async with factory() as db:
            rows = (await db.execute(
                select(Resource).where(Resource.session_id == session_id)
            )).scalars().all()
            assert rows == [], "no resource row may survive a failed commit"
            sess = (await db.execute(
                select(Session).where(Session.id == session_id)
            )).scalar_one()
            assert sess.total_size == 0, "total_size accounting must be unchanged"

        # The file written during the request was removed.
        resources_dir = os.path.join(str(tmp_path), session_id, "resources")
        assert not os.path.exists(resources_dir) or os.listdir(resources_dir) == []

    @pytest.mark.asyncio
    async def test_happy_path_row_visible_to_fresh_session(self, sqlite_db, tmp_path):
        """A 200 implies a COMMITTED row + file: visible to a fresh session
        immediately, with total_size accounting applied. The test never
        commits — only the handler's own commit can make the row visible."""
        from sqlalchemy import select

        from app.models.resource import Resource
        from app.models.session import Session

        _engine, factory = sqlite_db
        session_id, client_id = "sess-d2-ok", "client-d2-ok"
        await _seed_client_and_session(factory, session_id, client_id)

        blob = b"d2-happy-blob" * 16

        async with factory() as db:
            # Wrap (not replace) the real commit to assert the handler committed.
            real_commit = db.commit
            db.commit = AsyncMock(side_effect=real_commit)
            with patch("app.api.routes.resources.settings") as cfg, \
                 patch("app.api.routes.resources.resource_upload_limiter") as limiter, \
                 patch("app.api.routes.resources.require_session_owner"):
                cfg.max_session_size_mb = 1000
                cfg.max_resources_per_session = 10000
                cfg.storage_root = str(tmp_path)
                limiter.is_allowed.return_value = (True, 0)

                response = await upload_resource(
                    session_id=session_id,
                    request=_mock_request(content_length=None),
                    file=_AsyncUploadFile(blob, "d2-ok.bin"),
                    path="files/d2-ok.bin",
                    originalUrl="https://example.com/d2-ok.bin",
                    contentType="application/octet-stream",
                    x_content_gzipped=False,
                    client=MagicMock(id=client_id),
                    db=db,
                )
                assert response.deduplicated is False
                assert response.size == len(blob)
                db.commit.assert_awaited()  # D2: committed before the response

        # FRESH session: the row and the accounting are already durable.
        async with factory() as db:
            row = (await db.execute(
                select(Resource).where(Resource.session_id == session_id)
            )).scalar_one()
            assert row.size == len(blob)
            assert row.url_hash != ""
            sess = (await db.execute(
                select(Session).where(Session.id == session_id)
            )).scalar_one()
            assert sess.total_size == len(blob)

        with open(os.path.join(str(tmp_path), session_id, "resources", row.id), "rb") as f:
            assert f.read() == blob


class TestFilenameMapCommitBeforeRespond:
    """D2 (task 11.2, 2.3): upload_filename_map commits BEFORE the response."""

    @pytest.mark.asyncio
    async def test_commit_failure_rolls_back_to_stored_map(self, sqlite_db):
        """commit() raising → the merge is not persisted; a fresh session
        still sees the ORIGINAL stored map."""
        from sqlalchemy import select

        from app.api.routes.resources import FilenameMapRequest, upload_filename_map
        from app.models.client import Client
        from app.models.session import Session

        _engine, factory = sqlite_db
        await _seed_client_and_session(
            factory, "sess-map-d2-fail", "client-map-d2-fail"
        )
        # Give the session a pre-existing stored map (separate setup commit).
        async with factory() as db:
            sess = (await db.execute(
                select(Session).where(Session.id == "sess-map-d2-fail")
            )).scalar_one()
            sess.filename_map = {"https://example.com/kept.png": "images/kept.png"}
            await db.commit()

        async with factory() as db:
            client = (await db.execute(
                select(Client).where(Client.id == "client-map-d2-fail")
            )).scalar_one()
            db.commit = AsyncMock(
                side_effect=RuntimeError("deadlock (simulated D2 commit failure)")
            )
            real_rollback = db.rollback
            db.rollback = AsyncMock(side_effect=real_rollback)
            with pytest.raises(RuntimeError, match="deadlock"):
                await upload_filename_map(
                    "sess-map-d2-fail",
                    body=FilenameMapRequest(
                        map={"https://example.com/new.png": "images/new.png"}
                    ),
                    client=client,
                    db=db,
                )
            db.rollback.assert_awaited()

        async with factory() as db:
            sess = (await db.execute(
                select(Session).where(Session.id == "sess-map-d2-fail")
            )).scalar_one()
            assert sess.filename_map == {
                "https://example.com/kept.png": "images/kept.png",
            }, "the merged map must NOT survive a failed commit"

    @pytest.mark.asyncio
    async def test_happy_path_map_visible_to_fresh_session(self, sqlite_db):
        """A 200 implies the merged map is committed: a fresh session sees it
        without the test issuing any commit of its own."""
        from sqlalchemy import select

        from app.api.routes.resources import FilenameMapRequest, upload_filename_map
        from app.models.client import Client

        _engine, factory = sqlite_db
        await _seed_client_and_session(factory, "sess-map-d2-ok", "client-map-d2-ok")

        async with factory() as db:
            client = (await db.execute(
                select(Client).where(Client.id == "client-map-d2-ok")
            )).scalar_one()
            # Wrap (not replace) the real commit to assert the handler committed.
            real_commit = db.commit
            db.commit = AsyncMock(side_effect=real_commit)
            resp = await upload_filename_map(
                "sess-map-d2-ok",
                body=FilenameMapRequest(
                    map={"https://example.com/a.png": "images/a.png"}
                ),
                client=client,
                db=db,
            )
            assert resp.mappings_count == 1
            db.commit.assert_awaited()  # D2: committed before the response

        async with factory() as db:
            from app.models.session import Session

            sess = (await db.execute(
                select(Session).where(Session.id == "sess-map-d2-ok")
            )).scalar_one()
            assert sess.filename_map == {
                "https://example.com/a.png": "images/a.png",
            }


# ---------------------------------------------------------------------------
# D7 (task 11.5) — per-session resource count cap
# ---------------------------------------------------------------------------


class TestResourceCountCap:
    """The live resource COUNT for a session is capped at
    max_resources_per_session before any file write; deduplicated re-uploads
    (which add no row) bypass the cap. SQLite-backed so the count query runs
    for real."""

    @pytest.mark.asyncio
    async def test_count_cap_rejects_new_upload_413(self, sqlite_db, tmp_path):
        """At the cap, a NEW (non-duplicate) upload → 413
        resources_count_exceeded; no file written; row count unchanged."""
        from sqlalchemy import select as sa_select

        from app.models.resource import Resource

        _engine, factory = sqlite_db
        session_id, client_id = "sess-cap", "client-cap"
        await _seed_client_and_session(factory, session_id, client_id)

        dupe_url = "https://example.com/dupe.png"
        other_url = "https://example.com/other.png"
        async with factory() as db:
            from app.models.client import Client

            for url in (dupe_url, other_url):
                db.add(Resource(
                    session_id=session_id,
                    original_url=url,
                    url_hash=hashlib.sha256(url.encode("utf-8")).hexdigest(),
                    local_path="images/seeded.png",
                    storage_path="/nonexistent/seeded",
                    content_type="image/png",
                    size=100,
                ))
            client = (await db.execute(
                sa_select(Client).where(Client.id == client_id)
            )).scalar_one()
            await db.commit()

        # The count-cap query excludes THIS upload's url_hash, so the new URL
        # sees 2 stored rows (dupe + other) ≥ cap of 2 → reject.
        new_url = "https://example.com/brand-new.png"
        assert new_url not in (dupe_url, other_url)

        async with factory() as db:
            with patch("app.api.routes.resources.settings") as cfg, \
                 patch("app.api.routes.resources.resource_upload_limiter") as limiter, \
                 patch("app.api.routes.resources.require_session_owner"):
                cfg.max_session_size_mb = 1000
                cfg.max_resources_per_session = 2  # the cap under test
                cfg.storage_root = str(tmp_path)
                limiter.is_allowed.return_value = (True, 0)

                with pytest.raises(HTTPException) as exc:
                    await upload_resource(
                        session_id=session_id,
                        request=_mock_request(content_length=None),
                        file=_AsyncUploadFile(b"tiny"),
                        path="images/new.png",
                        originalUrl=new_url,
                        contentType="image/png",
                        x_content_gzipped=False,
                        client=client,
                        db=db,
                    )

        assert exc.value.status_code == 413
        assert exc.value.detail["error"] == "resources_count_exceeded"
        assert exc.value.detail["max_resources"] == 2

        # No row added, no file written.
        async with factory() as db:
            count = len((await db.execute(
                sa_select(Resource).where(Resource.session_id == session_id)
            )).scalars().all())
            assert count == 2
        resources_dir = os.path.join(str(tmp_path), session_id, "resources")
        assert not os.path.exists(resources_dir) or os.listdir(resources_dir) == []

    @pytest.mark.asyncio
    async def test_dedup_bypasses_count_cap(self, sqlite_db, tmp_path):
        """At the cap, an upload whose url_hash is ALREADY stored returns the
        existing resource (deduplicated) instead of 413 — and adds no row."""
        from sqlalchemy import select as sa_select

        from app.models.resource import Resource

        _engine, factory = sqlite_db
        session_id, client_id = "sess-cap-dedup", "client-cap-dedup"
        await _seed_client_and_session(factory, session_id, client_id)

        dupe_url = "https://example.com/dupe.png"
        other_url = "https://example.com/other.png"
        async with factory() as db:
            from app.models.client import Client

            for url in (dupe_url, other_url):
                db.add(Resource(
                    session_id=session_id,
                    original_url=url,
                    url_hash=hashlib.sha256(url.encode("utf-8")).hexdigest(),
                    local_path="images/dupe.png",
                    storage_path="/nonexistent/dupe",
                    content_type="image/png",
                    size=100,
                ))
            client = (await db.execute(
                sa_select(Client).where(Client.id == client_id)
            )).scalar_one()
            await db.commit()

        async with factory() as db:
            with patch("app.api.routes.resources.settings") as cfg, \
                 patch("app.api.routes.resources.resource_upload_limiter") as limiter, \
                 patch("app.api.routes.resources.require_session_owner"):
                cfg.max_session_size_mb = 1000
                cfg.max_resources_per_session = 2  # cap already reached
                cfg.storage_root = str(tmp_path)
                limiter.is_allowed.return_value = (True, 0)

                response = await upload_resource(
                    session_id=session_id,
                    request=_mock_request(content_length=None),
                    file=_AsyncUploadFile(b"retransmitted-bytes"),
                    path="images/dupe.png",
                    originalUrl=dupe_url,  # already stored → dedup
                    contentType="image/png",
                    x_content_gzipped=False,
                    client=client,
                    db=db,
                )

        assert response.deduplicated is True

        async with factory() as db:
            rows = (await db.execute(
                sa_select(Resource).where(Resource.session_id == session_id)
            )).scalars().all()
            assert len(rows) == 2, "a deduplicated re-upload adds no row"
        # The transient file written for the dedup check was discarded.
        resources_dir = os.path.join(str(tmp_path), session_id, "resources")
        assert not os.path.exists(resources_dir) or os.listdir(resources_dir) == []


# ---------------------------------------------------------------------------
# D7 (task 11.5) — filename map body caps
# ---------------------------------------------------------------------------


class TestFilenameMapBodyCaps:
    """Maps over max_filename_map_bytes or max_filename_map_entries are
    rejected with 413 filename_map_too_large BEFORE any mutation; the stored
    session state is untouched."""

    @pytest.mark.asyncio
    async def test_oversized_map_bytes_rejected_413(self, sqlite_db):
        from sqlalchemy import select

        from app.api.routes.resources import FilenameMapRequest, upload_filename_map
        from app.models.client import Client
        from app.models.session import Session

        _engine, factory = sqlite_db
        await _seed_client_and_session(factory, "sess-mapcap-b", "client-mapcap-b")
        async with factory() as db:
            sess = (await db.execute(
                select(Session).where(Session.id == "sess-mapcap-b")
            )).scalar_one()
            sess.filename_map = {"https://example.com/kept.png": "images/kept.png"}
            await db.commit()

        big_value = "x" * 4096  # serialized JSON far above the 64-byte cap
        oversized = {f"https://example.com/{big_value}": "images/big.png"}

        async with factory() as db:
            client = (await db.execute(
                select(Client).where(Client.id == "client-mapcap-b")
            )).scalar_one()
            with patch("app.api.routes.resources.settings") as cfg:
                cfg.max_filename_map_bytes = 64
                cfg.max_filename_map_entries = 20000

                with pytest.raises(HTTPException) as exc:
                    await upload_filename_map(
                        "sess-mapcap-b",
                        body=FilenameMapRequest(map=oversized),
                        client=client,
                        db=db,
                    )

        assert exc.value.status_code == 413
        assert exc.value.detail["error"] == "filename_map_too_large"
        assert exc.value.detail["map_bytes"] > 64

        async with factory() as db:
            sess = (await db.execute(
                select(Session).where(Session.id == "sess-mapcap-b")
            )).scalar_one()
            assert sess.filename_map == {
                "https://example.com/kept.png": "images/kept.png",
            }, "a rejected oversized map must leave stored state untouched"

    @pytest.mark.asyncio
    async def test_oversized_map_entries_rejected_413(self, sqlite_db):
        from sqlalchemy import select

        from app.api.routes.resources import FilenameMapRequest, upload_filename_map
        from app.models.client import Client

        _engine, factory = sqlite_db
        await _seed_client_and_session(factory, "sess-mapcap-e", "client-mapcap-e")

        # Four tiny entries: only the ENTRY cap can reject these.
        entries = {
            f"https://example.com/r{i}.png": f"images/r{i}.png" for i in range(4)
        }

        async with factory() as db:
            client = (await db.execute(
                select(Client).where(Client.id == "client-mapcap-e")
            )).scalar_one()
            with patch("app.api.routes.resources.settings") as cfg:
                cfg.max_filename_map_bytes = 2_000_000
                cfg.max_filename_map_entries = 3

                with pytest.raises(HTTPException) as exc:
                    await upload_filename_map(
                        "sess-mapcap-e",
                        body=FilenameMapRequest(map=entries),
                        client=client,
                        db=db,
                    )

        assert exc.value.status_code == 413
        assert exc.value.detail["error"] == "filename_map_too_large"
        assert exc.value.detail["map_entries"] == 4
        assert exc.value.detail["max_entries"] == 3
