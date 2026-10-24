"""Session routes: CRUD, status, scrape-complete, content upload, and finalize."""

import asyncio
import logging
import os
import re
import shutil
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy import update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import get_current_client, require_session_owner
from app.config import settings
from app.db.database import get_db
from app.models.client import Client
from app.models.html_chunk import HtmlChunk
from app.models.resource import Resource
from app.models.session import Session, SessionStatus
from app.services import archive_client
from app.services.assembly_manager import assembly_task_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/sessions", tags=["sessions"])

# Host header sanity for forwarded values: hostname (optionally :port) or a
# bracketed IPv6 literal (optionally :port). Anything else is ignored so a
# misconfigured proxy cannot inject path/authority characters into built URLs.
_FORWARDED_HOST_RE = re.compile(
    r"^[A-Za-z0-9._\-]+(?::\d+)?$|^\[[0-9A-Fa-f:.]+\](?::\d+)?$"
)
_FORWARDED_SCHEMES = ("http", "https")


def external_base_url(request: Request) -> str:
    """Absolute base URL as seen by external clients, for building links
    such as ``download_url`` (deployment-routing: "Download URL is correct
    behind the proxy").

    When ``settings.trust_proxy`` is set — the same gate client-IP resolution
    uses (7.8) — explicit ``X-Forwarded-Proto`` / ``X-Forwarded-Host`` are
    preferred so built URLs carry the public scheme and host instead of the
    internal one. Otherwise (no headers, partial headers, unknown scheme,
    malformed host, or trust_proxy disabled) the request's own base URL wins.

    Note on layering: uvicorn's ``proxy_headers`` handling (on by default,
    ``forwarded_allow_ips`` defaults to 127.0.0.1 — the same-host nginx) may
    already have folded a trusted proxy's ``X-Forwarded-Proto`` and Host into
    ``request.base_url``; this helper makes the preference explicit and test-
    able instead of relying on server defaults.
    """
    base = str(request.base_url).rstrip("/")
    if not settings.trust_proxy:
        return base

    scheme, _, host_and_path = base.partition("://")

    forwarded_proto = (
        (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    )
    if forwarded_proto in _FORWARDED_SCHEMES:
        scheme = forwarded_proto

    forwarded_host = (
        (request.headers.get("x-forwarded-host") or "").split(",")[0].strip()
    )
    if forwarded_host and _FORWARDED_HOST_RE.match(forwarded_host):
        # Keep any path prefix from base_url (root_path), swap only the host.
        parts = host_and_path.split("/", 1)
        host_and_path = forwarded_host if len(parts) == 1 else f"{forwarded_host}/{parts[1]}"

    return f"{scheme}://{host_and_path}"


# --- Pydantic models ---


class SessionOptions(BaseModel):
    """Options for session creation."""

    singleFile: bool = Field(False, description="Produce single-file HTML output")
    downloadContentAsMarkdown: bool = Field(
        False,
        description="Produce Markdown export (content.md / pages/*.md) in the ZIP",
    )
    # text-native-downloads 3.1: format-selection options. Absent keys keep
    # the legacy behavior for old session payloads: HTML on, text flag off.
    downloadHtml: bool = Field(
        True,
        description="Include index.html / HTML pages in the artifact "
        "(false = text-only output; requires at least one text format)",
    )
    downloadContentAsText: bool = Field(
        False,
        description="Deliver the uploaded extracted text (content.txt) as a "
        "first-class text format",
    )
    retentionDays: int = Field(
        settings.default_retention_days,
        ge=settings.min_retention_days,
        le=settings.max_retention_days,
        description="Days until session expires (clamped 1-30)",
    )
    pagepocketUserId: str | None = Field(
        None, description="PagePocket user ID for cloud push after assembly"
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
    # text-native-downloads: set when output_type is "file" (a raw single-file
    # text artifact); None for "html" and "zip", whose behavior is unchanged.
    output_filename: str | None = None
    output_content_type: str | None = None
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
    finalized_at: datetime | None = None
    updated_at: datetime | None = None
    assembly_elapsed_seconds: int | None = None
    download_url: str | None = None
    output_type: str | None = None
    # text-native-downloads: set when output_type is "file"; see
    # SessionResponse.
    output_filename: str | None = None
    output_content_type: str | None = None
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


def _resolve_output_fields(
    session: Session,
) -> tuple[str | None, str | None, str | None]:
    """Resolve (output_type, output_filename, output_content_type).

    text-native-downloads 3.2: a raw single-file text artifact (content.md /
    content.txt) is delivered as ``output_type="file"`` with the exact
    filename and MIME the assembler recorded on the session options.
    ``singleFile`` HTML stays ``"html"`` and ZIP bundles stay ``"zip"`` —
    both unchanged, with null filename/content-type fields.
    """
    if session.status != SessionStatus.READY or not session.zip_path:
        return None, None, None
    options = session.options or {}
    out_name = options.get("outputFilename")
    out_content_type = options.get("outputContentType")
    if out_name and out_content_type:
        return "file", out_name, out_content_type
    if options.get("singleFile"):
        return "html", None, None
    return "zip", None, None


def _session_to_response(session: Session) -> SessionResponse:
    """Convert Session ORM object to response model."""
    output_size = None
    output_type, output_filename, output_content_type = _resolve_output_fields(session)
    if output_type is not None and os.path.exists(session.zip_path):
        output_size = os.path.getsize(session.zip_path)

    # Counter truth model (fix-archived-page-pipeline C): html_chunks and
    # resources_received are NOT updated per-upload (deadlock fix).
    # resources_received is reconciled exactly once, at finalize (the
    # guarded status-transition UPDATE), so the stored value is truthful
    # for terminal sessions and may lag for active ones. Two sources of
    # truth: this stored column (create/list responses) and the live
    # /status aggregates (COUNT over the resources table) for anything
    # in flight — the extension resume path reads the latter.
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
        output_filename=output_filename,
        output_content_type=output_content_type,
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

    # --- Cloud identity binding (harden-backend-security-and-ops 3.1, D4) ---
    # The cloud push identity is sourced EXCLUSIVELY from the server-side
    # client binding written by POST /api/v1/cloud/link. A client-supplied
    # pagepocketUserId is a hint at most: accepted only when it matches the
    # binding, rejected with 403 otherwise (forged ids must never be able to
    # target another user's PagePocket archive).
    bound_user_id = client.pagepocket_user_id
    if opts.pagepocketUserId is not None:
        if not bound_user_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "error": "cloud_not_linked",
                    "message": "This client has no PagePocket cloud binding. "
                    "Call POST /api/v1/cloud/link with a PagePocket access "
                    "token before requesting cloud push.",
                    "api_version": "v1",
                },
            )
        if opts.pagepocketUserId != bound_user_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "error": "cloud_identity_mismatch",
                    "message": "pagepocketUserId does not match this client's "
                    "bound cloud identity",
                    "api_version": "v1",
                },
            )

    now = datetime.now(timezone.utc)
    session = Session(
        client_id=client.id,
        url=body.url,
        status=SessionStatus.SCRAPING,
        options={
            "singleFile": opts.singleFile,
            "retentionDays": retention_days,
            "downloadContentAsMarkdown": opts.downloadContentAsMarkdown,
            "downloadHtml": opts.downloadHtml,
            "downloadContentAsText": opts.downloadContentAsText,
        },
        expires_at=now + timedelta(days=retention_days),
        pagepocket_user_id=bound_user_id,
        pagepocket_plan=client.pagepocket_plan,
    )
    db.add(session)
    await db.flush()

    # Create session storage directory
    session_dir = os.path.join(settings.storage_root, session.id)
    resources_dir = os.path.join(session_dir, "resources")
    os.makedirs(resources_dir, exist_ok=True)

    # Commit before returning so the session is visible to subsequent
    # requests (uploadHtmlChunk, etc.) when they arrive before the
    # post-response get_db() commit runs.
    await db.commit()

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
    output_type, output_filename, output_content_type = _resolve_output_fields(session)
    output_size = None
    if output_type is not None:
        # Construct absolute download URL from the externally-visible base URL
        base_url = external_base_url(request)
        download_url = f"{base_url}/api/v1/sessions/{session.id}/download"
        if session.zip_path and os.path.exists(session.zip_path):
            output_size = os.path.getsize(session.zip_path)

    # Compute counters from aggregates (session counters are no longer
    # updated per-upload to avoid MySQL deadlocks; the stored
    # resources_received column is only reconciled once at finalize).
    # These live aggregates remain the authoritative API view at every
    # stage — the extension resume path consumes this endpoint.
    html_chunk_count = (await db.execute(
        select(func.count()).select_from(HtmlChunk).where(HtmlChunk.session_id == session_id)
    )).scalar() or 0
    resource_count = (await db.execute(
        select(func.count()).select_from(Resource).where(Resource.session_id == session_id)
    )).scalar() or 0
    total_size = (await db.execute(
        select(func.coalesce(func.sum(Resource.size), 0)).where(Resource.session_id == session_id)
    )).scalar() or 0

    cloud_status_val = None
    cloud_page_id_val = None
    cloud_error_val = None
    if session.pagepocket_user_id:
        cloud_status_val = session.cloud_status
        cloud_page_id_val = session.cloud_page_id
        cloud_error_val = session.cloud_error

    # Assembly envelope fields (6.1, additive): let clients distinguish an
    # actively progressing assembly from a stalled one by surfacing when
    # finalization happened and how long the assembly has been running.
    finalized_at = session.finalized_at
    updated_at = session.updated_at
    elapsed_seconds = None
    if finalized_at is not None and session.status == SessionStatus.ASSEMBLING:
        reference = updated_at or finalized_at
        now = datetime.now(timezone.utc)
        if reference.tzinfo is None:
            reference = reference.replace(tzinfo=timezone.utc)
        elapsed_seconds = max(0, int((now - reference).total_seconds()))

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
        finalized_at=finalized_at,
        updated_at=updated_at,
        assembly_elapsed_seconds=elapsed_seconds,
        download_url=download_url,
        output_type=output_type,
        output_filename=output_filename,
        output_content_type=output_content_type,
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
    delete_cloud: bool = False,
    client: Client = Depends(get_current_client),  # noqa: B008
    db: AsyncSession = Depends(get_db),  # noqa: B008
) -> dict:
    """Cancel or delete a session and all associated files.

    The ``delete_cloud`` query parameter opts in to deleting the session's
    archived PagePocket page as well (cloud-via-server D2) — but the cloud
    outcome NEVER affects the local deletion: the local removal (files +
    record) is authoritative and runs first, the cloud RPC is a single
    attempt with no retries, and every failure mode degrades to
    ``cloud: {"deleted": false, "reason": ...}`` in a 200 response.
    """
    session = await _get_session_or_404(session_id, db)
    require_session_owner(client, session.client_id)

    # Resolve the opt-in cloud-delete gate BEFORE the local removal — the
    # session fields it reads are gone once the row is deleted. Gate (D2):
    # only a successfully pushed page whose cloud identity still matches the
    # caller's binding may be deleted; anything else is skipped with a
    # reason and the local delete proceeds regardless.
    cloud_outcome: dict = {"deleted": False, "reason": "not_requested"}
    cloud_identity: str | None = None
    cloud_page_id: str | None = None
    if delete_cloud:
        if session.cloud_status == "success" and session.cloud_page_id:
            if session.pagepocket_user_id and (
                client.pagepocket_user_id == session.pagepocket_user_id
            ):
                # Opt-in eligible — deleted after the local removal below.
                cloud_identity = session.pagepocket_user_id
                cloud_page_id = session.cloud_page_id
            else:
                # Caller unbound or re-bound to another PagePocket user —
                # not the cloud page's owner.
                cloud_outcome = {"deleted": False, "reason": "binding_mismatch"}
        else:
            # cloud_status != "success" or no cloud page to delete.
            cloud_outcome = {"deleted": False, "reason": "not_cloud"}

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

    # Cloud-side delete (D2, opt-in): runs AFTER the authoritative local
    # removal, off the event loop, and cannot raise — the local delete is
    # never rolled back by a cloud failure.
    if cloud_identity and cloud_page_id:
        cloud_outcome = await _delete_cloud_page(cloud_identity, cloud_page_id)

    return {
        "deleted": True,
        "cloud": cloud_outcome,
        "api_version": "v1",
    }


