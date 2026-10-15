"""Auth routes: client registration and API key management."""

import logging
import math

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.rate_limiter import registration_instance_limiter, registration_limiter
from app.config import settings
from app.db.database import get_db
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


def get_client_ip(request: Request) -> str:
    """Resolve the client IP for rate limiting (7.8).

    By default the peer address is used — honoring ``X-Forwarded-For`` from
    an untrusted caller lets anyone rotate their limit key. Only when
    ``TRUST_PROXY`` is enabled (monolith behind a known reverse proxy) is the
    rightmost X-Forwarded-For entry trusted: the trusted proxy appends the
    real peer to the header, so the rightmost entry is the one it observed.
    """
    peer = request.client.host if request.client else "unknown"
    if not settings.trust_proxy:
        return peer
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        # Rightmost entry is added by the trusted proxy → most trustworthy.
        candidate = forwarded.split(",")[-1].strip()
        if candidate:
            return candidate
    return peer


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
    # Rate limiting by client IP (proxy-aware per TRUST_PROXY, 7.8)
    client_ip = get_client_ip(request)
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

    # Rate limiting per extension instance id (7.8): instance ids are
    # client-controlled strings; without a per-id bound, a caller can hammer
    # the dedup lookup with arbitrary ids. Burst == daily limit, refill
    # spread over 24h, so each id gets at most ~N registrations per day.
    if body.client_id:
        allowed, retry_after = registration_instance_limiter.is_allowed(
            body.client_id
        )
        if not allowed:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail={
                    "error": "rate_limit_exceeded",
                    "message": "Too many registration attempts for this instance id. "
                    "Please try again later.",
                    "api_version": "v1",
                },
                headers={"Retry-After": str(math.ceil(retry_after))},
            )

        # If extension_instance_id provided, check if already registered
        stmt = select(Client).where(Client.extension_instance_id == body.client_id)
        result = await db.execute(stmt)
        existing = result.scalar_one_or_none()
        if existing:
            return RegisterResponse(
                api_key=existing.api_key,
                client_id=existing.id,
                extension_instance_id=existing.extension_instance_id,
            )

    # Create new client — API key hash is stored at creation (7.5).
    # flush() first so the api_key column default is applied and hashable.
    client = Client(extension_instance_id=body.client_id, name=body.name)
    db.add(client)
    await db.flush()
    client.api_key_hash = Client.hash_key(client.api_key)

    logger.info("Registered new client: id=%s", client.id)
    return RegisterResponse(
        api_key=client.api_key,
        client_id=client.id,
        extension_instance_id=client.extension_instance_id,
    )
