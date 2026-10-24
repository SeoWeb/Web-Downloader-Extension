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

# Extension → content-type map, shared by every file-serving route (previously
# duplicated in routers/archive.py and routers/share.py).
CONTENT_TYPE_MAP: dict[str, str] = {
    ".html": "text/html; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript",
    ".json": "application/json",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wasm": "application/wasm",
}

DEFAULT_CONTENT_TYPE = "application/octet-stream"


def content_type_for_path(file_path: str) -> str:
    """Pin a content type from the archive-relative path's extension."""
    ext = file_path.rsplit(".", 1)[-1].lower() if "." in file_path else ""
    return CONTENT_TYPE_MAP.get(f".{ext}", DEFAULT_CONTENT_TYPE)


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