async def _delete_cloud_page(user_id: str, page_id: str) -> dict:
    """Run the blocking cloud DeletePage RPC off the event loop (D2).

    Single attempt (no retry budget) and failure-isolated: every error path
    returns ``{"deleted": False, "reason": "cloud_error"}`` — this helper
    never raises, so the already-completed local deletion is never rolled
    back. NOT_FOUND maps to idempotent success inside ``delete_page``.
    """
    try:
        result = await asyncio.to_thread(
            archive_client.delete_page, user_id, page_id,
        )
    except Exception as exc:
        logger.warning(
            "Cloud delete RPC failed (local delete unaffected): "
            "user=%s page=%s error=%s", user_id, page_id, exc,
        )
        return {"deleted": False, "reason": "cloud_error"}

    if result.deleted:
        logger.info("Cloud page deleted: user=%s page=%s", user_id, page_id)
        return {"deleted": True}

    logger.warning(
        "Cloud delete rejected (local delete unaffected): "
        "user=%s page=%s error=%s", user_id, page_id, result.error,
    )
    return {"deleted": False, "reason": "cloud_error"}


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

    The same guarded transition UPDATE reconciles the stale-by-design
    ``resources_received`` column to the live resources-table count
    (one write per session lifetime; per-upload counter updates were
    removed by the documented deadlock fix). A ``resources_discovered``
    deficit is logged as a structured warning — visibility only, never a
    refusal; the /status endpoint's live aggregates remain the API truth.
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
    # The resource count is computed unconditionally: besides the
    # empty-session check it feeds the finalize-time resources_received
    # reconciliation and the discovery/received deficit warning below
    # (fix-archived-page-pipeline C).
    html_chunk_count_stmt = select(func.count()).select_from(HtmlChunk).where(
        HtmlChunk.session_id == session_id
    )
    html_chunk_count = (await db.execute(html_chunk_count_stmt)).scalar() or 0
    resource_count_stmt = select(func.count()).select_from(Resource).where(
        Resource.session_id == session_id
    )
    resource_count = (await db.execute(resource_count_stmt)).scalar() or 0
    # Captured before the transition so the deficit warning below reads a
    # plain local (the guarded UPDATE is Core-level and never touches this
    # ORM object's attributes).
    discovered = session.resources_discovered
    if html_chunk_count == 0 and resource_count == 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": "empty_session",
                "message": "Session has no HTML chunks or resources",
                "api_version": "v1",
            },
        )

    # Transition to assembling with a single guarded UPDATE (3.4):
    # `WHERE status = 'uploading'` makes the transition atomic — a concurrent
    # finalize blocks on the InnoDB row lock, re-evaluates the predicate after
    # the first commit, matches zero rows (rowcount == 0) and receives 409.
    # This guarantees exactly one assembly task is ever registered.
    #
    # The same statement reconciles the stale-by-design resources_received
    # column (fix-archived-page-pipeline C): the column is NOT updated
    # per-upload (documented deadlock fix), so it is written exactly once
    # per session lifetime here, from the authoritative aggregate
    # `resource_count` computed above — zero extra statements, zero new
    # lock scope beyond the row this UPDATE already touches.
    now = datetime.now(timezone.utc)
    transition = await db.execute(
        sa_update(Session)
        .where(
            Session.id == session_id,
            Session.status == SessionStatus.UPLOADING,
        )
        .values(
            status=SessionStatus.ASSEMBLING,
            assembly_phase="merging_html",
            assembly_progress_pct=0,
            finalized_at=now,
            resources_received=resource_count,
        )
    )
    if transition.rowcount == 0:
        # Another request won the transition (or the status changed between
        # the read above and this write). Report the authoritative status.
        await db.rollback()
        current = await _get_session_or_404(session_id, db)
        current_status = (
            current.status.value
            if isinstance(current.status, SessionStatus)
            else current.status
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "invalid_status",
                "message": f"Session is already in '{current_status}' status",
                "current_status": current_status,
                "api_version": "v1",
            },
        )

    # Commit immediately so that polling requests see "assembling" status
    # right away, and so the row lock is released for other workers.
    await db.commit()

    # Finalize-time integrity warning (fix-archived-page-pipeline C): when
    # the client reported more discovered resources than are actually
    # stored, say so LOUDLY — but purely as visibility. Finalize semantics
    # are unchanged: the deficit never blocks or alters the 202 outcome
    # (partial downloads remain valid). Emitted only after the guarded
    # transition succeeded, so 409/422 paths stay silent.
    if discovered is not None and discovered > resource_count:
        logger.warning(
            "resources_received deficit at finalize: session_id=%s "
            "resources_discovered=%d resources_received=%d "
            "(%d discovered resource(s) never uploaded; finalize proceeds)",
            session_id,
            discovered,
            resource_count,
            discovered - resource_count,
        )

    # Trigger the assembly pipeline as a background task
    import asyncio

    from app.db.database import async_session_factory
    from app.services.zip_assembler import zip_assembler_service

    async def _run_assembly() -> None:
        async with assembly_task_manager.semaphore:
            await zip_assembler_service.assemble_session(session_id, async_session_factory)

    task = asyncio.create_task(_run_assembly())
    assembly_task_manager.register(session_id, task)
    logger.info("Session finalized: id=%s — assembly pipeline triggered", session_id)

    return FinalizeResponse(
        id=session_id,
        status=SessionStatus.ASSEMBLING.value,
        message="Assembly pipeline started",
    )
