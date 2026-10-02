"""HTML chunk upload route."""

import hashlib
import logging
import os

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
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
    api_version: str = "v1"


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
    from sqlalchemy import text
    current_total_result = await db.execute(
        text(
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

    # Check for duplicate chunk (same session + page + scroll_index + content)
    dedup_stmt = select(HtmlChunk).where(
        HtmlChunk.session_id == session_id,
        HtmlChunk.page_url_hash == page_url_hash,
        HtmlChunk.scroll_index == body.scrollIndex,
        HtmlChunk.content_hash == content_hash,
    )
    dedup_result = await db.execute(dedup_stmt)
    existing_chunk = dedup_result.scalar_one_or_none()
    if existing_chunk:
        # Compute counts via aggregate (session counters are not updated
        # per-upload to avoid deadlocks)
        from sqlalchemy import func as sa_func_cnt, text as sa_text_cnt
        chunk_count_result = await db.execute(
            select(sa_func_cnt.count(HtmlChunk.id)).where(HtmlChunk.session_id == session_id)
        )
        chunk_count = chunk_count_result.scalar() or 0
        total_size_result = await db.execute(
            sa_text_cnt(
                "SELECT "
                "(SELECT COALESCE(SUM(size), 0) FROM resources WHERE session_id = :sid) "
                "+ (SELECT COALESCE(SUM(size), 0) FROM html_chunks WHERE session_id = :sid)"
            ),
            {"sid": session_id},
        )
        total_size = total_size_result.scalar() or 0
        return HtmlChunkResponse(
            chunk_id=existing_chunk.id,
            chunk_count=chunk_count,
            total_size=total_size,
            deduplicated=True,
        )

    # Store chunk file on disk
    session_dir = os.path.join(settings.storage_root, session_id)
    chunks_dir = os.path.join(
        session_dir, "chunks", page_type.value, page_url_hash
    )
    os.makedirs(chunks_dir, exist_ok=True)
    chunk_filename = f"{body.scrollIndex}.html"
    storage_path = os.path.join(chunks_dir, chunk_filename)

    with open(storage_path, "w", encoding="utf-8") as f:
        f.write(body.html)

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

    # Register the chunk with the in-memory HTML merger service so that
    # the assembly pipeline can find it without relying on disk-based
    # job loading.  The first chunk initializes the skeleton; subsequent
    # chunks are registered as incremental body content.
    from app.services.html_merger import html_merger_service
    job = html_merger_service.get_or_create_job(
        session_id=session_id,
        page_url_hash=page_url_hash,
        page_type=body.pageType,
        page_url=body.pageUrl,
    )
    if not job.initialized:
        html_merger_service.initialize_skeleton(job, body.html)
    else:
        # Skip duplicate chunks (same content hash + scroll index)
        if not html_merger_service.is_duplicate_chunk(job, content_hash, body.scrollIndex):
            html_merger_service.register_chunk(job, content_hash, body.scrollIndex, storage_path, chunk_size)

    logger.info(
        "HTML chunk uploaded: session=%s scroll=%d page_type=%s size=%d",
        session_id,
        body.scrollIndex,
        page_type.value,
        chunk_size,
    )

    # Compute counts via aggregate (session counters are not updated
    # per-upload to avoid deadlocks)
    from sqlalchemy import func as sa_func_resp, text as sa_text_resp
    chunk_count_result = await db.execute(
        select(sa_func_resp.count(HtmlChunk.id)).where(HtmlChunk.session_id == session_id)
    )
    chunk_count = chunk_count_result.scalar() or 0
    total_size_result = await db.execute(
        sa_text_resp(
            "SELECT "
            "(SELECT COALESCE(SUM(size), 0) FROM resources WHERE session_id = :sid) "
            "+ (SELECT COALESCE(SUM(size), 0) FROM html_chunks WHERE session_id = :sid)"
        ),
        {"sid": session_id},
    )
    total_size = total_size_result.scalar() or 0

    return HtmlChunkResponse(
        chunk_id=chunk.id,
        chunk_count=chunk_count,
        total_size=total_size,
        deduplicated=False,
    )
