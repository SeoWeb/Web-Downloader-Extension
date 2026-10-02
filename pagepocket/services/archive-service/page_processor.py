"""HTML sanitisation and asset rewriting."""

import re

from bs4 import BeautifulSoup

_STRIP_PREFIX = re.compile(r"^\./+")
# URLs that must never be rewritten to archive-relative paths.
_EXTERNAL_PREFIXES = ("http://", "https://", "//", "data:", "blob:", "mailto:", "tel:")


def _rewrite_asset_url(val: str, asset_map: dict[str, str]) -> str | None:
    """Resolve an asset reference to an archive-relative path.

    Returns the rewritten value, or ``None`` if the reference should be left
    untouched (external, anchor, already-correct, or not an asset).
    """
    if not val or val.startswith(_EXTERNAL_PREFIXES) or val.startswith("#"):
        return None

    # Strip query strings and ./ prefix for matching.
    normalized = _STRIP_PREFIX.sub("", val).split("?")[0].split("#")[0]
    if not normalized:
        return None

    # Already-rewritten relative path present in the map.
    if normalized in asset_map:
        mapped = asset_map[normalized]
        return mapped if mapped != normalized else None

    # Root-absolute URL (e.g. "/_next/static/chunks/x.js"): strip the leading
    # slash so it resolves inside the archive folder instead of the host
    # origin. The share/app viewer serves files under the archive path, so a
    # host-root reference would otherwise 404.
    if normalized.startswith("/"):
        rel = normalized.lstrip("/")
        if rel in asset_map:
            return asset_map[rel]
        basename = rel.rsplit("/", 1)[-1]
        if basename in asset_map:
            return asset_map[basename]
        # No stored asset — keep it relative to the archive so the request
        # stays within the archive namespace rather than hitting the host root.
        return rel

    # Document-relative path: try basename match.
    basename = normalized.rsplit("/", 1)[-1]
    if basename in asset_map:
        return asset_map[basename]

    return None


def sanitise_and_rewrite(html_bytes: bytes, asset_map: dict[str, str]) -> tuple[bytes, str, str]:
    """Rewrite asset references in HTML and extract text.

    Args:
        html_bytes: Raw HTML content
        asset_map: Mapping of original filename -> new relative path

    Returns:
        (rewritten_html, preview_text, body_text)
    """
    soup = BeautifulSoup(html_bytes, "lxml")

    # Remove <base> tags — they override relative path resolution
    for base_tag in soup.find_all("base"):
        base_tag.decompose()

    # Rewrite src/href in tags that reference assets
    for tag in soup.find_all(["img", "script", "link", "source", "video", "audio"]):
        for attr in ["src", "href", "data-src"]:
            val = tag.get(attr)
            if not isinstance(val, str):
                continue

            rewritten = _rewrite_asset_url(val, asset_map)
            if rewritten is not None:
                tag[attr] = rewritten

    # Scripts can never run in the sandboxed viewer — remove them to
    # avoid "blocked script execution" console errors and save storage
    for script in soup.find_all("script"):
        script.decompose()

    rewritten = str(soup).encode("utf-8")

    # Extract plain text
    text_soup = BeautifulSoup(html_bytes, "lxml")
    for tag in text_soup(["script", "style", "noscript"]):
        tag.decompose()
    body_text = text_soup.get_text(separator=" ", strip=True)
    preview_text = body_text[:500]

    return rewritten, preview_text, body_text
