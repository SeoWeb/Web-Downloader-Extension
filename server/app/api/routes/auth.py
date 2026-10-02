"""Auth routes: client registration and API key management."""

import logging
import math

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.database import get_db
from app.api.rate_limiter import registration_limiter
from app.models.client import Client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


class RegisterRequest(BaseModel):
    """Request body for client registration."""

    client_id: str | None = Field(
        None,
        description="Optional unique client identifier (e.g., extension instance ID)",
    )
    name: str | None = Field(None, description="Optional human-readable client name")


class RegisterResponse(BaseModel):
    """Response body for successful registration."""

    api_key: str
    client_id: str
    extension_instance_id: str | None = None
    api_version: str = "v1"


@router.post(
    "/register",
    response_model=RegisterResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Register extension client",
    description="Register a new extension client and receive an API key. "
    "If the client_id already exists, returns the existing API key.",
)
async def register(
    request: Request,
    body: RegisterRequest | None = None,
    db: AsyncSession = Depends(get_db),  # noqa: B008
) -> RegisterResponse:
    """Register an extension client and return an API key."""
    # Rate limiting by client IP
    client_ip = request.client.host if request.client else "unknown"
    allowed, retry_after = registration_limiter.is_allowed(client_ip)
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "error": "rate_limit_exceeded",
                "message": "Too many registration requests. Please try again later.",
                "api_version": "v1",
            },
            headers={"Retry-After": str(math.ceil(retry_after))},
        )

    body = body or RegisterRequest()

    # If extension_instance_id provided, check if already registered
    if body.client_id:
        stmt = select(Client).where(Client.extension_instance_id == body.client_id)
        result = await db.execute(stmt)
        existing = result.scalar_one_or_none()
        if existing:
            return RegisterResponse(
                api_key=existing.api_key,
                client_id=existing.id,
                extension_instance_id=existing.extension_instance_id,
            )

    # Create new client
    client = Client(extension_instance_id=body.client_id, name=body.name)
    db.add(client)
    await db.flush()

    logger.info("Registered new client: id=%s", client.id)
    return RegisterResponse(
        api_key=client.api_key,
        client_id=client.id,
        extension_instance_id=client.extension_instance_id,
    )
