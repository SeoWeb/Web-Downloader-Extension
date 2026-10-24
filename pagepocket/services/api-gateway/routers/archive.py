"""Archive REST routes."""

import os
import re
import sys
import urllib.parse

import grpc
from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response as FastAPIResponse
from fastapi.responses import StreamingResponse
from starlette.concurrency import iterate_in_threadpool, run_in_threadpool

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "shared", "proto_generated"))

import archive_pb2
from asset_tokens import strip_asset_token_segment
from grpc_clients import archive_stub
from ingest_pool import run_ingest
from serving import content_type_for_path, sandbox_headers
from validation import (
    PayloadTooLarge,
    content_length_exceeds,
    max_ingest_assets,
    max_upload_bytes,
    read_bounded,
)

from routers import handle_grpc_error

router = APIRouter(prefix="/api/v1/archive", tags=["archive"])

# extension_job_id lands in a VARCHAR(36) column (unique per user); anything
# longer or outside the accepted charset must 400 here instead of 500ing
# downstream at flush time (D5).
MAX_EXTENSION_JOB_ID_LENGTH = 36
_EXTENSION_JOB_ID_RE = re.compile(r"[A-Za-z0-9._-]+")


def _content_length(request: Request) -> int | None:
    """Declared Content-Length, or None when absent/garbage."""
    raw = request.headers.get("content-length")
    if raw is None:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def _payload_too_large(max_bytes: int) -> HTTPException:
    return HTTPException(
        status_code=413,
        detail={
            "detail": f"Upload exceeds the {max_bytes} byte limit",
            "api_version": "v1",
        },
    )


def _validate_extension_job_id(extension_job_id: str) -> None:
    if not extension_job_id:
        return  # optional field
    if (
        len(extension_job_id) > MAX_EXTENSION_JOB_ID_LENGTH
        or not _EXTENSION_JOB_ID_RE.fullmatch(extension_job_id)
    ):
        raise HTTPException(
            status_code=400,
            detail={
                "detail": (
                    "extension_job_id must be at most "
                    f"{MAX_EXTENSION_JOB_ID_LENGTH} characters from [A-Za-z0-9._-]"
                ),
                "api_version": "v1",
            },
        )


@router.get("/pages")
async def list_pages(
    request: Request,
    page: int = 1,
    page_size: int = 20,
    sort_by: str = "archived_at",
    collection_id: str = "",
):
    try:
        resp = await run_in_threadpool(
            archive_stub().ListPages,
            archive_pb2.ListPagesRequest(
                user_id=request.state.user_id,
                page=page,
                page_size=page_size,
                sort_by=sort_by,
                collection_id=collection_id,
            ),
            timeout=30,
        )
    except grpc.RpcError as e:
        # D8: a collection-filtered listing that cannot be resolved arrives
        # as UNAVAILABLE and must surface as 503 + Retry-After — never a
        # bare 500 (NOT_FOUND/quota/etc. map through the shared handler too).
        handle_grpc_error(e)
    return {
        "pages": [
            {
                "id": p.id,
                "user_id": p.user_id,
                "url": p.url,
                "title": p.title,
                "preview_text": p.preview_text,
                "size_bytes": p.size_bytes,
                "archived_at": p.archived_at,
            }
            for p in resp.pages
        ],
        "total": resp.total,
        "page": page,
        "page_size": page_size,
    }


@router.get("/pages/{page_id}")
async def get_page(request: Request, page_id: str):
    """By-id metadata fetch (page-viewer spec): the viewer never scans a
    page-size-limited list. GetPage is ownership-enforced upstream and
    returns NOT_FOUND for cross-user ids — surfaced unchanged (no
    existence leak). Response items mirror list_pages' item shape."""
    try:
        resp = await run_in_threadpool(
            archive_stub().GetPage,
            archive_pb2.GetPageRequest(
                page_id=page_id,
                user_id=request.state.user_id,
            ),
            timeout=30,
        )
    except grpc.RpcError as e:
        handle_grpc_error(e)
    return {
        "id": resp.id,
        "user_id": resp.user_id,
        "url": resp.url,
        "title": resp.title,
        "preview_text": resp.preview_text,
        "size_bytes": resp.size_bytes,
        "archived_at": resp.archived_at,
    }


