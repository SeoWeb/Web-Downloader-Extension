"""Auth REST routes."""

import os
import sys

import grpc
from fastapi import APIRouter, Request
from starlette.concurrency import run_in_threadpool

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "shared", "proto_generated"))

import auth_pb2
from grpc_clients import auth_stub

from routers import handle_grpc_error, require_field

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


@router.post("/register")
async def register(body: dict):
    email = require_field(body, "email")
    password = require_field(body, "password")
    name = require_field(body, "name")
    try:
        resp = await run_in_threadpool(
            auth_stub().Register,
            auth_pb2.RegisterRequest(
                email=email,
                password=password,
                name=name,
            ),
            timeout=30,
        )
    except grpc.RpcError as e:
        handle_grpc_error(e)
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


@router.post("/login")
async def login(body: dict):
    email = require_field(body, "email")
    password = require_field(body, "password")
    try:
        resp = await run_in_threadpool(
            auth_stub().Login,
            auth_pb2.LoginRequest(
                email=email,
                password=password,
            ),
            timeout=30,
        )
    except grpc.RpcError as e:
        handle_grpc_error(e)
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


@router.post("/refresh")
async def refresh(body: dict):
    refresh_token = require_field(body, "refresh_token")
    try:
        resp = await run_in_threadpool(
            auth_stub().Refresh,
            auth_pb2.RefreshRequest(
                refresh_token=refresh_token,
            ),
            timeout=30,
        )
    except grpc.RpcError as e:
        handle_grpc_error(e)
    return {
        "access_token": resp.access_token,
        "refresh_token": resp.refresh_token,
        "expires_at": resp.expires_at,
    }


@router.post("/logout")
async def logout(request: Request):
    # Typed Request parameter (task 1.13): an untyped `request` was bound as a
    # required query param → the endpoint 422ed and AuthService.Logout (the
    # server-side refresh-token revocation) never ran.
    user_id = request.state.user_id
    try:
        await run_in_threadpool(
            auth_stub().Logout,
            auth_pb2.LogoutRequest(user_id=user_id),
            timeout=30,
        )
    except grpc.RpcError as e:
        handle_grpc_error(e)
    return {"success": True}
