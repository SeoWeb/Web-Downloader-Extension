"""Route tests for POST /api/v1/sessions/{id}/content/pages (multipage-download-fixes 2.1).

Real-SQLite harness (same pattern as test_html_merger.py's replace_env):
the route handler runs against an in-file SQLite database with seeded
client + session rows, exercising the real aggregate quota queries.

Covers:
  - 201 store: file at content_pages/<page_url_hash>.txt, response contract,
    session updated_at touched
  - main-page store: page_url=null → literal "main" key (html.py:146-150 mirror)
  - replace-on-rewrite idempotency: re-POST replaces the file, no duplicate,
    replaced=True, net-growth quota charging
  - per-request cap: text over max_content_text_mb → 413 content_too_large,
    nothing written
  - session quota: 413 session_size_exceeded when resources+chunks+stored
    texts+upload exceed max_session_size_mb; rejected upload leaves stored
    texts untouched
  - auth/ownership: non-owner client → 403; unknown session → 404
  - status guard: terminal session → 409
"""

import hashlib
import os
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models import Base
from app.models.client import Client
from app.models.session import Session, SessionStatus

PAGE_SESSION_ID = "sess-page-content"
OTHER_CLIENT_ID = "client-other"
KB = 1024


def page_hash(page_url):
    """Same derivation as the route (and html.py:146-150)."""
    return hashlib.sha256(page_url.encode("utf-8")).hexdigest()[:16]


