"""Search REST routes."""

import os
import sys

import grpc
from fastapi import APIRouter, Request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "shared", "proto_generated"))

import search_pb2
from grpc_clients import search_stub

from routers import handle_grpc_error

router = APIRouter(prefix="/api/v1", tags=["search"])


@router.get("/search")
async def search(
    request: Request,
    q: str = "",
    page: int = 1,
    page_size: int = 20,
    collection_id: str = "",
):
    try:
        resp = search_stub().Search(search_pb2.SearchRequest(
            user_id=request.state.user_id,
            query=q,
            page=page,
            page_size=page_size,
            collection_id=collection_id,
        ))
        return {
            "results": [
                {
                    "page_id": r.page_id,
                    "url": r.url,
                    "title": r.title,
                    "snippet": r.snippet,
                    "score": r.score,
                    "archived_at": r.archived_at,
                }
                for r in resp.results
            ],
            "total": resp.total,
        }
    except grpc.RpcError as e:
        handle_grpc_error(e)
