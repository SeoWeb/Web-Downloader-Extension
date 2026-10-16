"""API Gateway entry point."""

import os
import sys

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse

# Make `python main.py` work from a repo checkout (pagepocket/shared next to
# services/) and keep working in the container, where PYTHONPATH already
# points at /app/shared. Idempotent: nonexistent entries are harmless.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared", "proto_generated"))

# Fail fast BEFORE importing middleware/routers: jwt_utils reads JWT_SECRET at
# import time, and a clean configuration error beats a KeyError traceback.
from config import (
    allowed_origins,
    check_trusted_proxy_drift,
    enforce_startup_config,
    gateway_workers,
)
from logging_config import configure_logging

enforce_startup_config()
configure_logging()

# D4: trusted-proxy drift alarm — derive the real default-route gateway and
# compare it with TRUSTED_PROXIES. Runs after configure_logging() so the
# drift line reaches the configured handlers; the check never raises (it
# warns and continues), and the verdict lands in module state for /health.
trusted_proxy_verdict = check_trusted_proxy_drift()

from middleware import AuthMiddleware
from middleware.rate_limit import RateLimitMiddleware, RedisRateLimiter
from routers import archive as archive_router
from routers import auth as auth_router
from routers import health as health_router
from routers import library as library_router
from routers import search as search_router
from routers import share as share_router

app = FastAPI(title="PagePocket API", version="v1")


@app.exception_handler(RequestValidationError)
async def malformed_body_handler(request, exc: RequestValidationError):
    """Malformed/missing JSON bodies → 400 (never 422-as-500, task 1.14)."""
    return JSONResponse(
        status_code=400,
        content={"detail": "Malformed or missing request body", "api_version": "v1"},
    )


# Middleware order (spec "Middleware Ordering (CORS Outermost)"): Starlette's
# add_middleware prepends, so the LAST-registered layer is the OUTERMOST.
# Registering CORS last puts it outside auth + rate limiting, so error
# responses produced by the inner layers — 401 authentication rejections and
# 429 rate-limit rejections — carry Access-Control-Allow-Origin. Auth stays
# outside rate limiting so the per-user bucket sees request.state.user_id.
limiter = RedisRateLimiter()
app.add_middleware(RateLimitMiddleware, limiter=limiter)  # innermost
app.add_middleware(AuthMiddleware)
app.add_middleware(
    CORSMiddleware,  # outermost (added last)
    allow_origins=allowed_origins(),
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router.router)
app.include_router(archive_router.router)
app.include_router(library_router.router)
app.include_router(search_router.router)
app.include_router(share_router.router)
app.include_router(health_router.build_health_router(limiter, trusted_proxy_verdict))


if __name__ == "__main__":
    import uvicorn

    workers = gateway_workers()
    if workers > 1:
        # Multi-worker mode requires an import string: uvicorn spawns worker
        # processes that each import the app themselves (D1; the Redis-backed
        # limiter makes >1 worker safe). The Dockerfile runs from WORKDIR
        # /app, so "main:app" resolves; a direct `python main.py` also works
        # because the script's directory is sys.path[0].
        uvicorn.run("main:app", host="0.0.0.0", port=8090, workers=workers)
    else:
        uvicorn.run(app, host="0.0.0.0", port=8090)
