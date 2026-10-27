"""Canonical content-type mapping for archived files (single source of truth).

Shared by the api-gateway's serving helpers (``services/api-gateway/serving.py``
re-exports this map for its file routes) and by archive-service's image-gallery
listing (``ListPageImages``), so every service classifies extensions
identically without any cross-service import. Lives in shared/ per the
pagepocket convention for cross-service modules (cache, db, r2_utils, ...).
"""

# Extension → content-type map (gallery-lightbox: + .avif → image/avif).
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
    ".avif": "image/avif",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wasm": "application/wasm",
}

DEFAULT_CONTENT_TYPE = "application/octet-stream"

# Image subset of CONTENT_TYPE_MAP (gallery-lightbox): the extensions
# ListPageImages accepts, leading dot + lower-case. .avif rides along so
# modern gallery pushes surface in the lightbox too.
IMAGE_EXTENSIONS = frozenset({
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico", ".avif",
})


def content_type_for_path(file_path: str) -> str:
    """Pin a content type from the archive-relative path's extension."""
    ext = file_path.rsplit(".", 1)[-1].lower() if "." in file_path else ""
    return CONTENT_TYPE_MAP.get(f".{ext}", DEFAULT_CONTENT_TYPE)
