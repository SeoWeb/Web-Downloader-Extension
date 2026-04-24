import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events."""
    logger.info("Server starting up...")
    # Import models so Alembic/Auto-generate can discover them
    import app.models  # noqa: F401

    from app.db.database import init_db, async_session_factory

    # Ensure storage root directory exists
    import os
    os.makedirs(settings.storage_root, exist_ok=True)

    await init_db()

    # Run startup cleanup: stale sessions, expired sessions, orphaned keys/dirs
    from app.services.cleanup import cleanup_service
    try:
        async with async_session_factory() as db:
            try:
                await cleanup_service.run_startup_cleanup(db)
                await db.commit()
            except Exception:
                await db.rollback()
                logger.exception("Startup cleanup failed (non-fatal)")
    except Exception:
        logger.exception("Startup cleanup failed (non-fatal)")

    # Start periodic cleanup background task
    await cleanup_service.start_periodic_cleanup()

    yield

    # Shutdown: stop periodic cleanup
    await cleanup_service.stop_periodic_cleanup()
    logger.info("Server shutting down...")


app = FastAPI(
    title="Website Downloader Server",
    description="Server-side microservice for HTML merging, URL conversion, and ZIP assembly",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS middleware - allow chrome-extension:// origins via regex
# (allow_origins treats entries as exact strings, not glob patterns,
# so chrome-extension://* would only match the literal asterisk)
# Additional configurable origins (e.g., for admin dashboards) from settings.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allowed_origins,
    allow_origin_regex=settings.cors_extension_origin_regex,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-API-Key", "X-Content-Gzipped"],
)

# API routers
from app.api.routes import auth, download, health, html, resources, sessions

app.include_router(auth.router)
app.include_router(health.router)
app.include_router(sessions.router)
app.include_router(html.router)
app.include_router(resources.router)
app.include_router(download.router)
