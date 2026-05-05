"""Session routes: CRUD, status, scrape-complete, content upload, and finalize."""

import asyncio
import logging
import os
import shutil
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import get_current_client, require_session_owner
from app.config import settings
from app.db.database import get_db
from app.models.client import Client
from app.models.html_chunk import HtmlChunk
from app.models.resource import Resource
from app.models.session import Session, SessionStatus
from app.services.assembly_manager import assembly_task_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/sessions", tags=["sessions"])


# --- Pydantic models ---


class SessionOptions(BaseModel):
    """Options for session creation."""

    singleFile: bool = Field(False, description="Produce single-file HTML output")
    retentionDays: int = Field(
        settings.default_retention_days,
        ge=settings.min_retention_days,
        le=settings.max_retention_days,
        description="Days until session expires (clamped 1-30)",
    )


class CreateSessionRequest(BaseModel):
    """Request body for session creation."""

    url: str = Field(..., description="Original page URL being downloaded")
    options: SessionOptions | None = Field(
        None, description="Session options (singleFile, retentionDays)"
    )


class SessionResponse(BaseModel):
    """Response for session creation and listing."""

    id: str
    url: str
    status: str
    options: dict | None = None
    html_chunks: int = 0
    resources_discovered: int | None = None
    resources_received: int = 0
    created_at: datetime
    expires_at: datetime
    output_size: int | None = None
    output_type: str | None = None
    api_version: str = "v1"


class SessionListResponse(BaseModel):
    """Response for session listing."""

    sessions: list[SessionResponse]
    total: int
    api_version: str = "v1"


class SessionStatusResponse(BaseModel):
    """Detailed session status response."""

    id: str
    status: str
    url: str
    html_chunks: int = 0
    resources_discovered: int | None = None
    resources_received: int = 0
    total_size: int = 0
    assembly_phase: str | None = None
    assembly_progress_pct: int | None = None
    download_url: str | None = None
    output_type: str | None = None
    output_size: int | None = None
    error_message: str | None = None
    cloud_status: str | None = None
    cloud_page_id: str | None = None
    cloud_error: str | None = None
    api_version: str = "v1"


class ScrapeCompleteRequest(BaseModel):
    """Request body for scrape-complete signal."""

    resourceCount: int | None = Field(
        None, description="Total resources discovered for UI progress"
    )


class ContentUploadRequest(BaseModel):
    """Request body for text content upload."""

    text: str = Field(..., description="Text content for content.txt inclusion in ZIP")


class FinalizeResponse(BaseModel):
    """Response for finalize endpoint."""

    id: str
    status: str
    message: str
    api_version: str = "v1"


# --- Helper functions ---


def _session_to_response(session: Session) -> SessionResponse:
    """Convert Session ORM object to response model."""
    output_size = None
    output_type = None
    if session.status == SessionStatus.READY and session.zip_path:
        if session.options and session.options.get("singleFile"):
            output_type = "html"
        else:
            output_type = "zip"
        if os.path.exists(session.zip_path):
            output_size = os.path.getsize(session.zip_path)

    # Note: html_chunks and resources_received in the session row are
    # no longer updated per-upload (deadlock fix). For the list/create
    # endpoints we return the stored values (may be stale for active
    # sessions; use /status endpoint for live aggregates).
    return SessionResponse(
        id=session.id,
        url=session.url,
        status=session.status.value if isinstance(session.status, SessionStatus) else session.status,
        options=session.options,
        html_chunks=session.html_chunks,
        resources_discovered=session.resources_discovered,
        resources_received=session.resources_received,
        created_at=session.created_at,
        expires_at=session.expires_at,
        output_size=output_size,
        output_type=output_type,
    )


async def _get_session_or_404(
    session_id: str, db: AsyncSession
) -> Session:
    """Get session by ID or raise 404."""
    stmt = select(Session).where(Session.id == session_id)
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error": "not_found",
                "message": f"Session {session_id} not found",
                "api_version": "v1",
            },
        )
    return session


# --- Endpoints ---


