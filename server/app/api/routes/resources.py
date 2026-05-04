"""Resource upload and filename map routes."""

import gzip
import hashlib
import logging
import math
import os
import uuid

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Request, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import IntegrityError

from app.api.dependencies import get_current_client, require_session_owner
from app.api.rate_limiter import resource_upload_limiter
from app.config import settings
from app.db.database import get_db
from app.models.client import Client
from app.models.resource import Resource
from app.models.session import Session, SessionStatus

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/sessions", tags=["resources"])


class ResourceUploadResponse(BaseModel):
    """Response for resource upload."""

    resource_id: str
    local_path: str | None
    size: int
    deduplicated: bool = False
    api_version: str = "v1"


class FilenameMapRequest(BaseModel):
    """Request body for filename map upload."""

    map: dict[str, str]


class FilenameMapResponse(BaseModel):
    """Response for filename map upload."""

    mappings_count: int
    api_version: str = "v1"


@router.post(
    "/{session_id}/resources",
    response_model=ResourceUploadResponse,
    summary="Upload a resource file",
)
async def upload_resource(
    session_id: str,
    request: Request,
    file: UploadFile = File(...),  # noqa: B008
    path: str = Form(...),  # noqa: B008
    originalUrl: str = Form(...),  # noqa: B008
    contentType: str = Form(...),  # noqa: B008
    x_content_gzipped: bool = Header(False, alias="X-Content-Gzipped"),  # noqa: B008
    client: Client = Depends(get_current_client),  # noqa: B008
    db: AsyncSession = Depends(get_db),  # noqa: B008
) -> ResourceUploadResponse:
    """Upload a resource file (image, CSS, JS, document, font) via multipart.

    Supports pre-compressed payloads via X-Content-Gzipped header
    (only for text-based MIME types).
    """
    # Rate limiting per session
    allowed, retry_after = resource_upload_limiter.is_allowed(session_id)
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "error": "rate_limit_exceeded",
                "message": "Resource upload rate limit exceeded for this session",
                "api_version": "v1",
            },
            headers={"Retry-After": str(math.ceil(retry_after))},
        )

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

    # Reject uploads for any status other than scraping and uploading
    if session.status not in (SessionStatus.SCRAPING, SessionStatus.UPLOADING):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "invalid_status",
                "message": f"Cannot upload resources when session is in '{session.status.value}' status. "
                f"Uploads are only accepted in 'scraping' or 'uploading' status.",
                "api_version": "v1",
            },
        )

    from sqlalchemy import text as sa_text

    SIZE_QUERY = (
        "SELECT "
        "(SELECT COALESCE(SUM(size), 0) FROM resources WHERE session_id = :sid) "
        "+ (SELECT COALESCE(SUM(size), 0) FROM html_chunks WHERE session_id = :sid)"
    )
    max_session_bytes = settings.max_session_size_mb * 1024 * 1024

    # Early Content-Length pre-check for non-gzip uploads.
    # If the announced body size alone would breach the session quota we can
    # reject the request before reading any bytes — avoiding the cost of
    # streaming a large file we would discard anyway.
    if not x_content_gzipped:
        content_length_header = request.headers.get("content-length")
        if content_length_header:
            try:
                announced_size = int(content_length_header)
                pre_total_result = await db.execute(sa_text(SIZE_QUERY), {"sid": session_id})
                pre_total = pre_total_result.scalar() or 0
                if pre_total + announced_size > max_session_bytes:
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail={
                            "error": "session_size_exceeded",
                            "message": f"Upload would exceed session size limit ({settings.max_session_size_mb}MB)",
                            "current_size": int(pre_total),
                            "upload_size": announced_size,
                            "max_size": max_session_bytes,
                            "api_version": "v1",
                        },
                    )
            except ValueError:
                pass  # Ignore malformed Content-Length header

    # Allocate storage path before any I/O so the non-gzip streaming path can
    # write directly to the final location without a rename.
    resource_id = str(uuid.uuid4())
    session_dir = os.path.join(settings.storage_root, session_id)
    resources_dir = os.path.join(session_dir, "resources")
    os.makedirs(resources_dir, exist_ok=True)
    storage_path = os.path.join(resources_dir, resource_id)

    if x_content_gzipped:
        # Gzip path: full read is required for decompression.
        # Gzip payloads are typically small text assets so buffering is
        # acceptable here.
        content = await file.read()
        try:
            content = gzip.decompress(content)
            original_size = len(content)
        except Exception as e:
            logger.warning("Failed to decompress gzip resource: %s", e)
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "error": "decompression_failed",
                    "message": "Failed to decompress gzip content",
                    "api_version": "v1",
                },
            )

        # Check session size limit
        current_total_result = await db.execute(sa_text(SIZE_QUERY), {"sid": session_id})
        current_total = current_total_result.scalar() or 0
        if current_total + original_size > max_session_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail={
                    "error": "session_size_exceeded",
                    "message": f"Upload would exceed session size limit ({settings.max_session_size_mb}MB)",
                    "current_size": int(current_total),
                    "upload_size": original_size,
                    "max_size": max_session_bytes,
                    "api_version": "v1",
                },
            )

        # Check for duplicate resource by URL hash
        url_hash = hashlib.sha256(originalUrl.encode("utf-8")).hexdigest()
        dedup_stmt = select(Resource).where(
            Resource.session_id == session_id,
            Resource.url_hash == url_hash,
        )
        dedup_result = await db.execute(dedup_stmt)
        existing_resource = dedup_result.scalar_one_or_none()
        if existing_resource:
            return ResourceUploadResponse(
                resource_id=existing_resource.id,
                local_path=existing_resource.local_path,
                size=existing_resource.size,
                deduplicated=True,
            )

        # Write decompressed content to disk
        with open(storage_path, "wb") as f:
            f.write(content)

    else:
        # Non-gzip path: stream directly to disk in 256 KB chunks.
        # This prevents buffering large binary assets (images, fonts) in RAM.
        # Size check and dedup check happen after the write; the file is deleted
        # on rejection to keep disk clean.
        with open(storage_path, "wb") as f_out:
            while True:
                chunk = await file.read(262144)  # 256 KB chunks
                if not chunk:
                    break
                f_out.write(chunk)

        original_size = os.path.getsize(storage_path)

        # Post-write aggregate size check
        current_total_result = await db.execute(sa_text(SIZE_QUERY), {"sid": session_id})
        current_total = current_total_result.scalar() or 0
        if current_total + original_size > max_session_bytes:
            os.remove(storage_path)
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail={
                    "error": "session_size_exceeded",
                    "message": f"Upload would exceed session size limit ({settings.max_session_size_mb}MB)",
                    "current_size": int(current_total),
                    "upload_size": original_size,
                    "max_size": max_session_bytes,
                    "api_version": "v1",
                },
            )

        # Dedup check after size check (URL-hash based, same semantics as gzip path)
        url_hash = hashlib.sha256(originalUrl.encode("utf-8")).hexdigest()
        dedup_stmt = select(Resource).where(
            Resource.session_id == session_id,
            Resource.url_hash == url_hash,
        )
        dedup_result = await db.execute(dedup_stmt)
        existing_resource = dedup_result.scalar_one_or_none()
        if existing_resource:
            os.remove(storage_path)
            return ResourceUploadResponse(
                resource_id=existing_resource.id,
                local_path=existing_resource.local_path,
                size=existing_resource.size,
                deduplicated=True,
            )

    # Sanitize local path to prevent path traversal
    # Use PurePosixPath to validate no '..' components remain after normalization
    from pathlib import PurePosixPath

    safe_path = os.path.normpath(path).lstrip("/.")
    posix = PurePosixPath(safe_path)
    if ".." in posix.parts or posix.is_absolute():
        # Path traversal detected — use only the filename component to prevent escape
        safe_path = posix.name if posix.name and posix.name != "." else "unnamed_resource"

    # Create resource record
    resource = Resource(
        id=resource_id,
        session_id=session_id,
        original_url=originalUrl,
        url_hash=url_hash,
        local_path=safe_path,
        storage_path=storage_path,
        content_type=contentType,
        size=original_size,
    )

    try:
        db.add(resource)
        await db.flush()
    except IntegrityError:
        # Concurrent upload of same URL — treat as dedup
        await db.rollback()
        dedup_result = await db.execute(dedup_stmt)
        existing_resource = dedup_result.scalar_one_or_none()
        if existing_resource:
            # Clean up the file we just wrote
            if os.path.exists(storage_path):
                os.remove(storage_path)
            return ResourceUploadResponse(
                resource_id=existing_resource.id,
                local_path=existing_resource.local_path,
                size=existing_resource.size,
                deduplicated=True,
            )
        raise

    logger.info(
        "Resource uploaded: session=%s path=%s size=%d content_type=%s",
        session_id,
        safe_path,
        original_size,
        contentType,
    )

    return ResourceUploadResponse(
        resource_id=resource.id,
        local_path=resource.local_path,
        size=original_size,
        deduplicated=False,
    )


@router.post(
    "/{session_id}/filename-map",
    response_model=FilenameMapResponse,
    summary="Upload or merge filename map",
)
async def upload_filename_map(
    session_id: str,
    body: FilenameMapRequest,
    client: Client = Depends(get_current_client),  # noqa: B008
    db: AsyncSession = Depends(get_db),  # noqa: B008
) -> FilenameMapResponse:
    """Upload a URL-to-filename mapping. Merges with existing map.

    Only accepted when session is in scraping or uploading status.
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

    # Reject when assembling or later (only scraping/uploading accepted)
    if session.status not in (SessionStatus.SCRAPING, SessionStatus.UPLOADING):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "invalid_status",
                "message": "Cannot upload filename map when session is not in scraping or uploading status",
                "api_version": "v1",
            },
        )

    # Merge with existing map
    existing_map = session.filename_map or {}
    existing_map.update(body.map)
    session.filename_map = existing_map

    await db.flush()

    logger.info(
        "Filename map updated: session=%s entries=%d",
        session_id,
        len(existing_map),
    )

    return FilenameMapResponse(
        mappings_count=len(existing_map),
    )
