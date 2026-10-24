"""Archive service gRPC client for cloud push and cloud delete."""

import logging
import os
import sys
import threading
import time
from dataclasses import dataclass
from typing import Optional

from app.config import settings

logger = logging.getLogger(__name__)

_channel = None
_stub = None

# ---------------------------------------------------------------------------
# Cloud push envelope (6.2)
# ---------------------------------------------------------------------------

# Wire-level gRPC message cap. Matches the channel options in _get_stub() and
# the archive-service / api-gateway 256 MB limits (harden 4.1).
GRPC_MAX_MESSAGE_BYTES = 256 * 1024 * 1024

# Headroom for proto serialization overhead (field tags, varint lengths,
# filenames, url/title strings). A few KB in practice, rounded up generously.
CLOUD_PUSH_SAFETY_MARGIN_BYTES = 2 * 1024 * 1024

# Effective payload cap (HTML + every asset) enforced BEFORE anything is
# built or sent. Pushing past this is a deterministic failure — the channel
# rejects the message client-side and every retry would re-send it.
CLOUD_PUSH_MAX_PAYLOAD_BYTES = GRPC_MAX_MESSAGE_BYTES - CLOUD_PUSH_SAFETY_MARGIN_BYTES

# Per-attempt unary deadline. The spec envelope documents the server's worst
# case as 3 sequential calls at this budget plus queue wait (≤ 32 min).
PUSH_TIMEOUT_SECONDS = 600

# Per-attempt unary deadline for the delete RPC. A delete is a cheap metadata
# operation on the archive service; the short budget keeps the opt-in cloud
# delete from stalling a session deletion. No retry: a failed delete is
# reported to the caller and a repeated delete is idempotent.
DELETE_TIMEOUT_SECONDS = 10

# Max wait for the per-session single-flight lock: covers the worst case of
# one in-flight push (3 × 600 s) plus margin before giving up.
PUSH_LOCK_WAIT_SECONDS = PUSH_TIMEOUT_SECONDS * 3 + 120

# Detail fragments (lower-cased) that identify a gRPC message-size failure.
# Mirror of the gateway's _SIZE_DETAIL_MARKERS (pagepocket/services/
# api-gateway/routers/__init__.py, task 4.3): gRPC emits e.g. "Sent message
# larger than max (5 vs. 4)".
_SIZE_DETAIL_MARKERS = (
    "larger than max",
    "message size exceeds",
    "exceeds maximum message size",
    "message too large",
)


@dataclass
class CloudPushResult:
    """Result of a cloud archive push attempt."""

    page_id: Optional[str] = None
    error: Optional[str] = None


@dataclass
class CloudDeleteResult:
    """Result of a cloud archive page delete attempt.

    ``deleted=True`` covers both a confirmed delete and an already-absent
    page (NOT_FOUND → idempotent success); ``error`` carries the failure
    detail when the RPC could not be completed.
    """

    deleted: bool = False
    error: Optional[str] = None


class CloudPayloadTooLargeError(Exception):
    """Raised before any upload work when the push payload exceeds the cap.

    Deterministic: no retry can shrink the message. ``str(exc)`` is the
    precise user-facing error (``cloud_size_error``).
    """

    def __init__(self, total_bytes: int, limit_bytes: int = CLOUD_PUSH_MAX_PAYLOAD_BYTES):
        self.total_bytes = total_bytes
        self.limit_bytes = limit_bytes
        super().__init__(cloud_size_error(total_bytes, limit_bytes))


def format_mb(num_bytes: int) -> str:
    """Format a byte count as a human-readable MB string."""
    return f"{num_bytes / (1024 * 1024):.1f} MB"


def cloud_size_error(
    total_bytes: int,
    limit_bytes: int = CLOUD_PUSH_MAX_PAYLOAD_BYTES,
) -> str:
    """Precise, non-retryable cloud_error for an oversize push payload.

    The message names the wire-level gRPC limit (256 MB — the number that
    matters to a user), while the enforced gate is the slightly smaller
    ``limit_bytes`` (serialization headroom).
    """
    return (
        f"session exceeds {GRPC_MAX_MESSAGE_BYTES // (1024 * 1024)} MB cloud limit: "
        f"{format_mb(total_bytes)}"
    )


def cloud_asset_count_error(count: int, limit: int) -> str:
    """Precise, non-retryable cloud_error for an over-cap asset count.

    Parity with the gateway's REST ingest rejection (MAX_INGEST_ASSETS,
    default 200): the push path refuses deterministically instead of
    shipping an ingest the gateway would reject anyway.
    """
    return f"session exceeds cloud asset limit: {count} assets (max {limit})"