@router.post(
    "",
    response_model=SessionResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new download session",
)
async def create_session(
    body: CreateSessionRequest,
    client: Client = Depends(get_current_client),  # noqa: B008
    db: AsyncSession = Depends(get_db),  # noqa: B008
) -> SessionResponse:
    """Create a new download session with optional singleFile and retentionDays options."""
    opts = body.options or SessionOptions()

    # Clamp retention days
    retention_days = max(
        settings.min_retention_days,
        min(settings.max_retention_days, opts.retentionDays),
    )

    now = datetime.now(timezone.utc)
    session = Session(
        client_id=client.id,
        url=body.url,
        status=SessionStatus.SCRAPING,
        options={
            "singleFile": opts.singleFile,
            "retentionDays": retention_days,
        },
        expires_at=now + timedelta(days=retention_days),
        pagepocket_user_id=client.pagepocket_user_id,
    )
    db.add(session)
    await db.flush()

    # Create session storage directory
    session_dir = os.path.join(settings.storage_root, session.id)
    resources_dir = os.path.join(session_dir, "resources")
    os.makedirs(resources_dir, exist_ok=True)

    logger.info("Created session: id=%s url=%s", session.id, body.url[:80])
    return _session_to_response(session)


@router.get(
    "",
    response_model=SessionListResponse,
    summary="List sessions for authenticated user",
)
async def list_sessions(
    limit: int = Query(20, ge=1, le=100, description="Number of sessions per page"),
    offset: int = Query(0, ge=0, description="Offset for pagination"),
    client: Client = Depends(get_current_client),  # noqa: B008
    db: AsyncSession = Depends(get_db),  # noqa: B008
) -> SessionListResponse:
    """List sessions belonging to the authenticated client with pagination."""
    # Count total
    count_stmt = (
        select(func.count())
        .select_from(Session)
        .where(Session.client_id == client.id)
    )
    total = (await db.execute(count_stmt)).scalar() or 0

    # Fetch page
    stmt = (
        select(Session)
        .where(Session.client_id == client.id)
        .order_by(Session.created_at.desc())
        .offset(offset)
        .limit(limit)
    )
    result = await db.execute(stmt)
    sessions = result.scalars().all()

    return SessionListResponse(
        sessions=[_session_to_response(s) for s in sessions],
        total=total,
    )


@router.get(
    "/{session_id}/status",
    response_model=SessionStatusResponse,
    summary="Get session status",
)
async def get_session_status(
    session_id: str,
    request: Request,
    client: Client = Depends(get_current_client),  # noqa: B008
    db: AsyncSession = Depends(get_db),  # noqa: B008
) -> SessionStatusResponse:
    """Return current status of a session including assembly progress and download URL."""
    session = await _get_session_or_404(session_id, db)
    require_session_owner(client, session.client_id)

    status_value = session.status.value if isinstance(session.status, SessionStatus) else session.status

    # Build download URL for ready sessions (absolute URL)
    download_url = None
    output_type = None
    output_size = None
    if session.status == SessionStatus.READY and session.zip_path:
        # Determine output type from file extension
        if session.options and session.options.get("singleFile"):
            output_type = "html"
        else:
            output_type = "zip"
        # Construct absolute download URL from request base URL
        base_url = str(request.base_url).rstrip("/")
        download_url = f"{base_url}/api/v1/sessions/{session.id}/download"
        if session.zip_path and os.path.exists(session.zip_path):
            output_size = os.path.getsize(session.zip_path)

    # Compute counters from aggregates (session counters are no longer
    # updated per-upload to avoid MySQL deadlocks).
    html_chunk_count = (await db.execute(
        select(func.count()).select_from(HtmlChunk).where(HtmlChunk.session_id == session_id)
    )).scalar() or 0
    resource_count = (await db.execute(
        select(func.count()).select_from(Resource).where(Resource.session_id == session_id)
    )).scalar() or 0
    total_size = (await db.execute(
        select(func.coalesce(func.sum(Resource.size), 0)).where(Resource.session_id == session_id)
    )).scalar() or 0

    from app.services.archive_client import is_configured as cloud_is_configured

    cloud_status_val = None
    cloud_page_id_val = None
    cloud_error_val = None
    if cloud_is_configured() and session.pagepocket_user_id:
        cloud_status_val = session.cloud_status
        cloud_page_id_val = session.cloud_page_id
        cloud_error_val = session.cloud_error

    return SessionStatusResponse(
        id=session.id,
        status=status_value,
        url=session.url,
        html_chunks=html_chunk_count,
        resources_discovered=session.resources_discovered,
        resources_received=resource_count,
        total_size=total_size,
        assembly_phase=session.assembly_phase,
        assembly_progress_pct=session.assembly_progress_pct,
        download_url=download_url,
        output_type=output_type,
        output_size=output_size,
        error_message=session.error_message,
        cloud_status=cloud_status_val,
        cloud_page_id=cloud_page_id_val,
        cloud_error=cloud_error_val,
    )


