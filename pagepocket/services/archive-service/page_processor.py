"""HTML sanitisation and asset rewriting."""

import re

from bs4 import BeautifulSoup

_STRIP_PREFIX = re.compile(r"^\./+")
# URLs that must never be rewritten to archive-relative paths.
_EXTERNAL_PREFIXES = ("http://", "https://", "//", "data:", "blob:", "mailto:", "tel:")

# ---------------------------------------------------------------------------
# Sanitisation policy (archived-html-serving / D6 layer 1):
# - <script> elements are removed entirely;
# - every `on*` event-handler attribute is stripped from all elements;
# - URI-bearing attributes (href, src, action, formaction, xlink:href) with a
#   `javascript:` or `data:text/html` value are neutralised (rewritten to an
#   inert "#" for link-class attributes, dropped for src);
# - other `data:` URIs are allowed — archived pages legitimately embed
#   inline data:image/* payloads;
# - `srcdoc` embeds are dropped (HTML-in-HTML vector from the audit).
# Comparison normalises case and strips whitespace/control characters, so
# evasions like "JaVaScRiPt:" or "java\tscript:" are caught.
# ---------------------------------------------------------------------------
_URI_ATTRS = ("href", "src", "action", "formaction", "xlink:href")
_URI_ATTRS_REWRITE_TO_INERT = ("href", "action", "formaction", "xlink:href")
_CONTROL_AND_WS = re.compile(r"[\x00-\x20\x7f]")


def _is_dangerous_uri(value: str) -> bool:
    """True for javascript: and data:text/html URIs (evasion-normalised)."""
    normalized = _CONTROL_AND_WS.sub("", value).lower()
    return normalized.startswith(("javascript:", "data:text/html"))


def _sanitize_elements(soup) -> None:
    """Strip event handlers, dangerous URIs, and srcdoc embeds in place."""
    for tag in soup.find_all(True):
        # on* event handlers: nothing legitimate starts with "on".
        for attr in [a for a in tag.attrs if a.lower().startswith("on")]:
            del tag.attrs[attr]

        # srcdoc embeds a full HTML document — dropped outright.
        if "srcdoc" in tag.attrs:
            del tag.attrs["srcdoc"]

        for attr in _URI_ATTRS:
            val = tag.get(attr)
            if not isinstance(val, str) or not _is_dangerous_uri(val):
                continue
            if attr in _URI_ATTRS_REWRITE_TO_INERT:
                tag.attrs[attr] = "#"  # inert value, element content preserved
            else:
                del tag.attrs[attr]


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

    # Strip event handlers, javascript:/data:text/html URIs, and srcdoc
    # embeds from everything that remains (D6 layer 1 — runs BEFORE the
    # HTML is persisted, so no stored page contains executable payload).
    _sanitize_elements(soup)

    rewritten = str(soup).encode("utf-8")

    # Extract plain text
    text_soup = BeautifulSoup(html_bytes, "lxml")
    for tag in text_soup(["script", "style", "noscript"]):
        tag.decompose()
    body_text = text_soup.get_text(separator=" ", strip=True)
    preview_text = body_text[:500]

    return rewritten, preview_text, body_text
