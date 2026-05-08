"""Library REST routes."""

from fastapi import APIRouter, Request
import grpc

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "shared", "proto_generated"))

import library_pb2
from grpc_clients import library_stub
from routers import handle_grpc_error

router = APIRouter(prefix="/api/v1/library", tags=["library"])


@router.post("/collections")
async def create_collection(request: Request, body: dict):
    try:
        resp = library_stub().CreateCollection(library_pb2.CreateCollectionRequest(
            user_id=request.state.user_id,
            name=body["name"],
            description=body.get("description", ""),
            parent_id=body.get("parent_id", ""),
            color=body.get("color", ""),
        ))
        return _coll_to_dict(resp)
    except grpc.RpcError as e:
        handle_grpc_error(e)


@router.get("/collections")
async def list_collections(request: Request, parent_id: str = ""):
    try:
        resp = library_stub().ListCollections(library_pb2.ListCollectionsRequest(
            user_id=request.state.user_id,
            parent_id=parent_id,
        ))
        return {"collections": [_coll_to_dict(c) for c in resp.collections]}
    except grpc.RpcError as e:
        handle_grpc_error(e)


@router.get("/collections/{collection_id}")
async def get_collection(request: Request, collection_id: str):
    try:
        resp = library_stub().GetCollection(library_pb2.GetCollectionRequest(
            collection_id=collection_id,
            user_id=request.state.user_id,
        ))
        return _coll_to_dict(resp)
    except grpc.RpcError as e:
        handle_grpc_error(e)


@router.patch("/collections/{collection_id}")
async def update_collection(request: Request, collection_id: str, body: dict):
    try:
        resp = library_stub().UpdateCollection(library_pb2.UpdateCollectionRequest(
            collection_id=collection_id,
            user_id=request.state.user_id,
            name=body.get("name", ""),
            description=body.get("description", ""),
            color=body.get("color", ""),
        ))
        return _coll_to_dict(resp)
    except grpc.RpcError as e:
        handle_grpc_error(e)


@router.delete("/collections/{collection_id}")
async def delete_collection(request: Request, collection_id: str):
    try:
        resp = library_stub().DeleteCollection(library_pb2.DeleteCollectionRequest(
            collection_id=collection_id,
            user_id=request.state.user_id,
        ))
        return {"success": resp.success}
    except grpc.RpcError as e:
        handle_grpc_error(e)


@router.post("/collections/{collection_id}/pages/{page_id}")
async def add_page_to_collection(request: Request, collection_id: str, page_id: str):
    try:
        resp = library_stub().AddPageToCollection(library_pb2.PageCollectionRequest(
            user_id=request.state.user_id,
            page_id=page_id,
            collection_id=collection_id,
        ))
        return {"success": resp.success}
    except grpc.RpcError as e:
        handle_grpc_error(e)


@router.delete("/collections/{collection_id}/pages/{page_id}")
async def remove_page_from_collection(request: Request, collection_id: str, page_id: str):
    try:
        resp = library_stub().RemovePageFromCollection(library_pb2.PageCollectionRequest(
            user_id=request.state.user_id,
            page_id=page_id,
            collection_id=collection_id,
        ))
        return {"success": resp.success}
    except grpc.RpcError as e:
        handle_grpc_error(e)


def _coll_to_dict(c):
    return {
        "id": c.id,
        "user_id": c.user_id,
        "name": c.name,
        "description": c.description,
        "parent_id": c.parent_id or None,
        "color": c.color,
        "page_count": c.page_count,
        "created_at": c.created_at,
        "updated_at": c.updated_at,
    }
