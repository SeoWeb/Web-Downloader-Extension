"""Shared gRPC-to-HTTP error translation."""

from fastapi import HTTPException
import grpc


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

    if code == grpc.StatusCode.RESOURCE_EXHAUSTED:
        # Quota exhaustion → 402, rate exhaustion → 429
        status_code = 429 if "rate" in detail.lower() else 402
        raise HTTPException(status_code=status_code, detail={"detail": detail, "api_version": "v1"})

    status_code = mapping.get(code, 500)
    raise HTTPException(status_code=status_code, detail={"detail": detail, "api_version": "v1"})
