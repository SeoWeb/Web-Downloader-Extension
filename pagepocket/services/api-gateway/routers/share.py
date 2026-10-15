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
from serving import content_type_for_path, sandbox_headers

from routers import handle_grpc_error

router = APIRouter(prefix="/api/v1/share", tags=["share"])


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
    # Mandatory page-ownership check (D3): resolve the page via the archive
    # service with the caller's user_id BEFORE creating a link. A page that
    # does not exist or belongs to another user yields NOT_FOUND, which is
    # surfaced unchanged (no existence leak).
    try:
        archive_stub().GetPage(archive_pb2.GetPageRequest(
            page_id=body["page_id"],
            user_id=request.state.user_id,
        ), timeout=30)
    except grpc.RpcError as e:
        handle_grpc_error(e)

    try:
        resp = share_stub().CreateShareLink(share_pb2.CreateShareLinkRequest(
            user_id=request.state.user_id,
            page_id=body["page_id"],
            is_public=body.get("is_public", True),
            expires_at=body.get("expires_at", 0),
        ), timeout=30)
        return _format_share_response(resp)
    except grpc.RpcError as e:
        handle_grpc_error(e)


@router.get("")
async def get_share_link_by_page(request: Request, page_id: str):
    try:
        resp = share_stub().GetShareLinkByPage(share_pb2.GetShareLinkByPageRequest(
            user_id=request.state.user_id,
            page_id=page_id,
        ), timeout=30)
        return _format_share_response(resp)
    except grpc.RpcError as e:
        handle_grpc_error(e)


@router.delete("/{token}")
async def revoke_share_link(request: Request, token: str):
    try:
        resp = share_stub().RevokeShareLink(share_pb2.RevokeShareLinkRequest(
            token=token,
            user_id=request.state.user_id,
        ), timeout=30)
        return {"success": resp.success}
    except grpc.RpcError as e:
        handle_grpc_error(e)


@router.get("/public/{token}")
async def validate_share_link(token: str):
    """Public endpoint - no auth required."""
    try:
        resp = share_stub().ValidateToken(share_pb2.ValidateTokenRequest(token=token), timeout=30)
        if not resp.valid:
            raise HTTPException(status_code=404, detail={"detail": "Share link not found or expired", "api_version": "v1"})

        # Get presigned URL for the page. The owner resolved at token
        # validation is passed as user_id — ownership checks are mandatory
        # downstream; an empty user_id is no longer a wildcard (D3).
        content = archive_stub().GetPageContent(archive_pb2.GetPageContentRequest(
            page_id=resp.page_id,
            user_id=resp.owner_user_id,
        ), timeout=30)
        expires_at = None
        if content.expires_at:
            expires_at = datetime.fromtimestamp(content.expires_at, tz=timezone.utc).isoformat()
        return {"url": content.signed_url, "expires_at": expires_at}
    except HTTPException:
        raise
    except grpc.RpcError as e:
        handle_grpc_error(e)


@router.get("/public/{token}/f/{file_path:path}")
async def get_share_file(token: str, file_path: str):
    """Public endpoint - serve an archived file for a share token."""
    try:
        resp = share_stub().ValidateToken(share_pb2.ValidateTokenRequest(token=token), timeout=30)
        if not resp.valid:
            raise HTTPException(status_code=404, detail="Share link not found or expired")

        page_id = resp.page_id
        owner_user_id = resp.owner_user_id

        def _fetch(path):
            return archive_stub().GetArchiveFile(archive_pb2.GetArchiveFileRequest(
                page_id=page_id,
                user_id=owner_user_id,
                file_path=path,
            ), timeout=30)

        # Try direct path first
        try:
            file_resp = _fetch(file_path)
        except grpc.RpcError as e:
            # Backward compat: only a genuine NOT_FOUND retries with the
            # assets/ prefix — every other failure class (deadline, quota,
            # size, rate) goes through the shared gRPC→HTTP handler instead
            # of being masked as a 404.
            if e.code() != grpc.StatusCode.NOT_FOUND:
                handle_grpc_error(e)
            if file_path.startswith("assets/"):
                handle_grpc_error(e)
            try:
                file_resp = _fetch(f"assets/{file_path}")
            except grpc.RpcError as e2:
                handle_grpc_error(e2)

        content_type = file_resp.content_type
        if not content_type or content_type == "application/octet-stream":
            content_type = content_type_for_path(file_path)

        # Use immutable caching for hashed filenames (long hex suffixes)
        cache_control = "public, max-age=3600"
        if re.search(r"_[a-f0-9]{8,}", file_path):
            cache_control = "public, max-age=31536000, immutable"

        # Sandboxed serving headers (task 7.1 / spec "archived-html-serving"):
        # identical set to the archive file route — CSP sandbox without
        # allow-same-origin, nosniff, pinned Content-Type, and
        # Referrer-Policy on HTML.
        return FastAPIResponse(
            content=file_resp.data,
            media_type=content_type,
            headers={
                "Cache-Control": cache_control,
                **sandbox_headers(content_type),
            },
        )
    except HTTPException:
        raise
    except grpc.RpcError as e:
        handle_grpc_error(e)
