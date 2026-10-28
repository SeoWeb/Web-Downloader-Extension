"""Resource upload and filename map routes."""

import asyncio
import hashlib
import json
import logging
import math
import os
import uuid
import zlib

import aiofiles
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
from sqlalchemy import text as sa_text
from sqlalchemy import update as sa_update
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


# Single round-trip guard for both pre-write gates (6.4 count cap + 9.4
# accurate quota measurement). Returns the session's stored byte total
# (resources + html chunks — the established aggregate the quota is measured
# against), or the sentinel -1 when the session already holds
# ``max_resources_per_session`` resource rows whose url_hash differs from
# THIS upload's. Excluding this upload's own url_hash is what lets
# deduplicated re-uploads (which add no row) bypass the cap. Stored sizes
# are non-negative sums, so -1 is an unambiguous sentinel. The cap binds as
# NULL when disabled, making the count branch inert.
_SESSION_BUDGET_QUERY = (
    "SELECT CASE"
    " WHEN :cap IS NOT NULL AND (SELECT COUNT(*) FROM resources"
    "  WHERE session_id = :sid AND url_hash <> :url_hash) >= :cap"
    " THEN -1"
    " ELSE (SELECT COALESCE(SUM(size), 0) FROM resources WHERE session_id = :sid)"
    " + (SELECT COALESCE(SUM(size), 0) FROM html_chunks WHERE session_id = :sid)"
    " END"
)


def _resource_count_cap() -> int | None:
    """``max_resources_per_session`` as an int, or ``None`` (= no cap).

    A non-integer value degrades to "unlimited" instead of being bound as a
    query parameter, where it would make the driver reject every upload.
    """
    raw = settings.max_resources_per_session
    if isinstance(raw, int) and not isinstance(raw, bool):
        return raw
    return None


