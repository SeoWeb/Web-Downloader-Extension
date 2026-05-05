"""HTML sanitisation and asset rewriting."""

from bs4 import BeautifulSoup
import re


def sanitise_and_rewrite(html_bytes: bytes, asset_map: dict[str, str]) -> tuple[bytes, str, str]:
    """Rewrite asset references in HTML and extract text.

    Args:
        html_bytes: Raw HTML content
        asset_map: Mapping of original filename -> new relative path

    Returns:
        (rewritten_html, preview_text, body_text)
    """
    soup = BeautifulSoup(html_bytes, "lxml")

    # Rewrite src/href in tags that reference assets
    for tag in soup.find_all(["img", "script", "link", "source", "video", "audio"]):
        for attr in ["src", "href", "data-src"]:
            val = tag.get(attr)
            if val:
                basename = val.rsplit("/", 1)[-1].split("?")[0]
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
