"""Share REST routes."""

import os
import re
import sys
from datetime import UTC, datetime

import grpc
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response as FastAPIResponse
from starlette.concurrency import run_in_threadpool

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "shared", "proto_generated"))

import archive_pb2
import share_pb2
from grpc_clients import archive_stub, share_stub
from serving import content_type_for_path, sandbox_headers

from routers import handle_grpc_error, require_field

router = APIRouter(prefix="/api/v1/share", tags=["share"])


def _format_share_response(resp):
    expires_at = None
    if resp.expires_at:
        expires_at = datetime.fromtimestamp(resp.expires_at, tz=UTC).isoformat()
    return {
        "token": resp.token,
        "short_url": resp.short_url,
        "is_public": resp.is_public,
        "expires_at": expires_at,
        "view_count": resp.view_count,
        "created_at": resp.created_at or datetime.now(UTC).isoformat(),
    }


@router.post("")
async def create_share_link(request: Request, body: dict):
    # Mandatory page-ownership check (D3): resolve the page via the archive
    # service with the caller's user_id BEFORE creating a link. A page that
    # does not exist or belongs to another user yields NOT_FOUND, which is
    # surfaced unchanged (no existence leak).
    page_id = require_field(body, "page_id")
    try:
        await run_in_threadpool(
            archive_stub().GetPage,
            archive_pb2.GetPageRequest(
                page_id=page_id,
                user_id=request.state.user_id,
            ),
            timeout=30,
        )
    except grpc.RpcError as e:
        handle_grpc_error(e)

    is_public = body.get("is_public", True)
    expires_at = body.get("expires_at", 0)
    try:
        resp = await run_in_threadpool(
            share_stub().CreateShareLink,
            share_pb2.CreateShareLinkRequest(
                user_id=request.state.user_id,
                page_id=page_id,
                is_public=is_public,
                expires_at=expires_at,
            ),
            timeout=30,
        )
        return _format_share_response(resp)
    except grpc.RpcError as e:
        handle_grpc_error(e)


@router.get("")
async def get_share_link_by_page(request: Request, page_id: str):
    try:
        resp = await run_in_threadpool(
            share_stub().GetShareLinkByPage,
            share_pb2.GetShareLinkByPageRequest(
                user_id=request.state.user_id,
                page_id=page_id,
            ),
            timeout=30,
        )
        return _format_share_response(resp)
    except grpc.RpcError as e:
        handle_grpc_error(e)


@router.delete("/{token}")
async def revoke_share_link(request: Request, token: str):
    try:
        resp = await run_in_threadpool(
            share_stub().RevokeShareLink,
            share_pb2.RevokeShareLinkRequest(
                token=token,
                user_id=request.state.user_id,
            ),
            timeout=30,
        )
        return {"success": resp.success}
    except grpc.RpcError as e:
        handle_grpc_error(e)


async def _page_content_formats(page_id: str, owner_user_id: str) -> list[str]:
    """Stored content formats for a shared page (text-native-downloads,
    share-viewer parity): resolved via the same archive page-read the
    authenticated get-page route uses — with the OWNER's identity, since
    this route is public (no caller JWT). Strictly best-effort: any archive
    failure degrades to [] and never fails the validation response."""
    try:
        page = await run_in_threadpool(
            archive_stub().GetPage,
            archive_pb2.GetPageRequest(
                page_id=page_id,
                user_id=owner_user_id,
            ),
            timeout=30,
        )
        return list(page.content_formats)
    except grpc.RpcError:
        return []


@router.get("/public/{token}")
async def validate_share_link(token: str):
    """Public endpoint - no auth required."""
    try:
        resp = await run_in_threadpool(
            share_stub().ValidateToken,
            share_pb2.ValidateTokenRequest(token=token),
            timeout=30,
        )
        if not resp.valid:
            raise HTTPException(status_code=404, detail={"detail": "Share link not found or expired", "api_version": "v1"})

        # D4: page reference metadata only — the presigned `url` field is
        # removed from the contract (no GetPageContent round trip, no R2
        # presigning); delivery is via the sandboxed public /f/* proxy routes.
        return {
            "page_id": resp.page_id,
            # Text-native downloads (share-viewer parity): the stored formats
            # drive the public viewer's HTML/Markdown/Text switcher. An archive
            # hiccup degrades to [] (legacy HTML-only iframe), never an error.
            "content_formats": await _page_content_formats(resp.page_id, resp.owner_user_id),
        }
    except HTTPException:
        raise
    except grpc.RpcError as e:
        handle_grpc_error(e)


@router.get("/public/{token}/images")
async def get_share_images(token: str):
    """Public endpoint - image listing for the shared page's lightbox
    (gallery-lightbox 2.2).

    Mirrors the public file route's trust model: ValidateToken resolves the
    page and its OWNER, and the owner's user_id scopes the upstream
    ListPageImages call (share access never bypasses ownership scoping —
    the token itself is the only credential here). Same JSON shape as the
    authenticated /pages/{page_id}/images route.
    """
    try:
        resp = await run_in_threadpool(
            share_stub().ValidateToken,
            share_pb2.ValidateTokenRequest(token=token),
            timeout=30,
        )
        if not resp.valid:
            raise HTTPException(status_code=404, detail="Share link not found or expired")

        images = await run_in_threadpool(
            archive_stub().ListPageImages,
            archive_pb2.ListPageImagesRequest(
                page_id=resp.page_id,
                user_id=resp.owner_user_id,
            ),
            timeout=30,
        )
        return {
            "images": [
                {
                    "path": image.path,
                    "content_type": image.content_type,
                    "size_bytes": image.size_bytes,
                }
                for image in images.images
            ],
            "is_image_gallery": images.is_image_gallery,
            "total": len(images.images),
        }
    except HTTPException:
        raise
    except grpc.RpcError as e:
        handle_grpc_error(e)


@router.get("/public/{token}/f/{file_path:path}")
async def get_share_file(token: str, file_path: str):
    """Public endpoint - serve an archived file for a share token."""
    try:
        resp = await run_in_threadpool(
            share_stub().ValidateToken,
            share_pb2.ValidateTokenRequest(token=token),
            timeout=30,
        )
        if not resp.valid:
            raise HTTPException(status_code=404, detail="Share link not found or expired")

        page_id = resp.page_id
        owner_user_id = resp.owner_user_id

        async def _fetch(path):
            return await run_in_threadpool(
                archive_stub().GetArchiveFile,
                archive_pb2.GetArchiveFileRequest(
                    page_id=page_id,
                    user_id=owner_user_id,
                    file_path=path,
                ),
                timeout=30,
            )

        # Try direct path first
        try:
            file_resp = await _fetch(file_path)
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
                file_resp = await _fetch(f"assets/{file_path}")
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
