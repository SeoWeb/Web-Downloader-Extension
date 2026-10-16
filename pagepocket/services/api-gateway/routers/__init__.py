"""Shared gRPC-to-HTTP error translation + request-body field guards."""

import logging

import grpc
from fastapi import HTTPException
from quota_markers import (
    EXHAUSTED_PREFIX,
    KIND_QUOTA,
    KIND_RATE,
    KIND_SIZE,
    parse_exhausted_kind,
)

logger = logging.getLogger(__name__)

# Suggested retry delays sent with 503s: a exceeded gRPC deadline is usually
# per-call (retry soon), an UNAVAILABLE upstream (service down/restarting)
# needs a longer backoff.
DEADLINE_RETRY_AFTER_SECONDS = 5
UNAVAILABLE_RETRY_AFTER_SECONDS = 30

# Detail fragments (lower-cased) that identify a gRPC message-size failure.
# gRPC emits e.g. "Sent message larger than max (5 vs. 4)" /
# "Received message larger than max (123 vs. 100)".
_SIZE_DETAIL_MARKERS = (
    "larger than max",
    "message size exceeds",
    "exceeds maximum message size",
    "message too large",
)

# Detail fragments emitted by the archive service's quota checks
# (archive-service/quota.py: "Monthly page limit reached" / "Storage limit
# reached") and generic quota phrasing.
_QUOTA_DETAIL_MARKERS = (
    "quota",
    "storage",
    "monthly page limit",
    "limit reached",
)

# Detail fragment used by rate limiting.
_RATE_DETAIL_MARKERS = ("rate",)


def _detail_has(detail: str, markers) -> bool:
    lowered = detail.lower()
    return any(marker in lowered for marker in markers)


def handle_grpc_error(e: grpc.RpcError):
    """Translate gRPC status codes to HTTP responses with api_version."""
    code = e.code()
    detail = str(e.details())

    mapping = {
        grpc.StatusCode.UNAUTHENTICATED: 401,
        grpc.StatusCode.ALREADY_EXISTS: 409,
        grpc.StatusCode.INVALID_ARGUMENT: 400,
        grpc.StatusCode.NOT_FOUND: 404,
        grpc.StatusCode.PERMISSION_DENIED: 403,
    }

    if code == grpc.StatusCode.DEADLINE_EXCEEDED:
        # The internal service was too slow (or hung until its deadline):
        # report 503 with Retry-After rather than a misleading 500.
        logger.warning("gRPC deadline exceeded: %s", detail)
        raise HTTPException(
            status_code=503,
            detail={"detail": "Upstream service timed out, please retry", "api_version": "v1"},
            headers={"Retry-After": str(DEADLINE_RETRY_AFTER_SECONDS)},
        )

    if code == grpc.StatusCode.UNAVAILABLE:
        # Transient upstream outage (service down/restarting, transient
        # network/R2 failures surfaced as UNAVAILABLE): retryable 503 with a
        # longer backoff, never a bare 500.
        logger.warning("gRPC upstream unavailable: %s", detail)
        raise HTTPException(
            status_code=503,
            detail={"detail": "Upstream service unavailable, please retry", "api_version": "v1"},
            headers={"Retry-After": str(UNAVAILABLE_RETRY_AFTER_SECONDS)},
        )

    if code == grpc.StatusCode.RESOURCE_EXHAUSTED:
        # Structured first (D9): the machine-readable exhausted:<kind> prefix
        # shared with archive-service via pagepocket/shared/quota_markers.py
        # decides the status on its own.
        kind = parse_exhausted_kind(detail)
        if kind == KIND_SIZE:
            status_code = 413
        elif kind == KIND_RATE:
            status_code = 429
        elif kind == KIND_QUOTA:
            status_code = 402
        else:
            # Legacy fallback (kept for the monolith / older archive builds):
            # size-induced exhaustion → 413 (payload too large), keeping quota
            # exhaustion → 402 and rate exhaustion → 429 distinct. Log so the
            # remaining prose-matching dependencies stay visible.
            logger.warning(
                "RESOURCE_EXHAUSTED details carry no structured %s prefix (%r) — using legacy string markers",
                EXHAUSTED_PREFIX,
                detail,
            )
            if _detail_has(detail, _SIZE_DETAIL_MARKERS):
                status_code = 413
            elif _detail_has(detail, _RATE_DETAIL_MARKERS):
                status_code = 429
            elif _detail_has(detail, _QUOTA_DETAIL_MARKERS):
                status_code = 402
            else:
                # Historical default: RESOURCE_EXHAUSTED from the services is
                # quota exhaustion (archive-service/quota.py).
                status_code = 402
        raise HTTPException(status_code=status_code, detail={"detail": detail, "api_version": "v1"})

    status_code = mapping.get(code, 500)
    raise HTTPException(status_code=status_code, detail={"detail": detail, "api_version": "v1"})


def require_field(body: dict, key: str):
    """Return a mandatory JSON body field, or raise HTTP 400 (never KeyError 500)."""
    value = body.get(key) if isinstance(body, dict) else None
    if value is None:
        raise HTTPException(
            status_code=400,
            detail={"detail": f"Missing required field: {key}", "api_version": "v1"},
        )
    return value