def _rpc_error_parts(exc: BaseException) -> tuple[Optional[str], str]:
    """Extract (upper-cased status code, combined detail text) from an error.

    Duck-typed so classification works without importing grpc and with test
    doubles: reads ``exc.code()`` / ``exc.details()`` when present.
    """
    code: Optional[str] = None
    code_getter = getattr(exc, "code", None)
    if callable(code_getter):
        try:
            code = str(code_getter()).upper()
        except Exception:
            code = None

    parts = [str(exc)]
    details_getter = getattr(exc, "details", None)
    if callable(details_getter):
        try:
            parts.append(str(details_getter()))
        except Exception:
            pass
    return code, " ".join(parts).lower()


def is_message_size_error(exc: BaseException) -> bool:
    """True when a gRPC failure is a deterministic message-size rejection.

    Mirrors the gateway's 4.3 classification (RESOURCE_EXHAUSTED carrying a
    size detail). These failures are deterministic — retrying re-sends the
    same oversize message and burns the full 3 × 600 s budget for nothing.
    Quota-induced RESOURCE_EXHAUSTED ("Storage limit reached", no size
    marker) deliberately stays retryable, matching the gateway's 402 vs 413
    distinction.
    """
    code, text = _rpc_error_parts(exc)
    if code is None or "RESOURCE_EXHAUSTED" not in code:
        return False
    return any(marker in text for marker in _SIZE_DETAIL_MARKERS)


# ---------------------------------------------------------------------------
# Single-flight push (6.2)
# ---------------------------------------------------------------------------

# One lock per session id: concurrent pushes for the SAME session (e.g. the
# extension retrying while a push is still in flight) serialize instead of
# stacking duplicate full-payload RPCs. Cross-session pushes never contend.
# Whichever push completes first wins; later ones re-ingest and the archive
# service's user-scoped idempotency (2.6: unique user_id + extension_job_id)
# returns the same page_id, so retries converge.
_session_push_locks: dict[str, threading.Lock] = {}
_session_push_locks_guard = threading.Lock()


def _session_push_lock(session_id: str) -> threading.Lock:
    with _session_push_locks_guard:
        lock = _session_push_locks.get(session_id)
        if lock is None:
            # Bound the registry: finished locks are never removed
            # individually (no waiter count on threading.Lock), so reset
            # once it grows large. Worst case of a reset is that two
            # pushes for the same session briefly use different lock
            # objects — still converged by the service's idempotency.
            if len(_session_push_locks) >= 4096:
                _session_push_locks.clear()
            lock = threading.Lock()
            _session_push_locks[session_id] = lock
        return lock


