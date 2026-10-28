"""HTML chunk upload route."""

import asyncio
import hashlib
import logging
import os
import uuid

import aiofiles
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import delete as sa_delete
from sqlalchemy import func as sa_func
from sqlalchemy import select
from sqlalchemy import text as sa_text
from sqlalchemy import update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import get_current_client, require_session_owner
from app.config import settings
from app.db.database import get_db
from app.models.client import Client
from app.models.html_chunk import HtmlChunk, PageType
from app.models.resource import Resource
from app.models.session import Session, SessionStatus

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/sessions", tags=["html"])


class HtmlChunkRequest(BaseModel):
    """Request body for HTML chunk upload."""

    html: str = Field(..., description="HTML chunk content")
    scrollIndex: int = Field(..., ge=0, description="Scroll position index")
    pageType: str = Field(
        "main",
        description="Page type: 'main' or 'linked'",
    )
    pageUrl: str | None = Field(
        None,
        description="Full URL of the page (required for linked pages)",
    )


class HtmlChunkResponse(BaseModel):
    """Response for HTML chunk upload."""

    chunk_id: str
    chunk_count: int
    total_size: int
    deduplicated: bool = False
    # D4: true when the chunk replaced a superseded chunk at the same
    # (page, scroll index) with different content.  Additive field —
    # older clients ignore it.
    replaced: bool = False
    api_version: str = "v1"


async def _aggregate_counts(db: AsyncSession, session_id: str) -> tuple[int, int]:
    """Aggregate (chunk_count, total_size) for the response.

    Uses aggregate queries instead of reading session counters to avoid
    locking the session row (prevents deadlocks with concurrent uploads).
    """
    chunk_count_result = await db.execute(
        select(sa_func.count(HtmlChunk.id)).where(HtmlChunk.session_id == session_id)
    )
    chunk_count = chunk_count_result.scalar() or 0
    total_size_result = await db.execute(
        sa_text(
            "SELECT "
            "(SELECT COALESCE(SUM(size), 0) FROM resources WHERE session_id = :sid) "
            "+ (SELECT COALESCE(SUM(size), 0) FROM html_chunks WHERE session_id = :sid)"
        ),
        {"sid": session_id},
    )
    total_size = total_size_result.scalar() or 0
    return chunk_count, int(total_size)


