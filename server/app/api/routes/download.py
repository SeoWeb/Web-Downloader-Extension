"""Download route: serve ZIP or single HTML file with range request support."""

import logging
import os

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import get_optional_client, require_session_owner
from app.db.database import get_db
from app.models.client import Client
from app.models.session import Session, SessionStatus

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/sessions", tags=["download"])

# Buffer size for streaming file reads
CHUNK_SIZE = 64 * 1024  # 64 KB


@router.get(
    "/{session_id}/download",
    summary="Download the assembled ZIP or HTML file",
)
async def download_session(
    session_id: str,
    request: Request,
    client: Client | None = Depends(get_optional_client),  # noqa: B008
    db: AsyncSession = Depends(get_db),  # noqa: B008
) -> Response:
    """Serve the completed ZIP file or single HTML file.

    Supports HTTP range requests for resumable downloads of ZIP files.
    Single HTML files do not support range requests (unnecessary per spec).

    Authentication is optional: the UUIDv4 session ID serves as a
    non-guessable download token (design D6). If an API key is
    provided, ownership is verified for defense-in-depth.
    """
    # Get and validate session
    stmt = select(Session).where(Session.id == session_id)
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()

    if session is None:
        raise HTTPException(
            status_code=404,
            detail={"error": "not_found", "message": f"Session {session_id} not found", "api_version": "v1"},
        )

    # If API key provided, verify ownership (defense-in-depth)
    if client is not None:
        require_session_owner(client, session.client_id)

    # Check session is ready
    if session.status != SessionStatus.READY:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "not_ready",
                "message": f"Session is in '{session.status.value}' status, not ready for download",
                "current_status": session.status.value,
                "api_version": "v1",
            },
        )

    # Check file exists
    if not session.zip_path or not os.path.exists(session.zip_path):
        raise HTTPException(
            status_code=500,
            detail={
                "error": "file_missing",
                "message": "Output file not found on disk",
                "api_version": "v1",
            },
        )

    file_size = os.path.getsize(session.zip_path)
    is_single_file = session.options and session.options.get("singleFile")

    # Determine content type and filename
    if is_single_file:
        content_type = "text/html; charset=utf-8"
        filename = _derive_filename(session.url, ".html")
    else:
        content_type = "application/zip"
        filename = _derive_filename(session.url, ".zip")

    # Range request support for ZIP files only
    range_header = request.headers.get("range")
    if range_header and not is_single_file:
        return _serve_range(
            session.zip_path, file_size, range_header, content_type, filename
        )

    # Full file response (streaming)
    def file_iterator():
        with open(session.zip_path, "rb") as f:
            while True:
                chunk = f.read(CHUNK_SIZE)
                if not chunk:
                    break
                yield chunk

    return StreamingResponse(
        file_iterator(),
        media_type=content_type,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(file_size),
            "Accept-Ranges": "bytes" if not is_single_file else "none",
        },
    )


def _serve_range(
    file_path: str,
    file_size: int,
    range_header: str,
    content_type: str,
    filename: str,
) -> Response:
    """Serve a byte range of the file (206 Partial Content)."""
    # Parse Range header (e.g., "bytes=0-1023")
    range_spec = range_header.replace("bytes=", "")
    parts = range_spec.split("-")

    try:
        start = int(parts[0]) if parts[0] else 0
        end = int(parts[1]) if parts[1] else file_size - 1
    except (ValueError, IndexError):
        return Response(
            status_code=416,
            headers={"Content-Range": f"bytes */{file_size}"},
        )

    # Clamp range
    if start >= file_size or start > end:
        return Response(
            status_code=416,
            headers={"Content-Range": f"bytes */{file_size}"},
        )
    end = min(end, file_size - 1)

    content_length = end - start + 1

    def range_iterator():
        with open(file_path, "rb") as f:
            f.seek(start)
            remaining = content_length
            while remaining > 0:
                chunk_size = min(CHUNK_SIZE, remaining)
                chunk = f.read(chunk_size)
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    return StreamingResponse(
        range_iterator(),
        status_code=206,
        media_type=content_type,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(content_length),
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
        },
    )


def _derive_filename(url: str, extension: str) -> str:
    """Derive a safe filename from URL with the given extension.

    Format: hostname + path + timestamp, max 200 chars.
    """
    from urllib.parse import urlparse
    import re
    import time

    parsed = urlparse(url)
    hostname = parsed.hostname or "download"
    path = parsed.path.strip("/").replace("/", "_")

    # Remove query and fragment
    base = f"{hostname}_{path}" if path else hostname

    # Sanitize: keep only alphanumeric, dash, underscore, dot
    base = re.sub(r"[^\w.\-]", "_", base)

    # Truncate to leave room for extension and timestamp
    max_base = 200 - len(extension) - 12  # 12 for timestamp suffix
    if len(base) > max_base:
        base = base[:max_base]

    # Add timestamp to avoid collisions
    timestamp = int(time.time())
    return f"{base}_{timestamp}{extension}"