async def _discard_file(path: str) -> None:
    """Remove an upload file written during this request; idempotent.

    Safe to call on every failure path: no-ops when nothing was written
    (or the file was already discarded) and never masks the original error
    with a cleanup failure.
    """
    try:
        await asyncio.to_thread(os.remove, path)
    except FileNotFoundError:
        pass
    except OSError as exc:
        logger.warning("Failed to remove uploaded file %s: %s", path, exc)


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

    # Reject uploads for any status other than scraping and uploading.
    # D3 (3.1): this request-time pre-check is the ONLY status check in this
    # handler. The insert+commit path below deliberately never re-checks
    # session status — an upload that passed here must never be rejected
    # mid-flight with 409, even if finalize transitions the session
    # concurrently (see the accept-and-account contract below).
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

    # ---------------------------------------------------------------------------
    # Accept-and-account contract (server-assembly-honesty D2/D3, task 3.3)
    #
    # With commit-before-respond (D2) in place below, a 200 from this handler
    # implies a COMMITTED resource row AND its file on disk. Therefore:
    #   * Any upload that passed the request-time status pre-check above is
    #     always stored and accounted. The insert+commit path performs no
    #     further status check, so finalize's concurrent guarded transition
    #     can never reject it mid-flight with 409 — a resource the client
    #     counted as uploaded is never dropped on the floor.
    #   * finalize's guarded transition
    #     (UPDATE ... WHERE status = 'uploading', sessions.py) remains the
    #     single assembly trigger.
    #   * A resource that commits after the assembler's start-of-pipeline
    #     snapshot (zip_assembler.py) is a late arrival: the assembler counts
    #     the snapshot-vs-live delta into the session's integrity counts
    #     (assembly_missing / archive_warning). Late arrivals are therefore
    #     never orphan blobs (a 200 guarantees row + file) and never silent
    #     drops (always reflected in the integrity accounting).
    # ---------------------------------------------------------------------------

    # URL hash is needed before any I/O: the budget query excludes THIS
    # upload's url_hash from the count cap, so deduplicated re-uploads
    # (which add no row) bypass it (6.4).
    url_hash = hashlib.sha256(originalUrl.encode("utf-8")).hexdigest()

    # One round-trip, two pre-write gates — both evaluated BEFORE any file
    # write:
    #   * 6.4 — live per-session resource count cap: at
    #     max_resources_per_session a new (non-duplicate) upload is rejected
    #     with 413 resources_count_exceeded.
    #   * 9.4 — the remaining session-size budget, measured on the stored
    #     decoded-byte aggregate. This replaces the removed whole-multipart
    #     Content-Length pre-check, which measured envelope overhead
    #     (boundaries, form fields) and 413-ed legitimate uploads near the
    #     limit; the budget is enforced on actual bytes mid-stream below.
    count_cap = _resource_count_cap()
    budget_result = await db.execute(
        sa_text(_SESSION_BUDGET_QUERY),
        {"sid": session_id, "url_hash": url_hash, "cap": count_cap},
    )
    raw_budget = budget_result.scalar()
    if raw_budget == -1:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={
                "error": "resources_count_exceeded",
                "message": (
                    "Session already holds the maximum of "
                    f"{count_cap} resources"
                ),
                "max_resources": count_cap,
                "api_version": "v1",
            },
        )
    current_total = raw_budget or 0
    max_session_bytes = settings.max_session_size_mb * 1024 * 1024
    remaining_budget = max_session_bytes - current_total

    # Allocate storage path (no directories or files are created until the
    # gates above have passed).
    resource_id = str(uuid.uuid4())
    session_dir = os.path.join(settings.storage_root, session_id)
    resources_dir = os.path.join(session_dir, "resources")
    storage_path = os.path.join(resources_dir, resource_id)

    if x_content_gzipped:
        # Gzip path with bounded decompression (3.5): the inflated size is
        # capped BEFORE decompression at min(remaining session budget, hard
        # per-resource ceiling) so a gzip bomb cannot exhaust memory or the
        # session quota. Compressed input is streamed in chunks and capped at
        # the same bound (compressed data is never larger than its inflated
        # form for a payload within budget), so neither the input nor the
        # inflated buffer is allocated beyond the cap.
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
    else:
        # Non-gzip: a session with no remaining budget is rejected before any
        # I/O; otherwise the mid-stream loop below enforces the budget on
        # bytes actually written (9.4).
        if remaining_budget <= 0:
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

    # 9.1 — everything from file creation to the D2 commit is wrapped so
    # that ANY failure after the file is created (mid-stream quota abort,
    # non-IntegrityError flush errors, commit failures) removes the written
    # file — no leak paths. The cleanup handler is idempotent: the dedup
    # success paths discard the file explicitly before returning.
    try:
        os.makedirs(resources_dir, exist_ok=True)

        if x_content_gzipped:
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

            # 9.1 — async write of the decompressed blob.
            async with aiofiles.open(storage_path, "wb") as f:
                await f.write(content)

        else:
            # 9.1/9.4 — stream straight to disk in 256 KB chunks WITHOUT
            # buffering large binary assets (images, fonts) in RAM, and
            # enforce the remaining session budget MID-STREAM on bytes
            # actually written: exceeding it aborts the write (the partial
            # file is removed by the cleanup handler below) with 413. No
            # Content-Length header is consulted — it measures the whole
            # multipart envelope (boundaries, form fields), not the decoded
            # blob, and rejected legitimate uploads near the limit.
            written = 0
            async with aiofiles.open(storage_path, "wb") as f_out:
                while True:
                    chunk = await file.read(262144)  # 256 KB chunks
                    if not chunk:
                        break
                    if written + len(chunk) > remaining_budget:
                        raise HTTPException(
                            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            detail={
                                "error": "session_size_exceeded",
                                "message": f"Upload would exceed session size limit ({settings.max_session_size_mb}MB)",
                                "current_size": int(current_total + written),
                                "upload_size": written + len(chunk),
                                "max_size": max_session_bytes,
                                "api_version": "v1",
                            },
                        )
                    await f_out.write(chunk)
                    written += len(chunk)
            original_size = written

            # Authoritative post-write aggregate gate (9.4): the measured
            # baseline total plus the exact bytes written must fit the
            # quota. Mid-stream enforcement bounds the file to the measured
            # remaining budget, so this holds by construction — it remains
            # the documented final gate on the aggregate invariant.
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

        # Dedup check after the size gates (URL-hash based; shared by both
        # paths). A hit returns the EXISTING resource — no row is added,
        # which is why deduplicated re-uploads bypass the count cap above.
        dedup_stmt = select(Resource).where(
            Resource.session_id == session_id,
            Resource.url_hash == url_hash,
        )
        dedup_result = await db.execute(dedup_stmt)
        existing_resource = dedup_result.scalar_one_or_none()
        if existing_resource:
            await _discard_file(storage_path)
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
                await _discard_file(storage_path)
                return ResourceUploadResponse(
                    resource_id=existing_resource.id,
                    local_path=existing_resource.local_path,
                    size=existing_resource.size,
                    deduplicated=True,
                )
            raise

        # Round 9 counter fix: accumulate the stored size into the
        # sessions.total_size column, which after the deadlock fix was never
        # written anywhere (it stayed 0 even for sessions with hundreds of MB
        # of resources). Counted value = the RAW logical size (``original_size``):
        # for X-Content-Gzipped uploads that is the decompressed byte count, for
        # plain uploads the exact received byte count — in both cases the size of
        # the file actually stored, i.e. the same number Resource.size carries,
        # so this column and the /status live SUM(Resource.size) aggregate agree.
        # Deadlock-fix style: a single Core UPDATE with a server-side increment
        # (no ORM attribute write, no extra lock scope beyond this statement).
        # Dedup paths above return early, so duplicated bytes are never counted
        # twice.
        await db.execute(
            sa_update(Session)
            .where(Session.id == session_id)
            .values(total_size=Session.total_size + original_size)
        )

        # D2 — commit BEFORE the success response. get_db()'s teardown commit
        # runs after the response has been sent (FastAPI >= 0.106), so a
        # teardown-time failure (pool exhaustion, deadlock, MySQL restart)
        # would tell the client "200" while the row + total_size accounting
        # rolled back. On commit failure: roll back, let the cleanup handler
        # below remove the written file, and re-raise — the client gets a 5xx
        # and no orphan row/file survives. This is what makes the
        # accept-and-account contract above hold: 200 ⇒ committed row+file.
        try:
            await db.commit()
        except Exception:
            await db.rollback()
            raise
    except BaseException:
        # 9.1 — any failure after the file was created removes it. Idempotent:
        # no-ops when nothing was written yet or the failing path already
        # discarded the file.
        await _discard_file(storage_path)
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

    # D7 (6.3) — reject oversized maps BEFORE mutating the session: the
    # serialized JSON byte size and the entry count are both capped so an
    # unbounded request body cannot become a one-request memory spike or a
    # bloated JSON column. Checked on the incoming map, so a rejected
    # request leaves the stored session state untouched.
    map_bytes = len(json.dumps(body.map).encode("utf-8"))
    map_entries = len(body.map)
    if (
        map_bytes > settings.max_filename_map_bytes
        or map_entries > settings.max_filename_map_entries
    ):
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={
                "error": "filename_map_too_large",
                "message": "Filename map exceeds the maximum allowed size",
                "map_bytes": map_bytes,
                "max_bytes": settings.max_filename_map_bytes,
                "map_entries": map_entries,
                "max_entries": settings.max_filename_map_entries,
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

    # D2 (2.3) — commit BEFORE the success response. get_db()'s teardown
    # commit runs after the response has been sent (FastAPI >= 0.106), so a
    # teardown-time failure (pool exhaustion, deadlock, MySQL restart) would
    # tell the client "200" while the merged map silently rolled back — the
    # mappings_count in the response lied about what is persisted. On commit
    # failure: roll back, re-raise — the client gets a 5xx and no partial
    # mutation survives. Same discipline as upload_resource above.
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        raise

    logger.info(
        "Filename map updated: session=%s entries=%d",
        session_id,
        len(merged_map),
    )

    return FilenameMapResponse(
        mappings_count=len(merged_map),
    )