def _ensure_proto_path() -> None:
    """Make the generated proto modules importable (idempotent).

    Resolve proto_generated directory:
    1. PROTO_DIR env var (explicit, used in Docker)
    2. Relative path to pagepocket/shared/proto_generated (local dev)
    """
    proto_dir = os.environ.get("PROTO_DIR") or os.path.normpath(
        os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "pagepocket", "shared", "proto_generated")
    )
    if proto_dir not in sys.path:
        sys.path.insert(0, proto_dir)


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

    _ensure_proto_path()

    import archive_pb2_grpc

    addr = os.environ.get("ARCHIVE_SERVICE_ADDR", "")
    if not addr:
        return None

    credentials = _build_credentials()
    options = [
        ("grpc.max_receive_message_length", GRPC_MAX_MESSAGE_BYTES),
        ("grpc.max_send_message_length", GRPC_MAX_MESSAGE_BYTES),
    ]
    if credentials is not None:
        channel = grpc.secure_channel(addr, credentials, options=options)
    else:
        # Fallback to plaintext for local dev (when certs are not configured)
        channel = grpc.insecure_channel(addr, options=options)
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
    plan: str = "free",
    markdown_content: Optional[bytes] = None,
    text_content: Optional[bytes] = None,
) -> CloudPushResult:
    """Push a finalized page to the archive service.

    Args:
        user_id: PagePocket user ID (from the server-side client binding)
        session_id: Extension server session UUID (used as extension_job_id)
        url: Original page URL
        title: Page title
        html_content: Merged HTML bytes (empty for a text-only push —
            text-native-downloads D1: html_content becomes optional)
        assets: List of (filename, content_type, data) tuples
        plan: User's plan from the binding (3.2) — NEVER omitted; defaults
            to "free" so a missing binding plan cannot escalate quota.
        markdown_content: Main-page markdown document (text-native-downloads
            4.1), pushed as a "markdown" ContentDocument when set.
        text_content: Uploaded extracted text (text-native-downloads 4.1),
            pushed as a "text" ContentDocument when set.

    Returns:
        CloudPushResult with page_id on success or error details on failure.
    """
    _ensure_proto_path()
    stub = _get_stub()
    if stub is None:
        return CloudPushResult(error="Archive service not configured")

    import archive_pb2

    # 6.2 pre-flight size gate: account the exact payload before building
    # anything. The IngestPage contract is one unary message (no batched /
    # append RPC exists), so an oversize session can never succeed — fail
    # immediately with a precise quota-style error instead of burning the
    # 3 × 600 s retry budget on deterministic channel rejections. Text
    # documents count toward the payload (text-native-downloads 4.1).
    total_bytes = (
        len(html_content)
        + sum(len(data) for _fn, _ct, data in assets)
        + (len(markdown_content) if markdown_content else 0)
        + (len(text_content) if text_content else 0)
    )
    if total_bytes > CLOUD_PUSH_MAX_PAYLOAD_BYTES:
        logger.error(
            "Cloud push rejected pre-flight: session=%s payload=%s limit=%s assets=%d",
            session_id, format_mb(total_bytes),
            format_mb(CLOUD_PUSH_MAX_PAYLOAD_BYTES), len(assets),
        )
        return CloudPushResult(
            error=cloud_size_error(total_bytes, CLOUD_PUSH_MAX_PAYLOAD_BYTES)
        )

    # Pre-flight asset-count gate (cloud-via-server parity, D3): the gateway's
    # REST ingest rejects sessions over its asset cap (default 200) with a
    # deterministic 400-class error; pushing 201+ assets would only burn the
    # 3 × 600 s retry budget on a rejection that can never succeed. The count
    # is known before anything is built — stat-only, no gRPC traffic.
    asset_cap = settings.cloud_max_assets
    if len(assets) > asset_cap:
        logger.error(
            "Cloud push rejected pre-flight: session=%s assets=%d limit=%d",
            session_id, len(assets), asset_cap,
        )
        return CloudPushResult(error=cloud_asset_count_error(len(assets), asset_cap))

    asset_msgs = [
        archive_pb2.Asset(filename=fn, content_type=ct, data=data)
        for fn, ct, data in assets
    ]

    # Identity + plan always travel with the request (3.2 / D4): user_id and
    # plan are resolved server-side from the client binding — never omitted,
    # never taken from extension-supplied data.
    request_kwargs: dict = dict(
        user_id=user_id,
        url=url,
        title=title,
        html_content=html_content,
        assets=asset_msgs,
        extension_job_id=session_id,
        plan=plan or "free",
    )

    # text-native-downloads 4.1 (D1/D5): text documents travel as additive
    # ContentDocument entries; formats follow the pinned enum. Against a
    # backend whose generated stubs predate ContentDocument the text parts
    # are dropped with a warning (D8: text parts dropped, HTML page still
    # stored — graceful degradation in both directions).
    if markdown_content or text_content:
        if hasattr(archive_pb2, "ContentDocument"):
            content_documents = []
            if markdown_content:
                content_documents.append(
                    archive_pb2.ContentDocument(
                        content_format="markdown", data=markdown_content,
                    )
                )
            if text_content:
                content_documents.append(
                    archive_pb2.ContentDocument(
                        content_format="text", data=text_content,
                    )
                )
            request_kwargs["content_documents"] = content_documents
        else:
            logger.warning(
                "Cloud push: installed archive proto lacks ContentDocument — "
                "pushing without text documents (legacy backend): session=%s",
                session_id,
            )

    request = archive_pb2.IngestPageRequest(**request_kwargs)

    # 6.2 single-flight: serialize pushes per session so a concurrent retry
    # waits instead of stacking a second full-payload RPC. Convergence for
    # the waiting caller comes from the service's user-scoped idempotency.
    lock = _session_push_lock(session_id)
    if not lock.acquire(timeout=PUSH_LOCK_WAIT_SECONDS):
        logger.warning(
            "Cloud push skipped: another push for session %s still in flight", session_id,
        )
        return CloudPushResult(error="another push for this session is already in flight")

    max_retries = 3
    started = time.monotonic()
    try:
        for attempt in range(max_retries):
            try:
                response = stub.IngestPage(request, timeout=PUSH_TIMEOUT_SECONDS)
                if response.success:
                    logger.info(
                        "Cloud push succeeded: session=%s page_id=%s attempt=%d wall=%.1fs",
                        session_id, response.page_id, attempt + 1,
                        time.monotonic() - started,
                    )
                    return CloudPushResult(page_id=response.page_id)
                else:
                    logger.warning(
                        "Cloud push returned failure: session=%s message=%s wall=%.1fs",
                        session_id, response.message, time.monotonic() - started,
                    )
                    return CloudPushResult(error=response.message or "server returned failure")
            except Exception as exc:
                # 6.2 retry classification: a message-size rejection is
                # deterministic — the channel will refuse this exact message
                # on every attempt. Fail immediately with the precise size
                # error; everything else keeps the retry budget.
                if is_message_size_error(exc):
                    logger.error(
                        "Cloud push rejected by gRPC channel (message size): "
                        "session=%s payload=%s error=%s — not retrying",
                        session_id, format_mb(total_bytes), exc,
                    )
                    return CloudPushResult(
                        error=cloud_size_error(total_bytes, CLOUD_PUSH_MAX_PAYLOAD_BYTES)
                    )
                logger.warning(
                    "Cloud push attempt %d/%d failed: session=%s error=%s",
                    attempt + 1, max_retries, session_id, exc,
                )
                if attempt < max_retries - 1:
                    time.sleep(2 ** attempt)  # Exponential backoff: 1s, 2s
                else:
                    logger.error(
                        "Cloud push failed after %d attempts: session=%s wall=%.1fs",
                        max_retries, session_id, time.monotonic() - started,
                    )
                    return CloudPushResult(error=f"{type(exc).__name__}: {exc}")
    finally:
        lock.release()


