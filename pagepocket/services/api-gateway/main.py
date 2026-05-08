"""API Gateway entry point."""

import os
import sys

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "shared"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "shared", "proto_generated"))

from middleware import AuthMiddleware
from middleware.rate_limit import RateLimitMiddleware
from routers import auth as auth_router
from routers import archive as archive_router
from routers import library as library_router
from routers import search as search_router
from routers import share as share_router

app = FastAPI(title="PagePocket API", version="v1")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(RateLimitMiddleware)
app.add_middleware(AuthMiddleware)

app.include_router(auth_router.router)
app.include_router(archive_router.router)
app.include_router(library_router.router)
app.include_router(search_router.router)
app.include_router(share_router.router)


@app.get("/api/v1/health")
async def health():
    return {"status": "ok", "api_version": "v1"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8090)
