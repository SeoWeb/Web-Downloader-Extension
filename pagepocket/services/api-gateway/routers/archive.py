"""Archive REST routes."""

import re

from fastapi import APIRouter, Form, Request, UploadFile, File
from fastapi.responses import Response as FastAPIResponse
import grpc

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "shared", "proto_generated"))

import archive_pb2
from grpc_clients import archive_stub
from routers import handle_grpc_error

router = APIRouter(prefix="/api/v1/archive", tags=["archive"])

_CONTENT_TYPE_MAP = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript",
    ".json": "application/json",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wasm": "application/wasm",
}


def _content_type_for_path(file_path: str) -> str:
    ext = file_path.rsplit(".", 1)[-1].lower() if "." in file_path else ""
    return _CONTENT_TYPE_MAP.get(f".{ext}", "application/octet-stream")


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
        ))
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
        ))
        return {"url": resp.signed_url, "expires_at": resp.expires_at}
    except grpc.RpcError as e:
        handle_grpc_error(e)


@router.delete("/pages/{page_id}")
async def delete_page(request: Request, page_id: str):
    try:
        resp = archive_stub().DeletePage(archive_pb2.DeletePageRequest(
            page_id=page_id,
            user_id=request.state.user_id,
        ))
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
    plan: str = Form(""),
    assets: list[UploadFile] = File(default=[]),
):
    html_bytes = await html_content.read()
    asset_protos = []
    for asset_file in assets:
        data = await asset_file.read()
        asset_protos.append(archive_pb2.Asset(
            filename=asset_file.filename or "",
            content_type=asset_file.content_type or "application/octet-stream",
            data=data,
        ))

    try:
        resp = archive_stub().IngestPage(archive_pb2.IngestPageRequest(
            user_id=request.state.user_id,
            url=url,
            title=title,
            html_content=html_bytes,
            assets=asset_protos,
            extension_job_id=extension_job_id,
            plan=plan or request.state.plan,
        ))
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
        ))
    except grpc.RpcError:
        # Try with assets/ prefix for backward compat
        if not file_path.startswith("assets/"):
            try:
                file_resp = archive_stub().GetArchiveFile(archive_pb2.GetArchiveFileRequest(
                    page_id=page_id,
                    user_id=request.state.user_id,
                    file_path=f"assets/{file_path}",
                ))
            except grpc.RpcError:
                return FastAPIResponse(status_code=404, content="File not found")
        else:
            return FastAPIResponse(status_code=404, content="File not found")

    content_type = file_resp.content_type
    if not content_type or content_type == "application/octet-stream":
        content_type = _content_type_for_path(file_path)

    cache_control = "public, max-age=3600"
    if re.search(r"_[a-f0-9]{8,}", file_path):
        cache_control = "public, max-age=31536000, immutable"

    return FastAPIResponse(
        content=file_resp.data,
        media_type=content_type,
        headers={
            "Cache-Control": cache_control,
            "X-Content-Type-Options": "nosniff",
        },
    )