@router.get("/pages/{page_id}/view")
async def view_page(request: Request, page_id: str):
    try:
        resp = await run_in_threadpool(
            archive_stub().GetPageContent,
            archive_pb2.GetPageContentRequest(
                page_id=page_id,
                user_id=request.state.user_id,
            ),
            timeout=30,
        )
    except grpc.RpcError as e:
        # A nonexistent/cross-user page is NOT_FOUND upstream — surfaced as a
        # 404 (never an unhandled 500; integration regression 3.10/6.4).
        handle_grpc_error(e)
    # D4: presigned R2 URLs are removed from the REST contract — the response
    # must not carry any url/signed_url field; archived content is delivered
    # exclusively via the sandboxed /f/* proxy routes.
    return {"page_id": page_id, "expires_at": resp.expires_at or None}


@router.delete("/pages/{page_id}")
async def delete_page(request: Request, page_id: str):
    try:
        resp = await run_in_threadpool(
            archive_stub().DeletePage,
            archive_pb2.DeletePageRequest(
                page_id=page_id,
                user_id=request.state.user_id,
            ),
            timeout=30,
        )
    except grpc.RpcError as e:
        handle_grpc_error(e)
    return {"success": resp.success}


@router.get("/storage")
async def get_storage_usage(request: Request):
    """Storage-meter snapshot (storage-usage-display 2.1/D1): a read-only
    proxy of ArchiveService.GetStorageUsage carrying the JWT identity and
    plan (D3 — request.state.user_id / request.state.plan, set by the auth
    middleware). The gateway has no DB: usage never leaves archive-service.
    quota_reset_at maps "" (no quota row yet) to null for the web contract.
    """
    try:
        resp = await run_in_threadpool(
            archive_stub().GetStorageUsage,
            archive_pb2.GetStorageUsageRequest(
                user_id=request.state.user_id,
                plan=request.state.plan,
            ),
            timeout=30,
        )
    except grpc.RpcError as e:
        handle_grpc_error(e)
    return {
        "used_bytes": resp.total_bytes,
        "storage_limit_bytes": resp.storage_limit_bytes,
        "plan": resp.plan,
        "pages_this_month": resp.pages_this_month,
        "page_limit_monthly": resp.page_limit_monthly,
        "quota_reset_at": resp.quota_reset_at or None,
    }


