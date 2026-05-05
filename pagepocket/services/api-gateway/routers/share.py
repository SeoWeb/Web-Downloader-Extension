"""Share REST routes."""

from fastapi import APIRouter, Request, HTTPException
import grpc

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "shared", "proto_generated"))

import share_pb2
import archive_pb2
from grpc_clients import share_stub, archive_stub
from routers import handle_grpc_error

router = APIRouter(prefix="/api/v1/share", tags=["share"])


@router.post("")
async def create_share_link(request: Request, body: dict):
    try:
        resp = share_stub().CreateShareLink(share_pb2.CreateShareLinkRequest(
            user_id=request.state.user_id,
            page_id=body["page_id"],
            is_public=body.get("is_public", True),
            expires_at=body.get("expires_at", 0),
        ))
        return {
            "token": resp.token,
            "short_url": resp.short_url,
            "is_public": resp.is_public,
            "expires_at": resp.expires_at,
            "view_count": resp.view_count,
        }
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
        return {"url": content.signed_url, "expires_at": content.expires_at}
    except HTTPException:
        raise
    except grpc.RpcError as e:
        handle_grpc_error(e)