def delete_page(user_id: str, page_id: str) -> CloudDeleteResult:
    """Delete an archived page from the archive service (opt-in, D2).

    Thin synchronous wrapper over ``ArchiveService.DeletePage`` reusing the
    same mTLS channel/identity conventions as ``push_to_archive``. Single
    attempt with a short unary deadline — the caller owns any retry policy
    (a repeated delete is idempotent). A page that is already gone maps to
    deleted success: the archive service signals a missing/foreign page both
    as a NOT_FOUND abort and as ``success=False, message="not found"``
    (servicer DeletePage), and both shapes are idempotent success here.

    Args:
        user_id: PagePocket user ID owning the page (session's cloud identity,
            verified to match the calling client's binding by the caller)
        page_id: Cloud archive page ID to delete

    Returns:
        CloudDeleteResult with deleted=True on success (including
        already-deleted) or error details on failure.
    """
    _ensure_proto_path()
    stub = _get_stub()
    if stub is None:
        return CloudDeleteResult(error="Archive service not configured")

    import archive_pb2

    request = archive_pb2.DeletePageRequest(user_id=user_id, page_id=page_id)
    try:
        response = stub.DeletePage(request, timeout=DELETE_TIMEOUT_SECONDS)
    except Exception as exc:
        code, _text = _rpc_error_parts(exc)
        if code == "NOT_FOUND":
            logger.info(
                "Cloud delete: page already absent: user=%s page=%s",
                user_id, page_id,
            )
            return CloudDeleteResult(deleted=True)
        logger.warning(
            "Cloud delete failed: user=%s page=%s error=%s", user_id, page_id, exc,
        )
        return CloudDeleteResult(error=f"{type(exc).__name__}: {exc}")

    if response.success:
        logger.info("Cloud delete succeeded: user=%s page=%s", user_id, page_id)
        return CloudDeleteResult(deleted=True)
    if "not found" in (response.message or "").lower():
        logger.info(
            "Cloud delete: page already absent: user=%s page=%s",
            user_id, page_id,
        )
        return CloudDeleteResult(deleted=True)
    return CloudDeleteResult(error=response.message or "server returned failure")


def is_configured() -> bool:
    """Check if archive service is configured."""
    return bool(os.environ.get("ARCHIVE_SERVICE_ADDR", ""))


def validate_config() -> list[str]:
    """Validate archive service config. Returns list of warnings.

    mTLS certs are optional — plaintext mode is allowed for local dev.
    Only file-existence checks are errors (when cert env vars ARE set).
    """
    errors = []
    addr = os.environ.get("ARCHIVE_SERVICE_ADDR", "")
    if not addr:
        return errors  # Not configured is fine (feature is optional)

    cert_env = {
        "ARCHIVE_CA_CERT": os.environ.get("ARCHIVE_CA_CERT", ""),
        "ARCHIVE_CLIENT_KEY": os.environ.get("ARCHIVE_CLIENT_KEY", ""),
        "ARCHIVE_CLIENT_CERT": os.environ.get("ARCHIVE_CLIENT_CERT", ""),
    }
    any_cert_set = any(v for v in cert_env.values())

    if any_cert_set:
        # If any cert is provided, all three must be present and valid
        for env_var, path in cert_env.items():
            if not path:
                errors.append(f"{env_var} is required when other cert paths are set")
            elif not os.path.isfile(path):
                errors.append(f"{env_var}={path} does not exist or is not readable")
    # else: no certs configured — plaintext mode for local dev, no error

    return errors
