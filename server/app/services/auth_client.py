"""Auth service gRPC client for cloud identity binding (3.1).

Verifies a PagePocket access token via ``AuthService.Verify`` and returns
the bound user id + plan. Mirrors ``archive_client.py`` for channel/mTLS
setup: env-configured cert paths, optional plaintext fallback for local dev.

Contract note (harden-backend-security-and-ops 2.2/D9): ``VerifyResponse``
gains additive ``plan`` (and owner) fields. The generated stubs in
``pagepocket/shared/proto_generated`` already carry ``plan``; reads here are
defensive (``getattr`` with empty default) so an older stub set degrades to
plan=None instead of failing the binding.
"""

import logging
import os
from dataclasses import dataclass

logger = logging.getLogger(__name__)

_channel = None
_stub = None


@dataclass
class VerifyResult:
    """Result of an AuthService.Verify call."""

    valid: bool
    user_id: str | None = None
    email: str | None = None
    plan: str | None = None
    error: str | None = None


def _build_credentials():
    """Build mTLS channel credentials from env-configured cert paths."""
    import grpc

    ca_path = os.environ.get("AUTH_CA_CERT", "")
    key_path = os.environ.get("AUTH_CLIENT_KEY", "")
    cert_path = os.environ.get("AUTH_CLIENT_CERT", "")

    if not all(os.path.isfile(p) for p in (ca_path, key_path, cert_path)):
        return None

    with open(ca_path, "rb") as f:
        root_certificates = f.read()
    with open(key_path, "rb") as f:
        private_key = f.read()
    with open(cert_path, "rb") as f:
        certificate_chain = f.read()

    return grpc.ssl_channel_credentials(
        root_certificates=root_certificates,
        private_key=private_key,
        certificate_chain=certificate_chain,
    )


def _get_stub():
    global _channel, _stub
    if _stub is not None:
        return _stub

    import sys

    import grpc

    # Resolve proto_generated directory:
    # 1. PROTO_DIR env var (explicit, used in Docker)
    # 2. Relative path to pagepocket/shared/proto_generated (local dev)
    proto_dir = os.environ.get("PROTO_DIR") or os.path.normpath(
        os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "pagepocket", "shared", "proto_generated")
    )
    if proto_dir not in sys.path:
        sys.path.insert(0, proto_dir)

    import auth_pb2_grpc

    addr = os.environ.get("AUTH_SERVICE_ADDR", "")
    if not addr:
        return None

    credentials = _build_credentials()
    options = [
        ("grpc.max_receive_message_length", 64 * 1024 * 1024),
        ("grpc.max_send_message_length", 64 * 1024 * 1024),
    ]
    if credentials is not None:
        channel = grpc.secure_channel(addr, credentials, options=options)
    else:
        # Fallback to plaintext for local dev (when certs are not configured)
        channel = grpc.insecure_channel(addr, options=options)
    _channel = channel
    _stub = auth_pb2_grpc.AuthServiceStub(channel)
    return _stub


def verify_token(token: str) -> VerifyResult:
    """Verify a PagePocket access token against the auth service.

    Returns:
        VerifyResult with valid=True and the bound user id/plan on success,
        or valid=False (with error details) when the token is rejected or the
        auth service is unreachable.
    """
    stub = _get_stub()
    if stub is None:
        return VerifyResult(valid=False, error="Auth service not configured")

    import auth_pb2

    request = auth_pb2.VerifyRequest(token=token)

    try:
        response = stub.Verify(request, timeout=10)
    except Exception as exc:
        logger.warning("AuthService.Verify failed: %s", exc)
        return VerifyResult(valid=False, error=f"{type(exc).__name__}: {exc}")

    if not response.valid:
        return VerifyResult(valid=False, error="Token rejected by auth service")

    # Defensive reads: additive proto fields are absent in stale stubs.
    user_id = (response.user_id or "").strip() or None
    if user_id is None:
        return VerifyResult(valid=False, error="Verify returned no user id")
    plan = (getattr(response, "plan", "") or "").strip() or None
    email = (getattr(response, "email", "") or "").strip() or None

    return VerifyResult(valid=True, user_id=user_id, email=email, plan=plan)


def is_configured() -> bool:
    """Check if auth service is configured (addr set)."""
    return bool(os.environ.get("AUTH_SERVICE_ADDR", ""))


def validate_config() -> list[str]:
    """Validate auth service config. Returns list of warnings.

    mTLS certs are optional — plaintext mode is allowed for local dev.
    Only file-existence checks are errors (when cert env vars ARE set).
    """
    errors = []
    if not is_configured():
        return errors  # Not configured is fine (binding is optional)

    cert_env = {
        "AUTH_CA_CERT": os.environ.get("AUTH_CA_CERT", ""),
        "AUTH_CLIENT_KEY": os.environ.get("AUTH_CLIENT_KEY", ""),
        "AUTH_CLIENT_CERT": os.environ.get("AUTH_CLIENT_CERT", ""),
    }
    any_cert_set = any(v for v in cert_env.values())

    if any_cert_set:
        # If any cert is provided, all three must be present and valid
        for env_var, path in cert_env.items():
            if not path:
                errors.append(f"{env_var} is required when other cert paths are set")
            elif not os.path.isfile(path):
                errors.append(f"{env_var}={path} does not exist or is not readable")

    return errors
