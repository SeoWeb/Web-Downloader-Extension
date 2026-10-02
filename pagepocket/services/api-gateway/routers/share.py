"""Share REST routes."""

import os
import re
import sys
from datetime import datetime, timezone

import grpc
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response as FastAPIResponse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "shared", "proto_generated"))

import archive_pb2
import share_pb2
from grpc_clients import archive_stub, share_stub

from routers import handle_grpc_error

router = APIRouter(prefix="/api/v1/share", tags=["share"])

CONTENT_TYPE_MAP = {
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


def _format_share_response(resp):
    expires_at = None
    if resp.expires_at:
        expires_at = datetime.fromtimestamp(resp.expires_at, tz=timezone.utc).isoformat()
    return {
        "token": resp.token,
        "short_url": resp.short_url,
        "is_public": resp.is_public,
        "expires_at": expires_at,
        "view_count": resp.view_count,
        "created_at": resp.created_at or datetime.now(timezone.utc).isoformat(),
    }


@router.post("")
async def create_share_link(request: Request, body: dict):
    try:
        resp = share_stub().CreateShareLink(share_pb2.CreateShareLinkRequest(
            user_id=request.state.user_id,
            page_id=body["page_id"],
            is_public=body.get("is_public", True),
            expires_at=body.get("expires_at", 0),
        ))
        return _format_share_response(resp)
    except grpc.RpcError as e:
        handle_grpc_error(e)


@router.get("")
async def get_share_link_by_page(request: Request, page_id: str):
    try:
        resp = share_stub().GetShareLinkByPage(share_pb2.GetShareLinkByPageRequest(
            user_id=request.state.user_id,
            page_id=page_id,
        ))
        return _format_share_response(resp)
    except grpc.RpcError as e:
        handle_grpc_error(e)


@router.delete("/{token}")
async def revoke_share_link(request: Request, token: str):
    try:
        resp = share_stub().RevokeShareLink(share_pb2.RevokeShareLinkRequest(
            token=token,
            user_id=request.state.user_id,
        ))
        return {"success": resp.success}
    except grpc.RpcError as e:
        handle_grpc_error(e)


@router.get("/public/{token}")
async def validate_share_link(token: str):
    """Public endpoint - no auth required."""
    try:
        resp = share_stub().ValidateToken(share_pb2.ValidateTokenRequest(token=token))
        if not resp.valid:
            raise HTTPException(status_code=404, detail={"detail": "Share link not found or expired", "api_version": "v1"})

        # Get presigned URL for the page
        content = archive_stub().GetPageContent(archive_pb2.GetPageContentRequest(
            page_id=resp.page_id,
            user_id="",  # Share tokens bypass user check
        ))
        expires_at = None
        if content.expires_at:
            expires_at = datetime.fromtimestamp(content.expires_at, tz=timezone.utc).isoformat()
        return {"url": content.signed_url, "expires_at": expires_at}
    except HTTPException:
        raise
    except grpc.RpcError as e:
        handle_grpc_error(e)


def _content_type_for_path(file_path: str) -> str:
    ext = file_path.rsplit(".", 1)[-1].lower() if "." in file_path else ""
    return CONTENT_TYPE_MAP.get(f".{ext}", "application/octet-stream")


@router.get("/public/{token}/f/{file_path:path}")
async def get_share_file(token: str, file_path: str):
    """Public endpoint - serve an archived file for a share token."""
    try:
        resp = share_stub().ValidateToken(share_pb2.ValidateTokenRequest(token=token))
        if not resp.valid:
            raise HTTPException(status_code=404, detail="Share link not found or expired")

        page_id = resp.page_id

        def _fetch(path):
            return archive_stub().GetArchiveFile(archive_pb2.GetArchiveFileRequest(
                page_id=page_id,
                user_id="",
                file_path=path,
            ))

        # Try direct path first
        try:
            file_resp = _fetch(file_path)
        except grpc.RpcError:
            # Backward compat: try with assets/ prefix for unrewritten paths
            if not file_path.startswith("assets/"):
                try:
                    file_resp = _fetch(f"assets/{file_path}")
                except grpc.RpcError:
                    raise HTTPException(status_code=404, detail="File not found")
            else:
                raise HTTPException(status_code=404, detail="File not found")

        content_type = file_resp.content_type
        if not content_type or content_type == "application/octet-stream":
            content_type = _content_type_for_path(file_path)

        # Use immutable caching for hashed filenames (long hex suffixes)
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
    except HTTPException:
        raise
    except grpc.RpcError as e:
        handle_grpc_error(e)
