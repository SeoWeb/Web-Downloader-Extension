"""Archive REST routes."""

from fastapi import APIRouter, Request
import grpc

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "shared", "proto_generated"))

import archive_pb2
from grpc_clients import archive_stub
from routers import handle_grpc_error

router = APIRouter(prefix="/api/v1/archive", tags=["archive"])


@router.get("/pages")
async def list_pages(
    request: Request,
    page: int = 1,
    page_size: int = 20,
    sort_by: str = "archived_at",
):
    try:
        resp = archive_stub().ListPages(archive_pb2.ListPagesRequest(
            user_id=request.state.user_id,
            page=page,
            page_size=page_size,
            sort_by=sort_by,
        ))
        return {
            "pages": [
                {
                    "id": p.id,
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
