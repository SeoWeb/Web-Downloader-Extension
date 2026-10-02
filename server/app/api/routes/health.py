"""Health check route: server status and diagnostics."""

import logging
import shutil

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.database import get_db
from app.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1", tags=["health"])


class HealthResponse(BaseModel):
    """Health check response."""

    status: str
    version: str
    mysql: str
    storage_available_mb: float
    storage_total_mb: float
    description: str | None = None
    api_version: str = "v1"


@router.get(
    "/health",
    response_model=HealthResponse,
    summary="Server health check",
    description="Returns server status, version, MySQL connectivity, and storage capacity. "
    "No authentication required.",
)
async def health_check(
    db: AsyncSession = Depends(get_db),  # noqa: B008
) -> HealthResponse:
    """Check server health including MySQL connectivity and storage capacity."""
    # Check MySQL connectivity
    mysql_status = "ok"
    try:
        await db.execute(text("SELECT 1"))
    except Exception as e:
        logger.warning("MySQL health check failed: %s", e)
        mysql_status = "unavailable"

    # Check storage capacity
    storage_usage = shutil.disk_usage(settings.storage_root)
    storage_available_mb = round(storage_usage.free / (1024 * 1024), 1)
    storage_total_mb = round(storage_usage.total / (1024 * 1024), 1)

    # Determine overall status
    overall_status = "ok"
    description = None
    if mysql_status != "ok":
        overall_status = "degraded"
        description = f"MySQL is {mysql_status}"
    elif storage_available_mb < 100:
        overall_status = "degraded"
        description = f"Storage nearly full ({storage_available_mb:.0f} MB available)"

    return HealthResponse(
        status=overall_status,
        version="1.0.0",
        mysql=mysql_status,
        storage_available_mb=storage_available_mb,
        storage_total_mb=storage_total_mb,
        description=description,
    )