@router.delete(
    "/{session_id}",
    status_code=status.HTTP_200_OK,
    summary="Cancel/delete session and its files",
)
async def delete_session(
    session_id: str,
    client: Client = Depends(get_current_client),  # noqa: B008
    db: AsyncSession = Depends(get_db),  # noqa: B008
) -> dict:
    """Cancel or delete a session and all associated files."""
    session = await _get_session_or_404(session_id, db)
    require_session_owner(client, session.client_id)

    # If assembling, cancel the background task before cleanup
    if session.status == SessionStatus.ASSEMBLING:
        await assembly_task_manager.cancel(session_id)

    # Delete session files from disk (non-blocking)
    session_dir = os.path.join(settings.storage_root, session.id)
    await asyncio.to_thread(
        lambda: shutil.rmtree(session_dir, ignore_errors=True) if os.path.exists(session_dir) else None
    )

    # Delete session record — CASCADE removes resources and html_chunks
    await db.execute(delete(Session).where(Session.id == session_id))
    await db.flush()

    logger.info("Deleted session: id=%s", session_id)
    return {
        "message": f"Session {session_id} deleted",
        "api_version": "v1",
    }


@router.post(
    "/{session_id}/scrape-complete",
    summary="Signal that all HTML chunks have been uploaded",
)
async def scrape_complete(
    session_id: str,
    body: ScrapeCompleteRequest | None = None,
    client: Client = Depends(get_current_client),  # noqa: B008
    db: AsyncSession = Depends(get_db),  # noqa: B008
) -> dict:
    """Transition session from scraping to uploading status.

    Must be called after all HTML chunks have been uploaded.
    Only accepted when session is in 'scraping' status.
    """
    session = await _get_session_or_404(session_id, db)
    require_session_owner(client, session.client_id)

    if session.status != SessionStatus.SCRAPING:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "invalid_status",
                "message": f"Session is in '{session.status.value}' status, "
                f"expected 'scraping'",
                "current_status": session.status.value,
                "api_version": "v1",
            },
        )

    session.status = SessionStatus.UPLOADING
    if body and body.resourceCount is not None:
        session.resources_discovered = body.resourceCount

    await db.flush()
    # Commit immediately so that a subsequent finalize request can see
    # the "uploading" status.  Without this, the get_db() dependency commits
    # AFTER the response is sent, creating a race condition when the
    # extension calls scrape-complete → finalize in quick succession.
    await db.commit()

    logger.info("Session scrape-complete: id=%s", session_id)
    return {
        "id": session.id,
        "status": SessionStatus.UPLOADING.value,
        "message": "Session transitioned to uploading",
        "api_version": "v1",
    }


@router.post(
    "/{session_id}/content",
    summary="Upload text content for content.txt",
)
async def upload_content(
    session_id: str,
    body: ContentUploadRequest,
    client: Client = Depends(get_current_client),  # noqa: B008
    db: AsyncSession = Depends(get_db),  # noqa: B008
) -> dict:
    """Upload text content to be included as content.txt in the ZIP.

    Only accepted when session is in scraping or uploading status.
    Appends to any previously uploaded content (so linked page
    text can be uploaded separately after the main page text).
    """
    session = await _get_session_or_404(session_id, db)
    require_session_owner(client, session.client_id)

    if session.status not in (SessionStatus.SCRAPING, SessionStatus.UPLOADING):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "invalid_status",
                "message": f"Cannot upload content when session is in '{session.status.value}' status",
                "api_version": "v1",
            },
        )

    # Store content text as a file (append mode so linked page text
    # is added after the main page text rather than overwriting it)
    session_dir = os.path.join(settings.storage_root, session.id)
    content_path = os.path.join(session_dir, "content.txt")
    content_size = len(body.text.encode("utf-8"))
    with open(content_path, "a", encoding="utf-8") as f:
        f.write(body.text)

    logger.info("Content uploaded for session: id=%s size=%d", session_id, len(body.text))
    return {
        "message": "Content text stored",
        "size": len(body.text),
        "api_version": "v1",
    }


