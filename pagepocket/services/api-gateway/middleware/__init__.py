"""JWT authentication middleware for FastAPI."""

import json
import os
from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "shared"))

from jwt_utils import verify_access_token

PUBLIC_PATHS = {
    "/api/v1/auth/register",
    "/api/v1/auth/login",
    "/api/v1/auth/refresh",
    "/api/v1/health",
}


def _unauthorized():
    return JSONResponse(
        status_code=401,
        content={"detail": "Invalid token", "api_version": "v1"},
    )


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        # Allow public paths
        if path in PUBLIC_PATHS:
            return await call_next(request)

        # Allow public share validation
        if path.startswith("/api/v1/share/public/"):
            return await call_next(request)

        # Require Authorization header
        auth = request.headers.get("Authorization")
        if not auth or not auth.startswith("Bearer "):
            return _unauthorized()

        token = auth[7:]
        payload = verify_access_token(token)
        if payload is None:
            return _unauthorized()

        request.state.user_id = payload["sub"]
        request.state.email = payload.get("email", "")
        request.state.plan = payload.get("plan", "free")

        return await call_next(request)