@router.post("/pages/ingest")
async def ingest_page(
    request: Request,
    url: str = Form(...),
    title: str = Form(""),
    html_content: UploadFile = File(...),
    extension_job_id: str = Form(""),
    # Accepted for backward compat with older extension versions, but IGNORED:
    # the plan always comes from the JWT claim (request.state.plan below).
    plan: str = Form(""),
    assets: list[UploadFile] = File(default=[]),
):
    # Ingest parameter validation (D5): reject a malformed extension_job_id
    # before anything is read or forwarded upstream.
    _validate_extension_job_id(extension_job_id)

    # Bounded request buffering (task 4.4 + cumulative bound D2): a declared
    # Content-Length is REQUIRED (chunked bodies are rejected for ingest —
    # the cumulative bound cannot be enforced while streaming), a cheap
    # content-length pre-check rejects declared-oversized uploads before
    # anything is buffered, and every part is read through the bounded reader
    # so no body can fill RAM. The cumulative html + Σ assets counter shares
    # one cap across all parts: each read is bounded by what is left of it.
    max_bytes = max_upload_bytes()

    declared_length = _content_length(request)
    if declared_length is None:
        raise HTTPException(
            status_code=400,
            detail={"detail": "Content-Length header is required for ingest", "api_version": "v1"},
        )
    if content_length_exceeds(declared_length, max_bytes):
        raise _payload_too_large(max_bytes)

    max_assets = max_ingest_assets()
    if len(assets) > max_assets:
        raise HTTPException(
            status_code=413,
            detail={
                "detail": f"Too many asset parts (limit is {max_assets})",
                "api_version": "v1",
            },
        )

    try:
        html_bytes = await read_bounded(html_content, max_bytes)
        running_bytes = len(html_bytes)
        asset_protos = []
        for asset_file in assets:
            data = await read_bounded(asset_file, max_bytes - running_bytes)
            running_bytes += len(data)
            asset_protos.append(archive_pb2.Asset(
                filename=asset_file.filename or "",
                content_type=asset_file.content_type or "application/octet-stream",
                data=data,
            ))
    except PayloadTooLarge:
        raise _payload_too_large(max_bytes)

    # The plan is authoritative from the JWT claim (request.state.plan).
    # The client-supplied `plan` form field is accepted (backward compat
    # with older extension versions) and deliberately IGNORED — a client
    # can never escalate its own quota. The stub call runs on the dedicated
    # bounded ingest executor (D1): a 120 s push must never occupy the
    # shared AnyIO worker pool other routes depend on.
    try:
        resp = await run_ingest(archive_stub().IngestPage, archive_pb2.IngestPageRequest(
            user_id=request.state.user_id,
            url=url,
            title=title,
            html_content=html_bytes,
            assets=asset_protos,
            extension_job_id=extension_job_id,
            plan=request.state.plan,
        ), timeout=120)  # ingest/push-class call: larger budget (D11)
    except grpc.RpcError as e:
        handle_grpc_error(e)
    return {
        "success": resp.success,
        "page_id": resp.page_id,
        "message": resp.message,
        "api_version": "v1",
    }


@router.get("/pages/{page_id}/f/{file_path:path}")
async def get_page_file(request: Request, page_id: str, file_path: str):
    """Authenticated endpoint - serve an archived file for a page."""
    # Fix E: asset-token-authenticated requests carry the credential INSIDE
    # file_path (`at/{token}/{real-path}`) — strip that leading segment so
    # BOTH the primary fetch and the assets/ fallback retry below see the
    # real archived path. Purely shape-based and a no-op for every other
    # path (plain-Bearer requests without the segment pass through intact).
    file_path = strip_asset_token_segment(file_path)
    try:
        file_resp = await run_in_threadpool(
            archive_stub().GetArchiveFile,
            archive_pb2.GetArchiveFileRequest(
                page_id=page_id,
                user_id=request.state.user_id,
                file_path=file_path,
            ),
            timeout=30,
        )
    except grpc.RpcError as e:
        # Backward compat: a missing file may be stored under assets/. Only a
        # genuine NOT_FOUND falls back — every other failure class (deadline,
        # quota, size, rate, auth) is translated by the shared gRPC→HTTP
        # handler instead of being masked as a 404.
        if e.code() != grpc.StatusCode.NOT_FOUND:
            handle_grpc_error(e)
        if file_path.startswith("assets/"):
            handle_grpc_error(e)
        try:
            file_resp = await run_in_threadpool(
                archive_stub().GetArchiveFile,
                archive_pb2.GetArchiveFileRequest(
                    page_id=page_id,
                    user_id=request.state.user_id,
                    file_path=f"assets/{file_path}",
                ),
                timeout=30,
            )
        except grpc.RpcError as e2:
            handle_grpc_error(e2)

    content_type = file_resp.content_type
    if not content_type or content_type == "application/octet-stream":
        content_type = content_type_for_path(file_path)

    cache_control = "public, max-age=3600"
    if re.search(r"_[a-f0-9]{8,}", file_path):
        cache_control = "public, max-age=31536000, immutable"

    # Sandboxed serving headers (task 7.1 / spec "archived-html-serving"):
    # CSP sandbox (no allow-same-origin), nosniff, pinned Content-Type, and
    # Referrer-Policy on HTML. The explicit Content-Type header wins over
    # media_type, so the client never sees a sniffed type.
    return FastAPIResponse(
        content=file_resp.data,
        media_type=content_type,
        headers={
            "Cache-Control": cache_control,
            **sandbox_headers(content_type),
        },
    )