@pytest_asyncio.fixture
async def page_env(tmp_path):
    """SQLite DB with a seeded client + scraping session on a temp storage
    root; yields (session_factory, session_dir, storage_root)."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/pages.db")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    old_touch = datetime.now(timezone.utc) - timedelta(hours=1)
    async with factory() as db:
        db.add(Client(
            id="client-1", api_key="key-1",
            api_key_hash=Client.hash_key("key-1"),
        ))
        db.add(Session(
            id=PAGE_SESSION_ID, client_id="client-1",
            url="https://example.com",
            status=SessionStatus.SCRAPING,
            updated_at=old_touch,
            expires_at=datetime.now(timezone.utc) + timedelta(days=1),
        ))
        await db.commit()

    storage_root = str(tmp_path)
    session_dir = os.path.join(storage_root, PAGE_SESSION_ID)
    os.makedirs(session_dir, exist_ok=True)
    try:
        yield factory, session_dir, storage_root
    finally:
        await engine.dispose()


async def _upload_page(factory, storage_root, *, session_id=PAGE_SESSION_ID,
                       page_url="https://example.com/about", text="About text.",
                       client_id="client-1", auth=True,
                       max_session_size_mb=100, max_content_text_mb=5):
    """Invoke the per-page content route against the SQLite DB."""
    from app.api.routes.sessions import PageContentUploadRequest, upload_page_content

    async with factory() as db:
        if auth:
            # Route module-level import → the REAL ownership check runs
            # against the seeded session row.
            with patch("app.api.routes.sessions.settings") as cfg:
                cfg.max_session_size_mb = max_session_size_mb
                cfg.max_content_text_mb = max_content_text_mb
                cfg.storage_root = storage_root
                resp = await upload_page_content(
                    session_id=session_id,
                    body=PageContentUploadRequest(page_url=page_url, text=text),
                    client=MagicMock(id=client_id),
                    db=db,
                )
        else:
            with patch("app.api.routes.sessions.settings") as cfg, \
                 patch("app.api.routes.sessions.require_session_owner"):
                cfg.max_session_size_mb = max_session_size_mb
                cfg.max_content_text_mb = max_content_text_mb
                cfg.storage_root = storage_root
                resp = await upload_page_content(
                    session_id=session_id,
                    body=PageContentUploadRequest(page_url=page_url, text=text),
                    client=MagicMock(id=client_id),
                    db=db,
                )
    return resp


def _pages_dir(session_dir):
    return os.path.join(session_dir, "content_pages")


class TestPageContentStore:
    """201 store: hash key, response contract, timestamp touch."""

    @pytest.mark.asyncio
    async def test_store_linked_page_201(self, page_env):
        factory, session_dir, storage_root = page_env

        resp = await _upload_page(factory, storage_root)

        assert resp == {
            "message": "Page text stored",
            "page_url_hash": page_hash("https://example.com/about"),
            "replaced": False,
            "size": len("About text."),
            "api_version": "v1",
        }
        stored = os.path.join(
            _pages_dir(session_dir), f"{page_hash('https://example.com/about')}.txt",
        )
        with open(stored, encoding="utf-8") as f:
            assert f.read() == "About text."

        # Session modification timestamp touched (SQLite returns naive
        # datetimes — compare against a naive "now").
        async with factory() as db:
            row = (await db.execute(
                select(Session).where(Session.id == PAGE_SESSION_ID)
            )).scalar_one()
        assert row.updated_at > row.created_at - timedelta(seconds=1)
        assert row.updated_at >= (
            datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=1)
        )

    @pytest.mark.asyncio
    async def test_store_main_page_uses_literal_main_key(self, page_env):
        """page_url=null → key "main" (mirrors the html chunk scheme)."""
        factory, session_dir, storage_root = page_env

        resp = await _upload_page(
            factory, storage_root, page_url=None, text="Main page text",
        )

        assert resp["page_url_hash"] == "main"
        stored = os.path.join(_pages_dir(session_dir), "main.txt")
        with open(stored, encoding="utf-8") as f:
            assert f.read() == "Main page text"


class TestPageContentReplaceOnRewrite:
    """Re-POST the same page → file replaced, no duplicate, net-growth quota."""

    @pytest.mark.asyncio
    async def test_repost_replaces_file_without_duplicate(self, page_env):
        factory, session_dir, storage_root = page_env
        url = "https://example.com/about"

        first = await _upload_page(factory, storage_root, page_url=url, text="V1")
        second = await _upload_page(factory, storage_root, page_url=url, text="V2-longer")

        assert first["replaced"] is False
        assert second["replaced"] is True
        assert second["size"] == len("V2-longer")

        stored = os.path.join(_pages_dir(session_dir), f"{page_hash(url)}.txt")
        with open(stored, encoding="utf-8") as f:
            assert f.read() == "V2-longer"
        # No duplicate: deterministic key → exactly one .txt per hash.
        assert os.listdir(_pages_dir(session_dir)) == [f"{page_hash(url)}.txt"]
        # No temp files left behind by the atomic os.replace.
        assert not [n for n in os.listdir(_pages_dir(session_dir))
                    if ".tmp-" in n]

    @pytest.mark.asyncio
    async def test_replace_at_quota_charged_net_growth(self, page_env):
        """At full quota, an exact-size re-POST of an existing page text
        succeeds (charge = new − replaced = 0); a NEW page at the same
        quota is rejected."""
        factory, session_dir, storage_root = page_env
        url = "https://example.com/about"
        payload = "x" * (50 * KB)

        await _upload_page(
            factory, storage_root, page_url=url, text=payload,
            max_session_size_mb=1,
        )
        # Quota is now exactly full: 50 KB stored == 50 KB … wait, quota is
        # 1 MB; fill the rest via a real resource row.
        from app.models.resource import Resource

        async with factory() as db:
            db.add(Resource(
                session_id=PAGE_SESSION_ID,
                original_url="https://example.com/a.jpg",
                url_hash=hashlib.sha256(b"https://example.com/a.jpg").hexdigest(),
                local_path="images/a.jpg",
                storage_path=os.path.join(storage_root, PAGE_SESSION_ID, "r.jpg"),
                content_type="image/jpeg",
                size=1024 * 1024 - len(payload),  # fill quota to the brim
            ))
            await db.commit()

        # Same-size re-POST of the SAME page → net growth 0 → accepted.
        resp = await _upload_page(
            factory, storage_root, page_url=url, text=payload,
            max_session_size_mb=1,
        )
        assert resp["replaced"] is True

        # A different page (no replaced bytes) → full charge → 413.
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc:
            await _upload_page(
                factory, storage_root,
                page_url="https://example.com/other", text="tiny",
                max_session_size_mb=1,
            )
        assert exc.value.status_code == 413
        assert exc.value.detail["error"] == "session_size_exceeded"
        assert exc.value.detail["current_size"] == 1024 * 1024
        assert exc.value.detail["upload_size"] == len("tiny")


class TestPageContentCaps:
    """Per-request cap + session quota, mirroring the content-append route."""

    @pytest.mark.asyncio
    async def test_content_too_large_rejects_before_any_io(self, page_env):
        """text over max_content_text_mb → 413 content_too_large; the page
        file is never created and previously stored texts stay intact."""
        factory, session_dir, storage_root = page_env
        url = "https://example.com/about"

        await _upload_page(factory, storage_root, page_url=url, text="keep me")
        stored = os.path.join(_pages_dir(session_dir), f"{page_hash(url)}.txt")
        before = os.path.getsize(stored)

        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc:
            await _upload_page(
                factory, storage_root, page_url=url,
                text="y" * (5 * 1024 * 1024 + 1),  # over the default 5 MB cap
                max_content_text_mb=5,
            )

        assert exc.value.status_code == 413
        assert exc.value.detail["error"] == "content_too_large"
        assert exc.value.detail["upload_size"] == 5 * 1024 * 1024 + 1
        assert exc.value.detail["max_size"] == 5 * 1024 * 1024
        assert os.path.getsize(stored) == before, (
            "a cap-rejected upload must not touch the stored page text"
        )
        assert not [n for n in os.listdir(_pages_dir(session_dir))
                    if ".tmp-" in n], "no temp file may survive a rejection"

    @pytest.mark.asyncio
    async def test_oversized_first_upload_writes_nothing(self, page_env):
        """An oversized FIRST upload creates no content_pages directory at
        all (rejection precedes any I/O)."""
        factory, session_dir, storage_root = page_env

        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc:
            await _upload_page(
                factory, storage_root,
                text="y" * (1024 * 1024 + 1),  # 1 byte over a 1 MB cap
                max_content_text_mb=1,
            )

        assert exc.value.status_code == 413
        assert not os.path.exists(_pages_dir(session_dir)), (
            "the cap fires before I/O — no directory may be created"
        )

    @pytest.mark.asyncio
    async def test_session_quota_rejected_leaves_stored_texts(self, page_env):
        """An accepted-size upload that would exceed the session quota →
        413 session_size_exceeded; existing stored texts count against the
        quota and are left untouched."""
        factory, session_dir, storage_root = page_env
        url_a = "https://example.com/about"
        url_b = "https://example.com/team"

        from app.models.resource import Resource
        from fastapi import HTTPException

        # 600 KB of resources + 400 KB of chunks + the stored 100 KB page
        # text = 1,126,400 bytes — already past the 1 MB quota, so ANY new
        # page upload must be rejected with the true pre-state total.
        await _upload_page(
            factory, storage_root, page_url=url_a, text="a" * (100 * KB),
            max_session_size_mb=1,
        )
        async with factory() as db:
            db.add(Resource(
                session_id=PAGE_SESSION_ID,
                original_url="https://example.com/a.jpg",
                url_hash=hashlib.sha256(b"https://example.com/a.jpg").hexdigest(),
                local_path="images/a.jpg",
                storage_path=os.path.join(storage_root, PAGE_SESSION_ID, "r.jpg"),
                content_type="image/jpeg",
                size=600 * KB,
            ))
            db.add(Resource(
                session_id=PAGE_SESSION_ID,
                original_url="https://example.com/s.js",
                url_hash=hashlib.sha256(b"https://example.com/s.js").hexdigest(),
                local_path="scripts/s.js",
                storage_path=os.path.join(storage_root, PAGE_SESSION_ID, "s.js"),
                content_type="application/javascript",
                size=400 * KB,
            ))
            await db.commit()

        with pytest.raises(HTTPException) as exc:
            await _upload_page(
                factory, storage_root, page_url=url_b, text="b" * 100,
                max_session_size_mb=1,
            )

        assert exc.value.status_code == 413
        assert exc.value.detail["error"] == "session_size_exceeded"
        assert exc.value.detail["current_size"] == (600 + 400 + 100) * KB
        assert exc.value.detail["upload_size"] == 100
        # The previously stored page text is untouched.
        stored_a = os.path.join(_pages_dir(session_dir), f"{page_hash(url_a)}.txt")
        assert os.path.getsize(stored_a) == 100 * KB


class TestPageContentAuthAndState:
    """Ownership (403), unknown session (404), terminal status (409)."""

    @pytest.mark.asyncio
    async def test_non_owner_client_rejected_403(self, page_env):
        factory, _session_dir, storage_root = page_env

        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc:
            await _upload_page(
                factory, storage_root, client_id=OTHER_CLIENT_ID,
            )
        assert exc.value.status_code == 403
        assert exc.value.detail["error"] == "forbidden"

    @pytest.mark.asyncio
    async def test_unknown_session_404(self, page_env):
        factory, _session_dir, storage_root = page_env

        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc:
            await _upload_page(
                factory, storage_root, session_id="sess-does-not-exist",
            )
        assert exc.value.status_code == 404
        assert exc.value.detail["error"] == "not_found"

    @pytest.mark.asyncio
    async def test_terminal_session_rejected_409(self, page_env):
        factory, _session_dir, storage_root = page_env

        async with factory() as db:
            row = (await db.execute(
                select(Session).where(Session.id == PAGE_SESSION_ID)
            )).scalar_one()
            row.status = SessionStatus.READY
            await db.commit()

        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc:
            await _upload_page(factory, storage_root)
        assert exc.value.status_code == 409
        assert exc.value.detail["error"] == "invalid_status"

    @pytest.mark.asyncio
    async def test_uploading_session_accepted(self, page_env):
        """Uploading sessions (post scrape-complete) are accepted too."""
        factory, _session_dir, storage_root = page_env

        async with factory() as db:
            row = (await db.execute(
                select(Session).where(Session.id == PAGE_SESSION_ID)
            )).scalar_one()
            row.status = SessionStatus.UPLOADING
            await db.commit()

        resp = await _upload_page(factory, storage_root)
        assert resp["message"] == "Page text stored"
