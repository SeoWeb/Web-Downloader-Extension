"""Shared response headers for routes serving archived content.

Implements the `archived-html-serving` header requirements so every serving
route (gateway file routes now; share/archive routers as they adopt it) emits
an identical, sandboxing header set:

- ``Content-Security-Policy: sandbox allow-popups allow-forms`` — deliberately
  WITHOUT ``allow-same-origin``, so archived documents get no origin privilege
  on pagepocket.app.
- ``X-Content-Type-Options: nosniff`` — prevents MIME confusion.
- A pinned ``Content-Type`` (the stored type; textual types pinned to utf-8).
- ``Referrer-Policy: no-referrer`` on HTML responses.
"""

SANDBOX_CSP = "sandbox allow-popups allow-forms"

# Extension → content-type map, shared by every file-serving route. The map
# itself (and the image-extension set used by archive-service's gallery
# listing) lives in shared/content_types.py — the canonical cross-service
# source (gallery-lightbox added .avif → image/avif there). Re-exported here
# so the gateway's `from serving import ...` imports stay unchanged.
from content_types import (  # shared/ is on the import path
    CONTENT_TYPE_MAP,  # noqa: F401  -- re-export for gateway file routes
    DEFAULT_CONTENT_TYPE,
    content_type_for_path,  # noqa: F401  -- re-export for gateway file routes
)


def pin_content_type(content_type: str) -> str:
    """Normalize a stored/served content type; textual types pin utf-8."""
    pinned = (content_type or "").strip() or DEFAULT_CONTENT_TYPE
    media_type = pinned.split(";", 1)[0].strip().lower()
    if media_type in ("text/html", "text/markdown", "text/plain") and (
        "charset=" not in pinned.lower()
    ):
        pinned = f"{media_type}; charset=utf-8"
    return pinned


def sandbox_headers(content_type: str) -> dict[str, str]:
    """Mandatory headers for any response serving archived HTML or assets.

    The returned dict includes the pinned Content-Type; when passed to a
    Starlette ``Response`` alongside ``media_type``, the explicit header wins,
    guaranteeing the client never sees a sniffed type.
    """
    headers = {
        "Content-Security-Policy": SANDBOX_CSP,
        "X-Content-Type-Options": "nosniff",
        "Content-Type": pin_content_type(content_type),
    }
    if headers["Content-Type"].split(";", 1)[0].strip().lower() == "text/html":
        headers["Referrer-Policy"] = "no-referrer"
    return headers
