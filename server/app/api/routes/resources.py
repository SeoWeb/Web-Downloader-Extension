"""Resource upload and filename map routes."""

import hashlib
import logging
import math
import os
import uuid
import zlib

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    Header,
    HTTPException,
    Request,
    UploadFile,
    status,
)
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import get_current_client, require_session_owner
from app.api.rate_limiter import resource_upload_limiter
from app.config import settings
from app.db.database import get_db
from app.models.client import Client
from app.models.resource import Resource
from app.models.session import Session, SessionStatus

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/sessions", tags=["resources"])


class _GzipBombError(Exception):
    """Raised when gzipped content inflates past the configured cap (3.5)."""


def _decompress_bounded(data: bytes, max_output: int) -> bytes:
    """Decompress a gzip payload, refusing to inflate past ``max_output`` bytes.

    Streaming/bounded variant of ``gzip.decompress`` (3.5): output is capped
    BEFORE full decompression, so a small gzipped payload that declares an
    enormous inflated size is rejected without allocating the buffer.
    Handles multi-member (concatenated) gzip streams like gzip.decompress.

    Raises:
        _GzipBombError: inflated size exceeds ``max_output``.
        zlib.error: malformed gzip stream.
        EOFError: truncated gzip stream.
    """
    if max_output <= 0:
        raise _GzipBombError("inflate cap is zero")

    out = bytearray()
    member = data  # remaining compressed bytes for the current member
    while member:
        decomp = zlib.decompressobj(zlib.MAX_WBITS | 16)  # gzip wrapper
        # max_length-bounded decompress: output per call is capped, surplus
        # input lands in unconsumed_tail so we can stop as soon as the cap
        # is exceeded.
        piece = decomp.decompress(member, max_output - len(out) + 1)
        out += piece
        while decomp.unconsumed_tail:
            if len(out) > max_output:
                raise _GzipBombError(
                    f"inflated size exceeds cap of {max_output} bytes"
                )
            piece = decomp.decompress(
                decomp.unconsumed_tail, max_output - len(out) + 1
            )
            out += piece
            if not piece and decomp.unconsumed_tail:
                # No progress with output room remaining — cannot happen for
                # a valid stream; bail out to avoid a spin.
                break
        if len(out) > max_output:
            raise _GzipBombError(f"inflated size exceeds cap of {max_output} bytes")

        # Flush any final buffered output (bounded — at most the window size).
        out += decomp.flush()
        if len(out) > max_output:
            raise _GzipBombError(f"inflated size exceeds cap of {max_output} bytes")

        if not decomp.eof:
            raise EOFError("truncated gzip stream")

        # Multi-member streams: continue with any trailing member.
        member = decomp.unused_data

    return bytes(out)


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
        # Gzip path with bounded decompression (3.5): the inflated size is
        # capped BEFORE decompression at min(remaining session budget, hard
        # per-resource ceiling) so a gzip bomb cannot exhaust memory or the
        # session quota. Compressed input is streamed in chunks and capped at
        # the same bound (compressed data is never larger than its inflated
        # form for a payload within budget), so neither the input nor the
        # inflated buffer is allocated beyond the cap.
        max_session_bytes = settings.max_session_size_mb * 1024 * 1024
        current_total_result = await db.execute(sa_text(SIZE_QUERY), {"sid": session_id})
        current_total = current_total_result.scalar() or 0
        remaining_budget = max_session_bytes - current_total
        hard_ceiling = settings.max_resource_inflate_mb * 1024 * 1024
        inflate_cap = min(remaining_budget, hard_ceiling)

        if inflate_cap <= 0:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail={
                    "error": "session_size_exceeded",
                    "message": f"Session already at size limit ({settings.max_session_size_mb}MB)",
                    "current_size": int(current_total),
                    "max_size": max_session_bytes,
                    "api_version": "v1",
                },
            )

        compressed = bytearray()
        while True:
            chunk = await file.read(65536)  # 64 KB compressed chunks
            if not chunk:
                break
            compressed.extend(chunk)
            if len(compressed) > inflate_cap:
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail={
                        "error": "inflated_size_exceeded",
                        "message": "Compressed payload exceeds the per-resource "
                        "ceiling and remaining session budget",
                        "inflate_cap_bytes": inflate_cap,
                        "max_resource_inflate_mb": settings.max_resource_inflate_mb,
                        "api_version": "v1",
                    },
                )

        try:
            content = _decompress_bounded(bytes(compressed), inflate_cap)
        except _GzipBombError:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail={
                    "error": "inflated_size_exceeded",
                    "message": "Inflated resource size exceeds the per-resource "
                    "ceiling and remaining session budget",
                    "inflate_cap_bytes": inflate_cap,
                    "max_resource_inflate_mb": settings.max_resource_inflate_mb,
                    "api_version": "v1",
                },
            )
        except (zlib.error, EOFError) as e:
            logger.warning("Failed to decompress gzip resource: %s", e)
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "error": "decompression_failed",
                    "message": "Failed to decompress gzip content",
                    "api_version": "v1",
                },
            )
        original_size = len(content)

        # Authoritative session-size double check (kept from the previous
        # behavior; the inflate cap already bounds this in practice).
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

    # Merge with existing map — copy BEFORE mutating (3.3). Mutating the
    # already-persistent JSON object in place (`existing_map.update(...)`
    # then re-assigning the same object) is invisible to SQLAlchemy change
    # tracking: the attribute is not marked dirty, flush() emits no UPDATE,
    # and the merge silently never commits. Assigning a NEW dict gives the
    # attribute a fresh identity so the ORM detects and persists the change.
    session.filename_map = {**(session.filename_map or {}), **body.map}
    merged_map = session.filename_map

    await db.flush()

    logger.info(
        "Filename map updated: session=%s entries=%d",
        session_id,
        len(merged_map),
    )

    return FilenameMapResponse(
        mappings_count=len(merged_map),
    )
