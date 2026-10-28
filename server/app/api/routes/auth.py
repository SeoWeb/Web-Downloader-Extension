"""Auth routes: client registration and API key management."""

import logging
import math
import secrets
import time

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
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


def _verify_reauth_proof(client: Client, presented_key: str) -> bool:
    """Verify a re-registration proof against ONE resolved client row (D1).

    Same lookup strategy as ``authenticate_client`` (dependencies.py 7.5),
    scoped to the row the instance-id dedup lookup resolved:

      1. SHA-256 compare on ``api_key_hash`` — the primary path once keys
         are hashed at rest.
      2. Plaintext ``api_key`` fallback for legacy rows, with the hash
         column populated lazily on this successful proof.

    Constant-time comparisons; a non-matching proof returns False without
    touching the row.
    """
    from app.models.client import hash_api_key

    presented_hash = hash_api_key(presented_key)
    if client.api_key_hash:
        return secrets.compare_digest(
            client.api_key_hash.encode("utf-8"),
            presented_hash.encode("utf-8"),
        )
    # Legacy plaintext-only row: compare plaintext, migrate the hash lazily.
    if secrets.compare_digest(
        client.api_key.encode("utf-8"), presented_key.encode("utf-8")
    ):
        client.api_key_hash = presented_hash
        logger.info(
            "API key hash migrated lazily for client %s "
            "(re-registration proof)", client.id,
        )
        return True
    return False


@router.post(
    "/register",
    response_model=RegisterResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Register extension client",
    description="Register a new extension client and receive an API key "
    "(201). If the client_id is already registered, the request MUST "
    "present that client's current API key as proof of possession in the "
    "X-API-Key header: a matching proof re-unlocks the existing identity "
    "(200 with the existing key — no duplicate record is created), a "
    "missing proof is rejected with 409 reauth_required (the instance ID "
    "alone yields no key), and a proof that does not verify against the "
    "registered client is rejected with 401 reauth_proof_invalid.",
)
async def register(
    request: Request,
    body: RegisterRequest | None = None,
    db: AsyncSession = Depends(get_db),  # noqa: B008
    response: Response = None,  # noqa: B008 - injected by FastAPI; None in direct-call tests
) -> RegisterResponse:
    """Register an extension client and return an API key.

    Outcomes (api-abuse-hardening D2):

    - Fresh ``client_id`` (or absent): 201 with a newly minted key —
      unauthenticated, per-IP and per-instance rate limited (unchanged).
    - Registered ``client_id`` + matching ``X-API-Key`` proof: 200 with
      the EXISTING key and identity (re-unlock; no duplicate row).
    - Registered ``client_id`` + no proof header: 409 ``reauth_required``
      — the instance ID alone no longer yields a key.
    - Registered ``client_id`` + proof that doesn't verify against that
      client's stored credential: 401 ``reauth_proof_invalid``.
    """
    # Rate limiting by client IP (proxy-aware per TRUST_PROXY, 7.8) —
    # deliberately the FIRST gate (D2 ordering): every outcome below —
    # fresh 201, re-unlock 200, 409, 401 — consumes this bucket, so the
    # proof gate cannot be probed at unbounded volume.
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
            # api-abuse-hardening (D1/D2): the instance ID alone no longer
            # yields a key. Re-registration requires proof of possession of
            # this client's current API key.
            proof = request.headers.get("x-api-key")
            if proof is None:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={
                        "error": "reauth_required",
                        "message": "This instance is already registered. "
                        "Send its current API key in the X-API-Key header "
                        "to re-register.",
                        "api_version": "v1",
                    },
                )
            if not _verify_reauth_proof(existing, proof):
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail={
                        "error": "reauth_proof_invalid",
                        "message": "The presented API key does not match "
                        "this instance's registered key.",
                        "api_version": "v1",
                    },
                )
            # Proof verified — re-unlock the existing identity: same key,
            # same row, 200 (not the 201 of a fresh registration).
            if response is not None:
                response.status_code = status.HTTP_200_OK
            logger.info(
                "Re-registered existing client (proof-of-possession "
                "re-unlock): id=%s", existing.id,
            )
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

    # Fresh registration is 201 (D2). The route decorator pins 201, but an
    # injected FastAPI Response defaults to 200 and would override it.
    if response is not None:
        response.status_code = status.HTTP_201_CREATED

    logger.info("Registered new client: id=%s", client.id)
    return RegisterResponse(
        api_key=client.api_key,
        client_id=client.id,
        extension_instance_id=client.extension_instance_id,
    )