# ---------------------------------------------------------------------------
# Page ZIP export (add-page-export-zip 3.1/D4): authenticated streaming
# download of one archived page.
# ---------------------------------------------------------------------------

# Whole-download budget for the ExportPage stream (the service spools + reads
# R2 before the first chunk; ingest/push-class calls use 120 s for comparison).
_EXPORT_TIMEOUT_SECONDS = 300

# Content-Disposition hygiene (D4): control characters, quotes, and path
# separators never belong in a filename; whitespace collapses; leading/trailing
# dots are trimmed (hidden files, '..', trailing-dot tricks).
_ZIP_FILENAME_STRIP_RE = re.compile(r'[\x00-\x1f\x7f"\\/]')


def _sanitize_filename_base(text: str) -> str:
    """Filename-safe base name: sanitized, whitespace-collapsed, trimmed."""
    cleaned = _ZIP_FILENAME_STRIP_RE.sub(" ", text or "")
    cleaned = " ".join(cleaned.split())  # collapse every whitespace run
    return cleaned.strip(" .")


def _zip_content_disposition(title: str, page_id: str) -> str:
    """`attachment` header value with a sanitized ZIP name derived from the
    page title (D4).

    Unicode word characters survive sanitization and travel in an RFC 5987
    `filename*=UTF-8''` parameter (plain `filename=` always carries ASCII, as
    required by the header encoding). An unusable title falls back to
    `page-{page_id}.zip`.
    """
    base = _sanitize_filename_base(title)
    if not base:
        base = f"page-{_sanitize_filename_base(page_id)}"
    filename = f"{base}.zip"
    if filename.isascii():
        return f'attachment; filename="{filename}"'
    ascii_base = _sanitize_filename_base(
        "".join(ch for ch in page_id if ch.isascii())
    )
    encoded = urllib.parse.quote(filename, safe="")
    return (
        f'attachment; filename="page-{ascii_base}.zip"; '
        f"filename*=UTF-8''{encoded}"
    )


@router.get("/pages/{page_id}/zip")
async def export_page_zip(request: Request, page_id: str):
    """Authenticated streaming ZIP download of one archived page (D4).

    GetPage enforces ownership upstream — unknown/foreign ids arrive as
    NOT_FOUND and surface as 404 with no existence leak — and yields the
    title for Content-Disposition. The ExportPage stream is then piped
    through chunk-by-chunk: the archive is never fully buffered in the
    gateway (gRPC transport discipline + bounded-memory response path).
    """
    try:
        page = await run_in_threadpool(
            archive_stub().GetPage,
            archive_pb2.GetPageRequest(
                page_id=page_id,
                user_id=request.state.user_id,
            ),
            timeout=30,
        )
    except grpc.RpcError as e:
        handle_grpc_error(e)

    try:
        call = await run_in_threadpool(
            archive_stub().ExportPage,
            archive_pb2.ExportPageRequest(
                page_id=page_id,
                user_id=request.state.user_id,
            ),
            timeout=_EXPORT_TIMEOUT_SECONDS,
        )
        # Pull the FIRST chunk here (on a worker thread), before any response
        # is sent: every upstream failure (R2 outage → UNAVAILABLE, missing
        # page → NOT_FOUND, deadline → DEADLINE_EXCEEDED) then maps through
        # the shared handler to a real HTTP status — never a partial 200
        # (spec "Error mapping"). Remaining chunks stream via
        # iterate_in_threadpool, so the gateway never buffers the archive.
        first_chunk = await run_in_threadpool(next, call, None)
    except grpc.RpcError as e:
        handle_grpc_error(e)

    async def _stream():
        if first_chunk is not None:
            yield first_chunk.data
        async for chunk in iterate_in_threadpool(call):
            yield chunk.data

    return StreamingResponse(
        _stream(),
        media_type="application/zip",
        headers={
            "Content-Disposition": _zip_content_disposition(page.title, page_id),
        },
    )
