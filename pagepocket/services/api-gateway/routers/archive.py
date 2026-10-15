"""Archive REST routes."""

import os
import re
import sys

import grpc
from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response as FastAPIResponse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "shared", "proto_generated"))

import archive_pb2
from grpc_clients import archive_stub
from serving import content_type_for_path, sandbox_headers
from validation import (
    PayloadTooLarge,
    content_length_exceeds,
    max_upload_bytes,
    read_bounded,
)

from routers import handle_grpc_error

router = APIRouter(prefix="/api/v1/archive", tags=["archive"])


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


@router.get("/pages")
async def list_pages(
    request: Request,
    page: int = 1,
    page_size: int = 20,
    sort_by: str = "archived_at",
    collection_id: str = "",
):
    try:
        resp = archive_stub().ListPages(archive_pb2.ListPagesRequest(
            user_id=request.state.user_id,
            page=page,
            page_size=page_size,
            sort_by=sort_by,
            collection_id=collection_id,
        ), timeout=30)
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
    except grpc.RpcError as e:
        handle_grpc_error(e)


@router.get("/pages/{page_id}/view")
async def view_page(request: Request, page_id: str):
    try:
        resp = archive_stub().GetPageContent(archive_pb2.GetPageContentRequest(
            page_id=page_id,
            user_id=request.state.user_id,
        ), timeout=30)
        return {"url": resp.signed_url, "expires_at": resp.expires_at}
    except grpc.RpcError as e:
        handle_grpc_error(e)


@router.delete("/pages/{page_id}")
async def delete_page(request: Request, page_id: str):
    try:
        resp = archive_stub().DeletePage(archive_pb2.DeletePageRequest(
            page_id=page_id,
            user_id=request.state.user_id,
        ), timeout=30)
        return {"success": resp.success}
    except grpc.RpcError as e:
        handle_grpc_error(e)


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
    # Bounded request buffering (task 4.4 / spec "Bounded request buffering"):
    # a cheap content-length pre-check rejects declared-oversized uploads
    # before anything is buffered, then every part is read through the bounded
    # reader so an undeclared oversized body still cannot fill RAM. Starlette's
    # UploadFile exposes an async read(size), which is the file-like
    # read_bounded consumes.
    max_bytes = max_upload_bytes()
    if content_length_exceeds(_content_length(request), max_bytes):
        raise _payload_too_large(max_bytes)

    try:
        html_bytes = await read_bounded(html_content, max_bytes)
        asset_protos = []
        for asset_file in assets:
            data = await read_bounded(asset_file, max_bytes)
            asset_protos.append(archive_pb2.Asset(
                filename=asset_file.filename or "",
                content_type=asset_file.content_type or "application/octet-stream",
                data=data,
            ))
    except PayloadTooLarge:
        raise _payload_too_large(max_bytes)

    try:
        # The plan is authoritative from the JWT claim (request.state.plan).
        # The client-supplied `plan` form field is accepted (backward compat
        # with older extension versions) and deliberately IGNORED — a client
        # can never escalate its own quota.
        resp = archive_stub().IngestPage(archive_pb2.IngestPageRequest(
            user_id=request.state.user_id,
            url=url,
            title=title,
            html_content=html_bytes,
            assets=asset_protos,
            extension_job_id=extension_job_id,
            plan=request.state.plan,
        ), timeout=120)  # ingest/push-class call: larger budget (D11)
        return {
            "success": resp.success,
            "page_id": resp.page_id,
            "message": resp.message,
            "api_version": "v1",
        }
    except grpc.RpcError as e:
        handle_grpc_error(e)


@router.get("/pages/{page_id}/f/{file_path:path}")
async def get_page_file(request: Request, page_id: str, file_path: str):
    """Authenticated endpoint - serve an archived file for a page."""
    try:
        file_resp = archive_stub().GetArchiveFile(archive_pb2.GetArchiveFileRequest(
            page_id=page_id,
            user_id=request.state.user_id,
            file_path=file_path,
        ), timeout=30)
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
            file_resp = archive_stub().GetArchiveFile(archive_pb2.GetArchiveFileRequest(
                page_id=page_id,
                user_id=request.state.user_id,
                file_path=f"assets/{file_path}",
            ), timeout=30)
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
