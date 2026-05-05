"""Archive service gRPC client for cloud push."""

import logging
import os
import time
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)

_channel = None
_stub = None


@dataclass
class CloudPushResult:
    """Result of a cloud archive push attempt."""

    page_id: Optional[str] = None
    error: Optional[str] = None


def _build_credentials():
    """Build mTLS channel credentials from env-configured cert paths."""
    import grpc

    ca_path = os.environ.get("ARCHIVE_CA_CERT", "")
    key_path = os.environ.get("ARCHIVE_CLIENT_KEY", "")
    cert_path = os.environ.get("ARCHIVE_CLIENT_CERT", "")

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

    import grpc
    import sys

    proto_dir = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "pagepocket", "shared", "proto_generated"))
    if proto_dir not in sys.path:
        sys.path.insert(0, proto_dir)

    import archive_pb2_grpc

    addr = os.environ.get("ARCHIVE_SERVICE_ADDR", "")
    if not addr:
        return None

    credentials = _build_credentials()
    if credentials is not None:
        channel = grpc.secure_channel(addr, credentials)
    else:
        # Fallback to plaintext for local dev (when certs are not configured)
        channel = grpc.insecure_channel(addr)
    _channel = channel
    _stub = archive_pb2_grpc.ArchiveServiceStub(channel)
    return _stub


def push_to_archive(
    user_id: str,
    session_id: str,
    url: str,
    title: str,
    html_content: bytes,
    assets: list[tuple[str, str, bytes]],
) -> CloudPushResult:
    """Push a finalized page to the archive service.

    Args:
        user_id: PagePocket user ID
        session_id: Extension server session UUID (used as extension_job_id)
        url: Original page URL
        title: Page title
        html_content: Merged HTML bytes
        assets: List of (filename, content_type, data) tuples

    Returns:
        CloudPushResult with page_id on success or error details on failure.
    """
    stub = _get_stub()
    if stub is None:
        return CloudPushResult(error="Archive service not configured")

    import archive_pb2

    asset_msgs = [
        archive_pb2.Asset(filename=fn, content_type=ct, data=data)
        for fn, ct, data in assets
    ]

    request = archive_pb2.IngestPageRequest(
        user_id=user_id,
        url=url,
        title=title,
        html_content=html_content,
        assets=asset_msgs,
        extension_job_id=session_id,
    )

    max_retries = 3
    for attempt in range(max_retries):
        try:
            response = stub.IngestPage(request, timeout=30)
            if response.success:
                logger.info(
                    "Cloud push succeeded: session=%s page_id=%s attempt=%d",
                    session_id, response.page_id, attempt + 1,
                )
                return CloudPushResult(page_id=response.page_id)
            else:
                logger.warning(
                    "Cloud push returned failure: session=%s message=%s",
                    session_id, response.message,
                )
                return CloudPushResult(error=response.message or "server returned failure")
        except Exception as exc:
            error_str = f"{type(exc).__name__}: {exc}"
            logger.warning(
                "Cloud push attempt %d/%d failed: session=%s error=%s",
                attempt + 1, max_retries, session_id, exc,
            )
            if attempt < max_retries - 1:
                time.sleep(2 ** attempt)  # Exponential backoff: 1s, 2s
            else:
                logger.error(
                    "Cloud push failed after %d attempts: session=%s",
                    max_retries, session_id,
                )
                return CloudPushResult(error=error_str)


def is_configured() -> bool:
    """Check if archive service is configured."""
    return bool(os.environ.get("ARCHIVE_SERVICE_ADDR", ""))


def validate_config() -> list[str]:
    """Validate archive service config. Returns list of errors."""
    errors = []
    addr = os.environ.get("ARCHIVE_SERVICE_ADDR", "")
    if not addr:
        return errors  # Not configured is fine (feature is optional)

    required_env = ["ARCHIVE_CA_CERT", "ARCHIVE_CLIENT_KEY", "ARCHIVE_CLIENT_CERT"]
    for env_var in required_env:
        path = os.environ.get(env_var, "")
        if not path:
            errors.append(f"{env_var} is required when ARCHIVE_SERVICE_ADDR is set")
        elif not os.path.isfile(path):
            errors.append(f"{env_var}={path} does not exist or is not readable")

    return errors
