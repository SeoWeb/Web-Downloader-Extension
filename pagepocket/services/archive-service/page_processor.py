"""HTML sanitisation and asset rewriting."""

import re

from bs4 import BeautifulSoup

_STRIP_PREFIX = re.compile(r"^\./+")


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
            if not val:
                continue

            # Normalize: strip ./ prefix, query strings
            normalized = _STRIP_PREFIX.sub("", val)
            normalized = normalized.split("?")[0]
            if not normalized:
                continue

            # Try full normalized path first (e.g., "images/foo.jpg")
            if normalized in asset_map:
                tag[attr] = asset_map[normalized]
                continue

            # Fallback: try basename only (e.g., "foo.jpg")
            basename = normalized.rsplit("/", 1)[-1]
            if basename in asset_map:
                tag[attr] = asset_map[basename]

    rewritten = str(soup).encode("utf-8")

    # Extract plain text
    text_soup = BeautifulSoup(html_bytes, "lxml")
    for tag in text_soup(["script", "style", "noscript"]):
        tag.decompose()
    body_text = text_soup.get_text(separator=" ", strip=True)
    preview_text = body_text[:500]

    return rewritten, preview_text, body_text
