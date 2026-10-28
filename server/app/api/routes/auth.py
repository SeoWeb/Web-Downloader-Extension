"""Auth routes: client registration and API key management."""

import logging
import math
import time

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

# Rate-limited (module-level timestamp, single-process server) warning state
# for the untrusted-proxy-header signal (D6).
_UNTRUSTED_PROXY_WARN_INTERVAL_SECONDS: float = 300.0  # once per 5 minutes
_untrusted_proxy_warned_at: float = 0.0


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


def retry_after_headers(retry_after: float) -> dict[str, str]:
    """Build the 429 ``Retry-After`` header, capped at
    ``registration_retry_after_max_seconds`` (D5).

    The honest refill estimate for the per-instance limiter is hours-scale
    (budget spread over 24h), which is operationally useless as a hint —
    the client waits ``min(header, 60)`` seconds anyway. The cap turns a
    hard failure into a delayed success.
    """
    capped = min(
        math.ceil(retry_after), settings.registration_retry_after_max_seconds
    )
    return {"Retry-After": str(max(1, capped))}


def warn_untrusted_forwarded_header(request: Request) -> None:
    """Warn (rate-limited to once per 5 min) when a request carries
    ``X-Forwarded-For`` while ``TRUST_PROXY`` is disabled (D6).

    That combination is the signature of proxy-in-front-but-untrusted:
    limiter keys fall back to the peer address, so every registrant behind
    the proxy shares the proxy's single per-IP registration bucket. There
    is no startup-time detector (the loopback bind is mapped at the host
    level), so this runtime signal is the honest one.
    """
    global _untrusted_proxy_warned_at
    if settings.trust_proxy:
        return
    if not request.headers.get("x-forwarded-for"):
        return
    now = time.monotonic()
    if now - _untrusted_proxy_warned_at < _UNTRUSTED_PROXY_WARN_INTERVAL_SECONDS:
        return
    _untrusted_proxy_warned_at = now
    peer = request.client.host if request.client else "unknown"
    logger.warning(
        "TRUST_PROXY is disabled but a request carries X-Forwarded-For "
        "(peer=%s): a reverse proxy is in front yet untrusted, so "
        "rate-limiter keys fall back to the peer address — every client "
        "shares the proxy's single per-IP registration bucket (5/min) and "
        "registrations 429 together. Set TRUST_PROXY=true behind nginx.",
        peer,
    )


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
    warn_untrusted_forwarded_header(request)
    allowed, retry_after = registration_limiter.is_allowed(client_ip)
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "error": "rate_limit_exceeded",
                "message": "Too many registration requests. Please try again later.",
                "api_version": "v1",
            },
            headers=retry_after_headers(retry_after),
        )

    body = body or RegisterRequest()

    # If extension_instance_id provided, check if already registered.
    # The dedup lookup runs BEFORE the per-instance limiter (D5): a
    # returning instance resolving via `existing` consumes NO instance
    # budget — the instance limiter is 10/day with refill spread over
    # 24h, so burning budget on dedup hits turns routine service-worker
    # restarts into hours-scale 429s. The per-IP limiter above still
    # consumes per request, keeping the abuse bound for random-id
    # miss floods.
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

        # Fresh registration: rate limiting per extension instance id
        # (7.8). Instance ids are client-controlled strings; without a
        # per-id bound, a caller can hammer the dedup lookup with
        # arbitrary ids. Burst == daily limit, refill spread over 24h,
        # so each id gets at most ~N registrations per day.
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
                headers=retry_after_headers(retry_after),
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