@router.post(
    "/{session_id}/html",
    response_model=HtmlChunkResponse,
    summary="Upload an HTML chunk",
)
async def upload_html_chunk(
    session_id: str,
    body: HtmlChunkRequest,
    client: Client = Depends(get_current_client),  # noqa: B008
    db: AsyncSession = Depends(get_db),  # noqa: B008
) -> HtmlChunkResponse:
    """Upload an HTML chunk to a session.

    First chunk initializes the skeleton. Subsequent chunks are appended.
    Duplicates are detected by content hash + scrollIndex.
    Chunks are stored in subdirectories by pageUrl hash.
    """
    # Get and validate session
    stmt = select(Session).where(Session.id == session_id)
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()

    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "not_found", "message": f"Session {session_id} not found", "api_version": "v1"},
        )

    require_session_owner(client, session.client_id)

    # Only accept uploads when scraping or uploading
    if session.status not in (SessionStatus.SCRAPING, SessionStatus.UPLOADING):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "invalid_status",
                "message": f"Cannot upload HTML when session is in '{session.status.value}' status",
                "api_version": "v1",
            },
        )

    # Check chunk size limit
    chunk_size = len(body.html.encode("utf-8"))
    max_chunk_mb = settings.max_html_chunk_size_mb
    if chunk_size > max_chunk_mb * 1024 * 1024:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={
                "error": "chunk_too_large",
                "message": f"HTML chunk size ({chunk_size} bytes) exceeds limit ({max_chunk_mb}MB)",
                "chunk_size": chunk_size,
                "max_size": max_chunk_mb * 1024 * 1024,
                "api_version": "v1",
            },
        )

    # Check cumulative session size limit — use aggregate queries to
    # avoid locking the session row (prevents deadlocks with concurrent
    # resource uploads). Sum both resources and html_chunks.
    current_total_result = await db.execute(
        sa_text(
            "SELECT "
            "(SELECT COALESCE(SUM(size), 0) FROM resources WHERE session_id = :sid) "
            "+ (SELECT COALESCE(SUM(size), 0) FROM html_chunks WHERE session_id = :sid)"
        ),
        {"sid": session_id},
    )
    current_total = current_total_result.scalar() or 0
    max_session_bytes = settings.max_session_size_mb * 1024 * 1024
    if current_total + chunk_size > max_session_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={
                "error": "session_size_exceeded",
                "message": f"HTML chunk upload would exceed session size limit ({settings.max_session_size_mb}MB)",
                "current_size": int(current_total),
                "upload_size": chunk_size,
                "max_size": max_session_bytes,
                "api_version": "v1",
            },
        )

    # Compute content hash and page URL hash
    content_hash = hashlib.sha256(body.html.encode("utf-8")).hexdigest()

    page_type = PageType.MAIN if body.pageType == "main" else PageType.LINKED
    if body.pageUrl:
        page_url_hash = hashlib.sha256(body.pageUrl.encode("utf-8")).hexdigest()[:16]
    else:
        page_url_hash = "main"

    # Check for duplicate chunk (same session + page + scroll_index + content).
    # first() (not scalar_one_or_none) tolerates legacy duplicate rows from
    # the pre-D4 overwrite bug without a MultipleResultsFound 500.
    dedup_stmt = select(HtmlChunk).where(
        HtmlChunk.session_id == session_id,
        HtmlChunk.page_url_hash == page_url_hash,
        HtmlChunk.scroll_index == body.scrollIndex,
        HtmlChunk.content_hash == content_hash,
    )
    dedup_result = await db.execute(dedup_stmt)
    existing_chunk = dedup_result.scalars().first()
    if existing_chunk:
        # Compute counts via aggregate (session counters are not updated
        # per-upload to avoid deadlocks)
        chunk_count, total_size = await _aggregate_counts(db, session_id)
        return HtmlChunkResponse(
            chunk_id=existing_chunk.id,
            chunk_count=chunk_count,
            total_size=total_size,
            deduplicated=True,
        )

    # D4 — same-index conflict detection: a chunk at this (page, scroll
    # index) with DIFFERENT content replaces the superseded chunk instead
    # of overwriting its file while inserting a second row referencing the
    # same path (the old behavior duplicated the chunk in merged output).
    # Exact retransmissions already returned via the dedup branch above,
    # so anything found here has a different content hash.
    conflict_stmt = select(HtmlChunk).where(
        HtmlChunk.session_id == session_id,
        HtmlChunk.page_url_hash == page_url_hash,
        HtmlChunk.scroll_index == body.scrollIndex,
    )
    conflict_result = await db.execute(conflict_stmt)
    superseded_chunks = conflict_result.scalars().all()
    replace_mode = bool(superseded_chunks)

    # Store chunk file on disk.  The content is written to a temp file and
    # atomically moved into place with os.replace (D4/D10): readers never
    # observe a missing or partially written chunk file, and in replace
    # mode the superseded content is swapped out without a gap.  aiofiles
    # keeps the write off the event loop (D10).
    session_dir = os.path.join(settings.storage_root, session_id)
    chunks_dir = os.path.join(
        session_dir, "chunks", page_type.value, page_url_hash
    )
    os.makedirs(chunks_dir, exist_ok=True)
    chunk_filename = f"{body.scrollIndex}.html"
    storage_path = os.path.join(chunks_dir, chunk_filename)
    temp_path = f"{storage_path}.tmp-{uuid.uuid4().hex[:12]}"

    try:
        async with aiofiles.open(temp_path, "w", encoding="utf-8") as f:
            await f.write(body.html)
        await asyncio.to_thread(os.replace, temp_path, storage_path)
    except OSError:
        # Best-effort temp cleanup; the final path either still holds the
        # superseded content (replace raced a failure) or never existed.
        try:
            os.remove(temp_path)
        except OSError:
            pass
        raise

    if replace_mode:
        # D4: delete the superseded rows in the SAME transaction that
        # inserts the replacement.  The html_chunks counter is NOT
        # incremented — the chunk count is unchanged by a replacement.
        await db.execute(
            sa_delete(HtmlChunk).where(
                HtmlChunk.id.in_([c.id for c in superseded_chunks])
            )
        )

    # Create chunk record
    chunk = HtmlChunk(
        session_id=session_id,
        page_type=page_type,
        page_url=body.pageUrl,
        page_url_hash=page_url_hash,
        scroll_index=body.scrollIndex,
        content_hash=content_hash,
        storage_path=storage_path,
        size=chunk_size,
    )
    db.add(chunk)
    await db.flush()

    if not replace_mode:
        # Round 9 counter fix: restore the stored sessions.html_chunks counter.
        # The deadlock fix removed ALL per-upload counter updates, but unlike
        # resources_received (reconciled once at finalize) this column was never
        # written again anywhere — so create/list responses (which read the
        # stored column) reported 0 even with chunks stored, including the very
        # first "main" skeleton chunk (pageType "main" / page_url_hash "main",
        # scrollIndex 0). Every non-duplicate chunk — main skeleton, appends,
        # linked pages — now increments the column atomically server-side (Core
        # UPDATE, same pattern as the finalize guarded transition); the /status
        # endpoint's live COUNT remains the authoritative in-flight view.
        await db.execute(
            sa_update(Session)
            .where(Session.id == session_id)
            .values(html_chunks=Session.html_chunks + 1)
        )

    # Register the chunk with the in-memory HTML merger service so that
    # the assembly pipeline can find it without relying on disk-based
    # job loading.  The first chunk initializes the skeleton; subsequent
    # chunks are registered as incremental body content.  In replace mode
    # ONLY the new content is registered (7.3): the superseded
    # registration is swapped by replace_chunk, never double-registered.
    from app.services.html_merger import html_merger_service
    job = html_merger_service.get_or_create_job(
        session_id=session_id,
        page_url_hash=page_url_hash,
        page_type=body.pageType,
        page_url=body.pageUrl,
    )
    if not job.initialized:
        html_merger_service.initialize_skeleton(job, body.html)
    elif replace_mode:
        html_merger_service.replace_chunk(
            job,
            content_hash,
            body.scrollIndex,
            storage_path,
            size_delta=chunk_size - sum(int(c.size) for c in superseded_chunks),
        )
    else:
        # Skip duplicate chunks (same content hash + scroll index)
        if not html_merger_service.is_duplicate_chunk(job, content_hash, body.scrollIndex):
            html_merger_service.register_chunk(job, content_hash, body.scrollIndex, storage_path, chunk_size)

    # D2 — commit BEFORE the success response.  get_db()'s teardown commit
    # runs after the response has been sent (FastAPI >= 0.106), so a
    # teardown-time failure (pool exhaustion, deadlock, MySQL restart)
    # would tell the client "200" while the row + counter rolled back.
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        # Remove the chunk file written during this request so no orphan
        # file survives the failed upload.  (In replace mode the superseded
        # content is already gone — os.replace swapped the new content in —
        # so the rolled-back row may reference a missing file until the
        # client's retry re-replaces it; the 5xx tells the client exactly
        # that.)
        try:
            await asyncio.to_thread(os.remove, storage_path)
        except OSError:
            logger.warning(
                "Failed to remove chunk file after commit failure: %s",
                storage_path,
            )
        raise

    # Post-commit: remove superseded chunk files that lived at a different
    # path than the replaced one (e.g. rows written under an older storage
    # root); their rows are gone, so the files would orphan.  The reused
    # path's file IS the new content and must stay.
    for old_chunk in superseded_chunks:
        old_path = old_chunk.storage_path
        if old_path and old_path != storage_path and os.path.exists(old_path):
            try:
                await asyncio.to_thread(os.remove, old_path)
            except OSError as exc:
                logger.warning(
                    "Failed to remove superseded chunk file %s: %s", old_path, exc
                )

    logger.info(
        "HTML chunk uploaded: session=%s scroll=%d page_type=%s size=%d%s",
        session_id,
        body.scrollIndex,
        page_type.value,
        chunk_size,
        " (replaced superseded chunk)" if replace_mode else "",
    )

    # Compute counts via aggregate (session counters are not updated
    # per-upload to avoid deadlocks)
    chunk_count, total_size = await _aggregate_counts(db, session_id)

    return HtmlChunkResponse(
        chunk_id=chunk.id,
        chunk_count=chunk_count,
        total_size=total_size,
        deduplicated=False,
        replaced=replace_mode,
    )
