"""Shared gRPC-to-HTTP error translation."""

import logging

import grpc
from fastapi import HTTPException

logger = logging.getLogger(__name__)

# Suggested retry delay sent with 503s caused by an exceeded gRPC deadline.
DEADLINE_RETRY_AFTER_SECONDS = 5

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

    if code == grpc.StatusCode.RESOURCE_EXHAUSTED:
        # Size-induced exhaustion → 413 (payload too large), keeping quota
        # exhaustion → 402 and rate exhaustion → 429 distinct.
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
