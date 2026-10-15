"""API Gateway entry point."""

import os
import sys

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "shared"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "shared", "proto_generated"))

# Fail fast BEFORE importing middleware/routers: jwt_utils reads JWT_SECRET at
# import time, and a clean configuration error beats a KeyError traceback.
from config import allowed_origins, enforce_startup_config

enforce_startup_config()

from middleware import AuthMiddleware
from middleware.rate_limit import RateLimitMiddleware, RedisRateLimiter
from routers import archive as archive_router
from routers import auth as auth_router
from routers import health as health_router
from routers import library as library_router
from routers import search as search_router
from routers import share as share_router

app = FastAPI(title="PagePocket API", version="v1")

# CORS is pinned to an explicit allow-list (never "*"). Published
# chrome-extension:// origins can be appended via CORS_ALLOW_ORIGINS.
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins(),
    allow_methods=["*"],
    allow_headers=["*"],
)

limiter = RedisRateLimiter()
app.add_middleware(RateLimitMiddleware, limiter=limiter)
app.add_middleware(AuthMiddleware)

app.include_router(auth_router.router)
app.include_router(archive_router.router)
app.include_router(library_router.router)
app.include_router(search_router.router)
app.include_router(share_router.router)
app.include_router(health_router.build_health_router(limiter))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8090)
