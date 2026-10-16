"""Bounded request-size validation for file-accepting routes.

Shared helper for the ingest route's multipart cap (tasks 4.4 / spec
"Bounded request buffering"): a content-length pre-check plus bounded reads so
a single upload can never buffer unboundedly in RAM, regardless of the gRPC
channel limit.

NOTE: the ingest route in ``routers/archive.py`` consumes these primitives and
adds the cumulative (html + all assets) bound and the asset-count cap on top.
"""

import os

# Matches the gateway/archive gRPC channel limit (256 MB): the body cap bounds
# what the gateway accepts at the HTTP layer before buffering.
DEFAULT_MAX_UPLOAD_BYTES = 256 * 1024 * 1024

READ_CHUNK_SIZE = 1024 * 1024

MAX_UPLOAD_BYTES_ENV = "MAX_UPLOAD_BYTES"

# Cumulative ingest bound (D2): the number of asset parts an ingest request
# may carry, on top of the shared byte cap for html + all assets.
MAX_INGEST_ASSETS_ENV = "MAX_INGEST_ASSETS"
DEFAULT_MAX_INGEST_ASSETS = 200


class PayloadTooLarge(Exception):
    """Raised when a request body exceeds the configured cap."""


def max_upload_bytes() -> int:
    """Configured upload cap (MAX_UPLOAD_BYTES env, default 256 MB)."""
    raw = os.environ.get(MAX_UPLOAD_BYTES_ENV, "").strip()
    if not raw:
        return DEFAULT_MAX_UPLOAD_BYTES
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_MAX_UPLOAD_BYTES
    return value if value > 0 else DEFAULT_MAX_UPLOAD_BYTES


def max_ingest_assets(raw: str | None = None) -> int:
    """Configured asset-count cap for ingest (MAX_INGEST_ASSETS, default 200)."""
    source = os.environ.get(MAX_INGEST_ASSETS_ENV) if raw is None else raw
    if not source or not source.strip():
        return DEFAULT_MAX_INGEST_ASSETS
    try:
        value = int(source)
    except ValueError:
        return DEFAULT_MAX_INGEST_ASSETS
    return value if value > 0 else DEFAULT_MAX_INGEST_ASSETS


def content_length_exceeds(content_length: int | None, max_bytes: int) -> bool:
    """Cheap pre-check on the declared Content-Length (before reading)."""
    return content_length is not None and content_length > max_bytes


async def read_bounded(file, max_bytes: int, chunk_size: int = READ_CHUNK_SIZE) -> bytes:
    """Read an async upload enforcing ``max_bytes`` with bounded chunk reads.

    Raises PayloadTooLarge as soon as the cap is exceeded, so oversized bodies
    are rejected without being fully buffered.
    """
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(chunk_size)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise PayloadTooLarge(f"Upload exceeds the {max_bytes} byte cap")
        chunks.append(chunk)
    return b"".join(chunks)
