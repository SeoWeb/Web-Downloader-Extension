"""Auth REST routes."""

from fastapi import APIRouter
import grpc

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "shared", "proto_generated"))

import auth_pb2
from grpc_clients import auth_stub
from routers import handle_grpc_error

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


@router.post("/register")
async def register(body: dict):
    try:
        resp = auth_stub().Register(auth_pb2.RegisterRequest(
            email=body["email"],
            password=body["password"],
            name=body["name"],
        ))
        return {
            "access_token": resp.access_token,
            "refresh_token": resp.refresh_token,
            "expires_at": resp.expires_at,
            "user": {
                "id": resp.user.id,
                "email": resp.user.email,
                "name": resp.user.name,
                "plan": resp.user.plan,
                "is_verified": resp.user.is_verified,
                "created_at": resp.user.created_at,
            },
        }
    except grpc.RpcError as e:
        handle_grpc_error(e)


@router.post("/login")
async def login(body: dict):
    try:
        resp = auth_stub().Login(auth_pb2.LoginRequest(
            email=body["email"],
            password=body["password"],
        ))
        return {
            "access_token": resp.access_token,
            "refresh_token": resp.refresh_token,
            "expires_at": resp.expires_at,
            "user": {
                "id": resp.user.id,
                "email": resp.user.email,
                "name": resp.user.name,
                "plan": resp.user.plan,
                "is_verified": resp.user.is_verified,
                "created_at": resp.user.created_at,
            },
        }
    except grpc.RpcError as e:
        handle_grpc_error(e)


@router.post("/refresh")
async def refresh(body: dict):
    try:
        resp = auth_stub().Refresh(auth_pb2.RefreshRequest(
            refresh_token=body["refresh_token"],
        ))
        return {
            "access_token": resp.access_token,
            "refresh_token": resp.refresh_token,
            "expires_at": resp.expires_at,
        }
    except grpc.RpcError as e:
        handle_grpc_error(e)


@router.post("/logout")
async def logout(request):
    from fastapi import Request
    user_id = request.state.user_id
    auth_stub().Logout(auth_pb2.LogoutRequest(user_id=user_id))
    return {"success": True}