@router.post(
    "/{session_id}/finalize",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=FinalizeResponse,
    summary="Finalize session and trigger assembly",
)
async def finalize_session(
    session_id: str,
    client: Client = Depends(get_current_client),  # noqa: B008
    db: AsyncSession = Depends(get_db),  # noqa: B008
) -> FinalizeResponse:
    """Signal all uploads are complete and trigger assembly pipeline.

    Only accepted when session is in 'uploading' status.
    Returns 202 indicating assembly has started.
    If session is already in 'assembling' or 'ready' status, returns 409
    (client should treat as success and poll status).
    """
    session = await _get_session_or_404(session_id, db)
    require_session_owner(client, session.client_id)

    # Reject if still scraping — but retry briefly first, because the
    # extension may call scrape-complete → finalize in quick succession
    # and the DB commit from scrape-complete may not be visible yet.
    if session.status == SessionStatus.SCRAPING:
        import asyncio
        for _attempt in range(3):
            await asyncio.sleep(0.3)
            await db.rollback()
            session = await _get_session_or_404(session_id, db)
            if session.status != SessionStatus.SCRAPING:
                break

    # After retry, check status again
    session = await _get_session_or_404(session_id, db)

    # Already assembling or ready — treat as success per spec
    if session.status in (SessionStatus.ASSEMBLING, SessionStatus.READY):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "invalid_status",
                "message": f"Session is already in '{session.status.value}' status",
                "current_status": session.status.value,
                "api_version": "v1",
            },
        )

    # Reject if still scraping after retries
    if session.status == SessionStatus.SCRAPING:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "scraping_not_complete",
                "message": "Session is still in 'scraping' status. "
                "Call scrape-complete first.",
                "current_status": session.status.value,
                "api_version": "v1",
            },
        )

    # Reject if not in uploading status
    if session.status != SessionStatus.UPLOADING:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "invalid_status",
                "message": f"Session is in '{session.status.value}' status, "
                f"expected 'uploading'",
                "current_status": session.status.value,
                "api_version": "v1",
            },
        )

    # Check if session has any content — use aggregate queries since
    # session.html_chunks is no longer updated per-upload (deadlock fix).
    html_chunk_count_stmt = select(func.count()).select_from(HtmlChunk).where(
        HtmlChunk.session_id == session_id
    )
    html_chunk_count = (await db.execute(html_chunk_count_stmt)).scalar() or 0
    if html_chunk_count == 0:
        # Check for resources too
        resource_stmt = select(func.count()).select_from(Resource).where(
            Resource.session_id == session_id
        )
        resource_count = (await db.execute(resource_stmt)).scalar() or 0
        if resource_count == 0:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={
                    "error": "empty_session",
                    "message": "Session has no HTML chunks or resources",
                    "api_version": "v1",
                },
            )

    # Transition to assembling
    session.status = SessionStatus.ASSEMBLING
    session.assembly_phase = "merging_html"
    session.assembly_progress_pct = 0
    session.finalized_at = datetime.now(timezone.utc)
    await db.flush()
    # Commit immediately so that polling requests see "assembling" status
    # right away, instead of waiting for the get_db() post-yield commit.
    await db.commit()
    
    # Trigger the assembly pipeline as a background task
    import asyncio
    from app.services.zip_assembler import zip_assembler_service
    from app.db.database import async_session_factory
    
    async def _run_assembly() -> None:
        await zip_assembler_service.assemble_session(session_id, async_session_factory)
    
    task = asyncio.create_task(_run_assembly())
    assembly_task_manager.register(session_id, task)
    logger.info("Session finalized: id=%s — assembly pipeline triggered", session_id)
    
    return FinalizeResponse(
        id=session.id,
        status=SessionStatus.ASSEMBLING.value,
        message="Assembly pipeline started",
    )
