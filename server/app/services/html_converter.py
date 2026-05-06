"""HTML Converter Service: URL-to-local-path conversion.

Ports the client-side html-utils/* converters to Python:
  - image-converter.ts   → convert_images
  - background-image-converter.ts → convert_background_images (any CSS url())
  - script-converter.ts  → convert_scripts
  - style-converter.ts   → convert_stylesheets
  - link-converter.ts    → convert_links
  - object-converter.ts  → convert_object_elements

Additional server-side capabilities:
  - CSS file url() rewriting (standalone .css files stored in styles/)
  - Linked-page path prefix (../images/, ../styles/, etc.)
  - Lazy-load attribute handling (data-src, data-lazy-src, etc.)
  - srcset parsing and conversion
  - Inline style url() conversion (any CSS property)

The public entry points are:
  - convert_html(html, tab_url, filename_map, is_linked_page, path)
  - convert_css_file(css_content, tab_url, filename_map, storage_root, session_id)
"""

import base64
import logging
import os
import re
from typing import Optional
from urllib.parse import urlparse

from bs4 import BeautifulSoup, Tag

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Lazy-load attribute names to check for image URLs
LAZY_LOAD_ATTRS = [
    "data-src",
    "data-lazy-src",
    "data-original",
    "data-lazy",
    "data-bg",
    "data-srcset",
]

# Image file extensions (used for extension detection)
IMAGE_EXTENSIONS = {
    "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico",
    "avif", "heic", "heif", "tiff", "tif",
}

# Document file extensions
DOCUMENT_EXTENSIONS = {
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    "odt", "ods", "odp", "rtf", "txt",
}

# Font file extensions
FONT_EXTENSIONS = {
    "woff", "woff2", "ttf", "otf", "eot",
}

# MIME type → extension mapping for images
MIME_TO_IMAGE_EXTENSION = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
    "image/x-ms-bmp": "bmp",
    "image/vnd.microsoft.icon": "ico",
    "image/x-icon": "ico",
    "image/avif": "avif",
    "image/heic": "heic",
    "image/heif": "heic",
    "image/tiff": "tiff",
    "image/x-tiff": "tiff",
}

# Regex for CSS url() references
CSS_URL_PATTERN = re.compile(
    r"""url\(\s*(['"]?)(.*?)\1\s*\)""",
    re.IGNORECASE,
)

# Regex for background-image: url(...) in inline styles / <style> tags
BG_IMAGE_URL_PATTERN = re.compile(
    r"""background-image\s*:\s*url\(\s*['"]?(.*?)['"]?\s*\)""",
    re.IGNORECASE,
)

# Regex for @font-face src: url(...) patterns
FONT_FACE_SRC_PATTERN = re.compile(
    r"""@font-face\s*\{[^}]*src\s*:\s*[^;]*url\(\s*['"]?(.*?)['"]?\s*\)""",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# Utility helpers (ports of urlUtils.ts functions)
# ---------------------------------------------------------------------------


def fix_filename(filename: str) -> str:
    """Sanitize a filename, preserving a valid extension if present.

    Port of fixFilename from urlUtils.ts.
    """
    if not filename or not isinstance(filename, str):
        return "unknown_file"

    # Remove query parameters and fragments
    clean = filename.split("?")[0].split("#")[0]

    # Check if filename has a recognizable extension
    last_dot = clean.rfind(".")
    has_valid_ext = (
        last_dot > 0
        and 0 < len(clean) - last_dot - 1 <= 10
    )

    if has_valid_ext:
        ext = clean[last_dot + 1:]
        name = clean[:last_dot]
        clean_name = _sanitize_name(name) or "file"
        return f"{clean_name}.{ext.lower()}"

    # No valid extension — sanitize whole name and add .bin
    clean_name = _sanitize_name(clean) or "file"
    return f"{clean_name}.bin"


def _get_query_hash(url_src: str) -> str:
    """Extract a short deterministic DJB2 hash from the query string of a URL.

    Port of getQueryHash from urlUtils.ts. Returns an 8-char zero-padded hex
    string, or empty string if there is no query string.
    """
    try:
        if url_src.startswith("//"):
            url_src = "https:" + url_src
        parsed = urlparse(url_src)
        query = parsed.query
        # Prepend '?' to match TypeScript's url.search which includes it
        search = "?" + query if query else ""
        if not search or len(search) <= 1:
            return ""
        h = 5381
        for ch in search:
            h = ((h << 5) + h + ord(ch)) & 0xFFFFFFFF
        return f"{h & 0xFFFFFFFF:08x}"
    except Exception:
        return ""


def _sanitize_name(name: str) -> str:
    """Sanitize a filename stem: remove unsafe chars, collapse dashes."""
    return (
        re.sub(r"^-+|-+$", "", re.sub(r"-+", "-",
            re.sub(r"""[\/\\:*?"<>|&$@!%#^+={}\[\]~]""", "-", name)))
        [:100]
    ) or ""


def generate_page_filename(url: str) -> str:
    """Generate a deterministic filename for a linked page from its URL.

    Port of generateFilename() from linked-page-scraper.ts.

    Algorithm:
      1. Parse the URL and extract the last path segment.
      2. If the last segment is empty (root URL like ``/``), use ``page``.
      3. Remove query parameters and fragments.
      4. Append ``.html`` if the name does not already end with it.
      5. Sanitize with :func:`fix_filename`.

    Args:
        url: The linked page's full URL.

    Returns:
        A sanitized filename string (e.g. ``about.html``, ``team.html``).
    """
    if not url or not isinstance(url, str):
        return "page.html"

    try:
        parsed = urlparse(url)
        pathname = parsed.path
    except Exception:
        return "page.html"

    # Extract the last path segment
    segments = [s for s in pathname.split("/") if s]
    last_segment = segments[-1] if segments else "page"

    # Remove query params and fragments (defensive — urlparse already strips these)
    last_segment = last_segment.split("?")[0].split("#")[0]

    if not last_segment:
        last_segment = "page"

    # Ensure .html extension
    if not last_segment.lower().endswith(".html"):
        last_segment = f"{last_segment}.html"

    return fix_filename(last_segment)


def generate_image_filename(url_src: str, content_type: Optional[str] = None, original_url: Optional[str] = None) -> str:
    """Generate a consistent image filename from a URL.

    Port of generateImageFilename from urlUtils.ts.
    """
    if not url_src or not isinstance(url_src, str):
        return "image.bin"

    # Remove query parameters and fragments
    clean_url = url_src.split("?")[0].split("#")[0]

    # Try to extract pathname
    try:
        if clean_url.startswith(("http://", "https://", "//")):
            parsed = urlparse(clean_url if not clean_url.startswith("//") else "https:" + clean_url)
            pathname = parsed.path
        else:
            pathname = clean_url
    except Exception:
        pathname = clean_url

    # Get the last path segment
    segments = [s for s in pathname.split("/") if s]
    last_segment = segments[-1] if segments else "image"

    # Check if the last segment has a valid image extension
    dot_index = last_segment.rfind(".")
    if dot_index > 0:
        ext = last_segment[dot_index + 1:].lower()
        if ext in IMAGE_EXTENSIONS:
            if len(segments) > 1:
                full_path = "_".join(segments)
                return fix_filename(full_path)
            return fix_filename(last_segment)

    # No image extension — generate deterministic name from full path
    full_path = "_".join(segments)
    sanitized = _sanitize_name(full_path)[:150] or "image"

    # Determine extension from Content-Type if available
    extension = "bin"
    if content_type:
        clean_mime = content_type.split(";")[0].strip().lower()
        ext = MIME_TO_IMAGE_EXTENSION.get(clean_mime)
        if ext:
            extension = ext

    # Append query hash to match extension-side filename generation
    query_hash = _get_query_hash(original_url or url_src)

    return f"{sanitized}_{query_hash}.{extension}" if query_hash else f"{sanitized}.{extension}"


def _resolve_url(url: str, tab_url: str) -> str:
    """Resolve a potentially-relative URL against the tab's base URL.

    Returns the resolved absolute URL, or the original URL on failure.
    """
    if not url:
        return url
    try:
        if url.startswith(("http://", "https://")):
            return url
        if url.startswith("//"):
            return "https:" + url
        # Relative URL — resolve against tab origin
        tab_origin = urlparse(tab_url)
        base = f"{tab_origin.scheme}://{tab_origin.netloc}"
        if url.startswith("/"):
            return base + url
        # Path-relative
        path = tab_origin.path.rsplit("/", 1)[0] if "/" in tab_origin.path else ""
        return base + path + "/" + url
    except Exception:
        return url


def _get_origin(url: str) -> str:
    """Extract origin (scheme + host) from a URL."""
    try:
        parsed = urlparse(url)
        return f"{parsed.scheme}://{parsed.netloc}"
    except Exception:
        return ""


def _has_extension(path: str) -> bool:
    """Check if a path has a file extension (dot followed by chars)."""
    last_dot = path.rfind(".")
    if last_dot < 0:
        return False
    # Must have at least one char after dot and not be just a dot at end
    return last_dot < len(path) - 1


# ---------------------------------------------------------------------------
# Image URL conversion (5.1 + 5.2 + 5.3)
# ---------------------------------------------------------------------------


def _convert_images(
    soup: BeautifulSoup,
    tab_url: str,
    path: str = "./",
    filename_map: Optional[dict[str, str]] = None,
    content_type_map: Optional[dict[str, str]] = None,
    filename_ext_map: Optional[dict[str, str]] = None,
) -> None:
    """Convert image URLs in HTML to relative local paths (mutates soup in-place).

    Port of convertImagesToRelative from image-converter.ts, with added
    support for:
      - Lazy-load attributes (data-src, data-lazy-src, etc.)   [5.2]
      - srcset parsing and conversion                           [5.3]

    The filename_map maps original URLs → local filenames (e.g.
    "https://example.com/img/photo.jpg" → "images/photo.jpg").
    """
    # --- <img> elements ---
    for img in soup.find_all("img"):
        _convert_img_src(img, tab_url, path, filename_map, content_type_map, filename_ext_map)
        _convert_lazy_load_attrs(img, tab_url, path, filename_map, content_type_map, filename_ext_map)
        _convert_srcset(img, "srcset", tab_url, path, filename_map, content_type_map, filename_ext_map)

    # --- <picture><source> elements ---
    for source in soup.find_all("source"):
        if source.get("srcset"):
            _convert_srcset(source, "srcset", tab_url, path, filename_map, content_type_map, filename_ext_map)
        # Handle <source src="..."> (used in older browsers and video contexts)
        src = source.get("src")
        if src and isinstance(src, str) and not src.startswith("data:"):
            mapped = _lookup_filename_map(src, tab_url, filename_map)
            if mapped:
                source["src"] = path + mapped
            else:
                clean = src.split("?")[0]
                # Extract path component to check for extension (avoid matching
                # dots in the hostname like "cdn.example.com")
                try:
                    if clean.startswith(("http://", "https://")):
                        parsed = urlparse(clean)
                        clean_path = parsed.path
                    else:
                        clean_path = clean
                except Exception:
                    clean_path = clean
                if _has_extension(clean_path):
                    filename = clean_path.split("/")[-1]
                    source["src"] = path + "images/" + filename
                else:
                    ct = _lookup_content_type(src, tab_url, content_type_map)
                    filename = generate_image_filename(clean, ct, original_url=src)
                    filename = _maybe_fix_bin_extension(filename, filename_ext_map)
                    source["src"] = path + "images/" + filename


def _lookup_filename_map(
    url: str, tab_url: str, filename_map: Optional[dict[str, str]]
) -> Optional[str]:
    """Try to find a URL in the filename map.

    Tries:
      1. Original URL as-is
      2. URL with query params stripped
      3. URL resolved to full absolute URL
    """
    if not filename_map:
        return None

    # 1. Exact match
    mapped = filename_map.get(url)
    if mapped:
        return mapped

    # 2. Without query params
    clean = url.split("?")[0].split("#")[0]
    mapped = filename_map.get(clean)
    if mapped:
        return mapped

    # 3. Resolve to full URL and try matching
    full_url = _resolve_url(url, tab_url)
    if full_url != url:
        mapped = filename_map.get(full_url)
        if mapped:
            return mapped
        # Also try the clean version of the full URL
        clean_full = full_url.split("?")[0].split("#")[0]
        mapped = filename_map.get(clean_full)
        if mapped:
            return mapped

    return None


def _lookup_content_type(
    url: str, tab_url: str, content_type_map: Optional[dict[str, str]]
) -> Optional[str]:
    """Try to find a URL's content-type in the content-type map.

    Uses the same multi-strategy lookup as _lookup_filename_map.
    """
    if not content_type_map:
        return None

    # 1. Exact match
    ct = content_type_map.get(url)
    if ct:
        return ct

    # 2. Without query params
    clean = url.split("?")[0].split("#")[0]
    ct = content_type_map.get(clean)
    if ct:
        return ct

    # 3. Resolve to full URL and try matching
    full_url = _resolve_url(url, tab_url)
    if full_url != url:
        ct = content_type_map.get(full_url)
        if ct:
            return ct
        clean_full = full_url.split("?")[0].split("#")[0]
        ct = content_type_map.get(clean_full)
        if ct:
            return ct

    return None


def _convert_img_src(
    img: Tag, tab_url: str, path: str,
    filename_map: Optional[dict[str, str]],
    content_type_map: Optional[dict[str, str]] = None,
    filename_ext_map: Optional[dict[str, str]] = None,
) -> None:
    """Convert an <img> element's src attribute to a local path."""
    src = img.get("src")
    if not src or not isinstance(src, str):
        return

    original_src = src
    # Strip query params for matching
    clean_src = src.split("?")[0]

    # Check filename map first
    mapped = _lookup_filename_map(original_src, tab_url, filename_map)
    if mapped:
        img["src"] = path + mapped
        return

    # Fallback: generate filename from URL
    origin = _get_origin(tab_url)
    base_url = origin + "/"

    if clean_src.startswith("/") or clean_src.startswith("#"):
        # Already relative / anchor
        pass
    elif clean_src.startswith(base_url):
        try:
            parsed = urlparse(clean_src)
            clean_src = parsed.path + parsed.query + parsed.fragment
        except Exception:
            pass
    elif clean_src.startswith(("http://", "https://")):
        # External URL — try to extract pathname
        try:
            parsed = urlparse(clean_src)
            clean_src = parsed.path
        except Exception:
            pass

    filename = generate_image_filename(
        clean_src, _lookup_content_type(original_src, tab_url, content_type_map),
        original_url=original_src,
    )
    filename = _maybe_fix_bin_extension(filename, filename_ext_map)
    img["src"] = path + "images/" + filename


def _convert_lazy_load_attrs(
    img: Tag, tab_url: str, path: str,
    filename_map: Optional[dict[str, str]],
    content_type_map: Optional[dict[str, str]] = None,
    filename_ext_map: Optional[dict[str, str]] = None,
) -> None:
    """Convert lazy-load attributes (data-src, data-lazy-src, etc.) [5.2]."""
    for attr in LAZY_LOAD_ATTRS:
        value = img.get(attr)
        if not value or not isinstance(value, str):
            continue

        # For data-srcset, use srcset parsing
        if attr == "data-srcset":
            _convert_srcset_attr_value(img, attr, tab_url, path, filename_map, content_type_map, filename_ext_map)
            continue

        original = value
        mapped = _lookup_filename_map(original, tab_url, filename_map)
        if mapped:
            img[attr] = path + mapped
        else:
            clean = value.split("?")[0]
            ct = _lookup_content_type(original, tab_url, content_type_map)
            filename = generate_image_filename(clean, ct, original_url=original)
            filename = _maybe_fix_bin_extension(filename, filename_ext_map)
            img[attr] = path + "images/" + filename


def _convert_srcset(
    element: Tag, attr: str, tab_url: str, path: str,
    filename_map: Optional[dict[str, str]],
    content_type_map: Optional[dict[str, str]] = None,
    filename_ext_map: Optional[dict[str, str]] = None,
) -> None:
    """Parse and convert a srcset attribute. [5.3]"""
    value = element.get(attr)
    if not value or not isinstance(value, str):
        return
    _convert_srcset_attr_value(element, attr, tab_url, path, filename_map, content_type_map, filename_ext_map)


def _convert_srcset_attr_value(
    element: Tag, attr: str, tab_url: str, path: str,
    filename_map: Optional[dict[str, str]],
    content_type_map: Optional[dict[str, str]] = None,
    filename_ext_map: Optional[dict[str, str]] = None,
) -> None:
    """Convert URLs within a srcset attribute value.

    srcset format: "url1 descriptor1, url2 descriptor2, ..."
    e.g. "image.jpg 1x, image@2x.jpg 2x"
         "image.webp 300w, image@2x.webp 600w"
    """
    value = element.get(attr)
    if not value or not isinstance(value, str):
        return

    entries = []
    for entry in value.split(","):
        entry = entry.strip()
        if not entry:
            continue

        parts = entry.split(None, 1)
        url = parts[0]
        descriptor = parts[1] if len(parts) > 1 else ""

        if url.startswith("data:"):
            entries.append(entry)
            continue

        mapped = _lookup_filename_map(url, tab_url, filename_map)
        if mapped:
            new_url = path + mapped
        else:
            clean = url.split("?")[0]
            ct = _lookup_content_type(url, tab_url, content_type_map)
            filename = generate_image_filename(clean, ct, original_url=url)
            filename = _maybe_fix_bin_extension(filename, filename_ext_map)
            new_url = path + "images/" + filename

        if descriptor:
            entries.append(f"{new_url} {descriptor}")
        else:
            entries.append(new_url)

    if entries:
        element[attr] = ", ".join(entries)


# ---------------------------------------------------------------------------
# Inline style url() conversion (5.4)
# ---------------------------------------------------------------------------


def _convert_background_images(
    soup: BeautifulSoup,
    tab_url: str,
    path: str = "./",
    filename_map: Optional[dict[str, str]] = None,
    content_type_map: Optional[dict[str, str]] = None,
    filename_ext_map: Optional[dict[str, str]] = None,
) -> None:
    """Convert url() references in inline styles and <style> tags (mutates soup in-place).

    Port of convertBackgroundImagesToRelative from background-image-converter.ts.
    Matches any CSS property containing url(), not just background-image.
    """
    # Process inline styles with background images
    for element in soup.find_all(attrs={"style": re.compile(r"url\(", re.IGNORECASE)}):
        style = element.get("style", "")
        updated = _convert_bg_image_urls(style, tab_url, path, filename_map, content_type_map, filename_ext_map)
        element["style"] = updated

    # Process <style> tags
    for style_tag in soup.find_all("style"):
        css = style_tag.string or ""
        updated = _convert_bg_image_urls(css, tab_url, path, filename_map, content_type_map, filename_ext_map)
        style_tag.string = updated


def _convert_bg_image_urls(
    css_content: str,
    tab_url: str,
    path: str = "./",
    filename_map: Optional[dict[str, str]] = None,
    content_type_map: Optional[dict[str, str]] = None,
    filename_ext_map: Optional[dict[str, str]] = None,
) -> str:
    """Convert url() patterns in CSS content to relative local paths."""
    def _replace_bg_url(match: re.Match) -> str:
        image_url = match.group(2).strip()
        if not image_url or image_url.startswith("data:") or image_url.startswith("#"):
            return match.group(0)

        # Try filename map first
        mapped = _lookup_filename_map(image_url, tab_url, filename_map)
        if mapped:
            return match.group(0).replace(image_url, path + mapped)

        # Try to generate filename
        try:
            if not image_url.startswith("http"):
                # Already relative — extract filename
                filename = image_url.split("/")[-1] if "/" in image_url else image_url
                if filename:
                    generated = generate_image_filename(filename, None, original_url=image_url)
                    generated = _maybe_fix_bin_extension(generated, filename_ext_map)
                    relative = path + "images/" + generated
                    return match.group(0).replace(image_url, relative)

            parsed = urlparse(image_url)
            clean_path = parsed.path
            filename = clean_path.split("/")[-1] if "/" in clean_path else clean_path
            if filename:
                ct = _lookup_content_type(image_url, tab_url, content_type_map)
                if ct:
                    generated = generate_image_filename(clean_path, ct, original_url=image_url)
                    generated = _maybe_fix_bin_extension(generated, filename_ext_map)
                    relative = path + "images/" + generated
                    return match.group(0).replace(image_url, relative)
                if _has_extension(clean_path):
                    relative = path + "images/" + fix_filename(filename)
                    return match.group(0).replace(image_url, relative)
                # No extension and no content-type — generate with query hash
                generated = generate_image_filename(clean_path, None, original_url=image_url)
                generated = _maybe_fix_bin_extension(generated, filename_ext_map)
                relative = path + "images/" + generated
                return match.group(0).replace(image_url, relative)
        except Exception:
            pass

        return match.group(0)

    return CSS_URL_PATTERN.sub(_replace_bg_url, css_content)


# ---------------------------------------------------------------------------
# Script URL conversion (5.5)
# ---------------------------------------------------------------------------


def _convert_scripts(
    soup: BeautifulSoup,
    tab_url: str,
    path: str = "./",
    filename_map: Optional[dict[str, str]] = None,
) -> None:
    """Convert <script src> URLs to relative local paths (mutates soup in-place).

    Port of convertScriptsToRelative from script-converter.ts, with added
    filename_map support for correct resource name lookup.
    """
    for script in soup.find_all("script", src=True):
        src = script.get("src")
        if not src or not isinstance(src, str):
            continue

        original_src = src
        src_clean = src.split("?")[0]
        if not src_clean:
            continue

        # Check filename map first
        mapped = _lookup_filename_map(original_src, tab_url, filename_map)
        if mapped:
            script["src"] = path + mapped
            continue

        # Fallback: derive filename from URL
        origin = _get_origin(tab_url)
        base_url = origin + "/"

        resolved = src_clean
        if resolved.startswith("/") or resolved.startswith("#"):
            pass
        elif resolved.startswith(base_url):
            try:
                parsed = urlparse(resolved)
                resolved = parsed.path
            except Exception:
                pass

        if _has_extension(resolved):
            filename = resolved.split("/")[-1]
            # Strip "undefined" prefix from broken JS-generated URLs
            if filename.startswith("undefined"):
                filename = filename[len("undefined"):] or filename
            script["src"] = path + "scripts/" + filename
        else:
            # Extensionless URL — generate fallback filename with .js extension
            segment = resolved.split("/")[-1] if "/" in resolved else resolved
            if segment:
                if segment.startswith("undefined"):
                    segment = segment[len("undefined"):] or segment
                script["src"] = path + "scripts/" + fix_filename(segment) + ".js"


# ---------------------------------------------------------------------------
# Stylesheet URL conversion (5.6)
# ---------------------------------------------------------------------------


def _convert_stylesheets(
    soup: BeautifulSoup,
    tab_url: str,
    path: str = "./",
    filename_map: Optional[dict[str, str]] = None,
) -> None:
    """Convert <link rel="stylesheet" href> URLs to relative local paths (mutates soup in-place).

    Port of convertStylesToRelative from style-converter.ts, with added
    filename_map support for correct resource name lookup.
    """
    for link in soup.find_all("link", rel="stylesheet"):
        href = link.get("href")
        if not href or not isinstance(href, str):
            continue

        original_href = href
        href_clean = href.split("?")[0]
        if not href_clean:
            continue

        # Check filename map first
        mapped = _lookup_filename_map(original_href, tab_url, filename_map)
        if mapped:
            link["href"] = path + mapped
            continue

        # Fallback: derive filename from URL
        origin = _get_origin(tab_url)
        base_url = origin + "/"

        resolved = href_clean
        if resolved.startswith("/") or resolved.startswith("#"):
            pass
        elif resolved.startswith(base_url):
            try:
                parsed = urlparse(resolved)
                resolved = parsed.path
            except Exception:
                pass

        if _has_extension(resolved):
            filename = resolved.split("/")[-1]
            # Strip "undefined" prefix from broken JS-generated URLs
            if filename.startswith("undefined"):
                filename = filename[len("undefined"):] or filename
            link["href"] = path + "styles/" + filename
        else:
            # Extensionless URL — generate fallback filename with .css extension
            segment = resolved.split("/")[-1] if "/" in resolved else resolved
            if segment:
                if segment.startswith("undefined"):
                    segment = segment[len("undefined"):] or segment
                link["href"] = path + "styles/" + fix_filename(segment) + ".css"


# ---------------------------------------------------------------------------
# Link URL conversion (5.7)
# ---------------------------------------------------------------------------


def _convert_links(
    soup: BeautifulSoup,
    tab_url: str,
    path: str = "./",
    page_filename_map: Optional[dict[str, str]] = None,
) -> None:
    """Convert <a href> URLs to local file paths (mutates soup in-place).

    Port of convertLinksToRelative from link-converter.ts.

    - Document links → ./documents/<filename>
    - Same-origin HTML links → ./pages/<filename>.html
    - External links → unchanged
    - Anchor links (#) → unchanged

    Args:
        page_filename_map: Optional mapping of page URL → resolved filename
            (e.g. ``{"https://example.com/about": "about.html"}``).
            When provided, the function looks up the page URL in this map
            to determine the target filename, ensuring consistency with the
            ZIP assembler's deduplicated filenames.
    """
    tab_origin = _get_origin(tab_url)

    for link in soup.find_all("a", href=True):
        href = link.get("href")
        if not href or not isinstance(href, str):
            continue

        # Remove query params and hash for matching
        href_clean = href.split("?")[0].split("#")[0]

        # Skip anchor-only links
        if not href_clean or href.startswith("#"):
            continue

        # Skip external links (different origin)
        if href.startswith(("http://", "https://")):
            try:
                link_origin = _get_origin(href)
                if link_origin != tab_origin:
                    continue  # External link — don't modify
            except Exception:
                continue

        # Normalize the path
        base_url = tab_origin + "/"
        normalized = href_clean
        if href.startswith(base_url):
            try:
                parsed = urlparse(href)
                normalized = parsed.path
            except Exception:
                pass
        elif href.startswith("/"):
            normalized = href_clean

        # Remove leading slash
        if normalized.startswith("/"):
            normalized = normalized[1:]

        # Classify by extension
        path_parts = normalized.split("/")
        doc_match = re.search(
            r"\.(pdf|doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp|rtf|txt)$",
            normalized, re.IGNORECASE,
        )
        img_match = re.search(
            r"\.(gif|jpe?g|tiff?|png|webp|bmp|svg|ico|heic|avif)$",
            normalized, re.IGNORECASE,
        )
        html_match = re.search(r"\.html?$", normalized, re.IGNORECASE)

        if doc_match:
            link["href"] = path + "documents/" + path_parts[-1]
        elif img_match:
            link["href"] = path + "images/" + path_parts[-1]
        elif html_match:
            # Check page_filename_map first for deduplicated filenames
            resolved_url = _resolve_url(href, tab_url)
            if page_filename_map and resolved_url in page_filename_map:
                link["href"] = path + "pages/" + page_filename_map[resolved_url]
            else:
                link["href"] = path + "pages/" + path_parts[-1]
        else:
            # Clean URLs (no extension) — treat as HTML pages
            last_part = path_parts[-1] if path_parts else ""
            if not last_part and len(path_parts) > 1:
                last_part = path_parts[-2]
            if not last_part:
                continue
            # Check page_filename_map first for deduplicated filenames
            resolved_url = _resolve_url(href, tab_url)
            if page_filename_map and resolved_url in page_filename_map:
                link["href"] = path + "pages/" + page_filename_map[resolved_url]
            else:
                link["href"] = path + "pages/" + last_part + ".html"


# ---------------------------------------------------------------------------
# Object element conversion (5.8)
# ---------------------------------------------------------------------------


def _convert_object_elements(
    soup: BeautifulSoup,
    tab_url: str,
    path: str = "./",
) -> None:
    """Convert <object type="image/*" data> URLs to local paths (mutates soup in-place).

    Port of convertObjectElementsToRelative from object-converter.ts.
    """
    for obj in soup.find_all("object"):
        obj_type = obj.get("type", "")
        if not isinstance(obj_type, str) or not obj_type.startswith("image/"):
            continue

        data = obj.get("data")
        if not data or not isinstance(data, str):
            continue

        data = data.split("?")[0]
        if not data:
            continue

        origin = _get_origin(tab_url)
        base_url = origin + "/"

        if data.startswith("/") or data.startswith("#"):
            pass
        elif data.startswith(base_url):
            try:
                parsed = urlparse(data)
                data = parsed.path
            except Exception:
                pass

        if _has_extension(data):
            filename = data.split("/")[-1]
            obj["data"] = path + "images/" + filename


def _remove_base_tag(soup: BeautifulSoup) -> None:
    """Remove <base> tag from the document (prevents browser from using original base URL)."""
    base_tag = soup.find("base")
    if base_tag:
        base_tag.decompose()


# ---------------------------------------------------------------------------
# Linked page HTML conversion (5.9)
# ---------------------------------------------------------------------------


def convert_html_for_linked_page(
    html_string: str,
    tab_url: str,
    filename_map: Optional[dict[str, str]] = None,
    content_type_map: Optional[dict[str, str]] = None,
) -> str:
    """Convert HTML for a linked page stored in pages/ directory.

    Uses ../ path prefix for all resource references:
      - images → ../images/
      - CSS    → ../styles/
      - JS     → ../scripts/
      - docs   → ../documents/
    """
    return convert_html(
        html_string,
        tab_url,
        filename_map=filename_map,
        is_linked_page=True,
        content_type_map=content_type_map,
    )


# ---------------------------------------------------------------------------
# CSS file URL conversion (5.10)
# ---------------------------------------------------------------------------


def _convert_css_file_impl(
    css_content: str,
    tab_url: str,
    filename_map: Optional[dict[str, str]] = None,
    storage_root: Optional[str] = None,
    session_id: Optional[str] = None,
    content_type_map: Optional[dict[str, str]] = None,
    filename_ext_map: Optional[dict[str, str]] = None,
) -> str:
    """Rewrite url() references inside standalone CSS files.

    CSS files live in styles/, so references to images use ../images/
    and references to fonts use ../fonts/.

    Port of convertBackgroundImageUrlsToRelative from css.ts (client-side),
    with server-side additions for font handling and @import rewriting.

    Rules:
      - data: URIs → unchanged
      - Already-relative paths (no http/s) → unchanged
      - Image URLs → ../images/<filename> (with filename map lookup)
      - Font URLs  → ../fonts/<filename> (with filename map lookup)
      - @import URLs → ./<filename> (same directory)
      - Query parameters → stripped before matching
    """
    # 1. Handle @import rules FIRST — replace with placeholders to prevent
    #    the general url() regex from rewriting import URLs as image paths.
    import_placeholder = "__CSSIMPORT{}__"
    import_matches: list[tuple[str, str]] = []  # (placeholder, replacement)

    import_pattern = re.compile(
        r"@import\s+(?:url\(\s*)?['\"]?(.*?)['\"]?(?:\s*\))?\s*;",
        re.IGNORECASE,
    )

    def _capture_import(match: re.Match) -> str:
        url = match.group(1).strip()
        if url.startswith("data:"):
            return match.group(0)

        # Already relative — leave unchanged (no url() to rewrite)
        if not url.startswith(("http://", "https://", "//", "/")):
            return match.group(0)

        clean_url = url.split("?")[0].split("#")[0]

        # Try filename map
        mapped = _lookup_filename_map(url, tab_url, filename_map)
        if not mapped:
            mapped = _lookup_filename_map(clean_url, tab_url, filename_map)

        if mapped:
            # Same directory: extract filename from mapped path
            filename = mapped.split("/")[-1] if "/" in mapped else mapped
            replacement = match.group(0).replace(url, "./" + filename)
        else:
            # External import — preserve original but use placeholder
            # to prevent general url() regex from rewriting it
            replacement = match.group(0)

        idx = len(import_matches)
        placeholder = import_placeholder.format(idx)
        import_matches.append((placeholder, replacement))
        return placeholder

    result = import_pattern.sub(_capture_import, css_content)

    # 2. Process remaining url() references (images, fonts, etc.)
    def _replace_url(match: re.Match) -> str:
        full_match = match.group(0)
        url = match.group(2).strip()

        # Skip data URIs
        if url.startswith("data:"):
            return full_match

        # Skip already-relative paths (no scheme, no leading //)
        if not url.startswith(("http://", "https://", "//", "/")):
            # Already relative — leave unchanged
            return full_match

        # Strip query parameters and hash for matching
        clean_url = url.split("?")[0].split("#")[0]

        # Try filename map lookup
        mapped = _lookup_filename_map(url, tab_url, filename_map)
        if not mapped:
            mapped = _lookup_filename_map(clean_url, tab_url, filename_map)

        if mapped:
            # The filename map value is like "images/photo.jpg" or "fonts/roboto.woff2"
            # Since CSS is in styles/, prefix with ../
            return full_match.replace(url, "../" + mapped)

        # Determine if this is a font or image from the extension
        ext = ""
        if "." in clean_url:
            ext = clean_url.rsplit(".", 1)[-1].lower()

        if ext in FONT_EXTENSIONS:
            filename = clean_url.split("/")[-1]
            filename = fix_filename(filename)
            return full_match.replace(url, "../fonts/" + filename)

        if ext in IMAGE_EXTENSIONS:
            filename = clean_url.split("/")[-1]
            filename = fix_filename(filename)
            return full_match.replace(url, "../images/" + filename)

        # Unknown/missing extension — use content-type map if available
        ct = _lookup_content_type(url, tab_url, content_type_map)
        filename = generate_image_filename(clean_url, ct, original_url=url)
        filename = _maybe_fix_bin_extension(filename, filename_ext_map)
        return full_match.replace(url, "../images/" + filename)

    result = CSS_URL_PATTERN.sub(_replace_url, result)

    # 3. Restore @import placeholders with their replacements
    for placeholder, replacement in import_matches:
        result = result.replace(placeholder, replacement)

    return result





# ---------------------------------------------------------------------------
# Single-file HTML inlining (for task 6.5, but defined here for cohesion)
# ---------------------------------------------------------------------------


def convert_html_to_single_file(
    html_string: str,
    tab_url: str,
    storage_root: str,
    session_id: str,
    filename_map: Optional[dict[str, str]] = None,
    local_path_to_storage: Optional[dict[str, str]] = None,
) -> str:
    """Produce a self-contained HTML file by inlining all resources as base64.

    Reads resource files from disk and inlines them. Missing resources
    are skipped with a warning.

    NOTE: For memory-efficient assembly, prefer write_single_file_to_disk()
    which writes output incrementally instead of returning a giant string.
    """
    soup = _build_single_file_soup(html_string, storage_root, session_id, filename_map, local_path_to_storage)
    return str(soup)


def write_single_file_to_disk(
    html_string: str,
    tab_url: str,
    storage_root: str,
    session_id: str,
    output_path: str,
    filename_map: Optional[dict[str, str]] = None,
    local_path_to_storage: Optional[dict[str, str]] = None,
) -> None:
    """Write a self-contained HTML file to disk with streaming writes.

    Inlines all resources as base64 data URIs, same as
    convert_html_to_single_file, but writes the output incrementally
    to avoid holding both the soup tree and the full serialized string
    in memory simultaneously.

    After inlining resources into the parse tree, each top-level child
    is serialized and written to disk immediately.  The soup tree is
    decomposed after serialization to free memory.

    Args:
        html_string: The merged HTML content.
        tab_url: The original page URL (unused but kept for API parity).
        storage_root: Root directory for session storage.
        session_id: Session identifier.
        output_path: File path to write the output HTML.
        filename_map: Mapping of original URLs → local filenames.
        local_path_to_storage: Mapping of local_path → actual disk path.
    """
    soup = _build_single_file_soup(html_string, storage_root, session_id, filename_map, local_path_to_storage)

    # Free the original HTML string — no longer needed
    del html_string

    # Write each top-level child to disk immediately.
    # This avoids building one giant str(soup) output string on top
    # of the already-large soup tree, cutting peak memory roughly in half
    # for image-heavy pages.
    from bs4 import NavigableString, Doctype, ProcessingInstruction

    with open(output_path, "w", encoding="utf-8") as f:
        for child in soup.children:
            if isinstance(child, Doctype):
                f.write(f"<!{child}>\n")
            elif isinstance(child, (NavigableString, ProcessingInstruction)):
                f.write(str(child))
            elif hasattr(child, "decode"):
                f.write(child.decode())
            else:
                f.write(str(child))

    # Free the soup tree immediately
    soup.decompose()
    del soup


def _build_single_file_soup(
    html_string: str,
    storage_root: str,
    session_id: str,
    filename_map: Optional[dict[str, str]] = None,
    local_path_to_storage: Optional[dict[str, str]] = None,
) -> BeautifulSoup:
    """Parse HTML and inline all resources as base64 data URIs.

    Shared implementation for convert_html_to_single_file() and
    write_single_file_to_disk(). Returns the modified soup tree —
    callers are responsible for serialization and cleanup.
    """
    soup = BeautifulSoup(html_string, "lxml")

    # Inline images
    for img in soup.find_all("img", src=True):
        src = img.get("src", "")
        if src.startswith("data:"):
            continue
        data_uri = _read_resource_as_data_uri(src, storage_root, session_id, filename_map, local_path_to_storage)
        if data_uri:
            img["src"] = data_uri

    # Inline lazy-load attributes
    for img in soup.find_all("img"):
        for attr in LAZY_LOAD_ATTRS:
            val = img.get(attr)
            if val and isinstance(val, str) and not val.startswith("data:"):
                data_uri = _read_resource_as_data_uri(val, storage_root, session_id, filename_map, local_path_to_storage)
                if data_uri:
                    img[attr] = data_uri

    # Inline stylesheets: <link rel="stylesheet"> → <style>
    for link in soup.find_all("link", rel="stylesheet"):
        href = link.get("href", "")
        css_content = _read_text_resource(href, storage_root, session_id, local_path_to_storage)
        if css_content is not None:
            # Rewrite url() references in the CSS content to base64
            css_content = _inline_css_urls(css_content, storage_root, session_id, filename_map, local_path_to_storage)
            style_tag = soup.new_tag("style")
            style_tag.string = css_content
            link.replace_with(style_tag)

    # Inline scripts: <script src> → <script> with content
    for script in soup.find_all("script", src=True):
        src = script.get("src", "")
        js_content = _read_text_resource(src, storage_root, session_id, local_path_to_storage)
        new_script = soup.new_tag("script")
        new_script.string = js_content or ""
        script.replace_with(new_script)

    # Inline object elements with image types
    for obj in soup.find_all("object"):
        obj_type = obj.get("type", "")
        if isinstance(obj_type, str) and obj_type.startswith("image/"):
            data = obj.get("data", "")
            if data and not data.startswith("data:"):
                data_uri = _read_resource_as_data_uri(data, storage_root, session_id, filename_map, local_path_to_storage)
                if data_uri:
                    obj["data"] = data_uri

    # Inline background-image URLs in <style> tags
    for style_tag in soup.find_all("style"):
        css = style_tag.string or ""
        css = _inline_css_urls(css, storage_root, session_id, filename_map, local_path_to_storage)
        style_tag.string = css

    # Inline background-image URLs in inline styles
    for element in soup.find_all(attrs={"style": True}):
        style = element.get("style", "")
        if "url(" in style:
            updated = _inline_style_bg_images(style, storage_root, session_id, filename_map, local_path_to_storage)
            element["style"] = updated

    return soup


def _inline_css_urls(
    css_content: str,
    storage_root: str,
    session_id: str,
    filename_map: Optional[dict[str, str]] = None,
    local_path_to_storage: Optional[dict[str, str]] = None,
) -> str:
    """Inline all url() references in CSS content as base64 data URIs."""

    def _replace(match: re.Match) -> str:
        full_match = match.group(0)
        url = match.group(2).strip()
        if url.startswith("data:"):
            return full_match

        data_uri = _read_resource_as_data_uri(url, storage_root, session_id, filename_map, local_path_to_storage)
        if data_uri:
            return full_match.replace(url, data_uri)
        return full_match

    return CSS_URL_PATTERN.sub(_replace, css_content)


def _inline_style_bg_images(
    style: str,
    storage_root: str,
    session_id: str,
    filename_map: Optional[dict[str, str]] = None,
    local_path_to_storage: Optional[dict[str, str]] = None,
) -> str:
    """Inline url() references in an inline style attribute as base64 data URIs."""

    def _replace(match: re.Match) -> str:
        url = match.group(2).strip()
        if url.startswith("data:"):
            return match.group(0)

        data_uri = _read_resource_as_data_uri(url, storage_root, session_id, filename_map, local_path_to_storage)
        if data_uri:
            return match.group(0).replace(url, data_uri)
        return match.group(0)

    return CSS_URL_PATTERN.sub(_replace, style)


def _resolve_local_path(
    url: str, storage_root: str, session_id: str, filename_map: Optional[dict[str, str]] = None,
    local_path_to_storage: Optional[dict[str, str]] = None,
) -> Optional[str]:
    """Resolve a converted local path to an actual file path on disk.

    Given a path like "./images/photo.jpg" or "../fonts/roboto.woff2",
    find the actual file in the session's storage directory.

    Resources are stored with UUID filenames on disk. The
    local_path_to_storage mapping translates logical paths (e.g.,
    ``styles/main.css``) to actual disk paths (e.g.,
    ``resources/abc-123``). Without it, only human-readable paths work
    (used in tests).
    """
    # Strip leading ./ and ../
    clean = url
    while clean.startswith("./"):
        clean = clean[2:]
    while clean.startswith("../"):
        clean = clean[3:]

    # Primary lookup: explicit local_path → storage_path map
    # Handles UUID-based storage where files are stored as resources/<uuid>
    if local_path_to_storage:
        disk_path = local_path_to_storage.get(clean)
        if disk_path and os.path.isfile(disk_path):
            return disk_path

    # Fallback: direct path (works for tests with human-readable filenames)
    full_path = os.path.join(storage_root, session_id, "resources", clean)
    if os.path.isfile(full_path):
        return full_path

    # Fallback: filename map reverse lookup
    if filename_map:
        for orig_url, local_name in filename_map.items():
            # local_name could be like "images/photo.jpg"
            if clean == local_name or clean.endswith("/" + local_name.split("/")[-1]):
                full_path = os.path.join(storage_root, session_id, "resources", local_name)
                if os.path.isfile(full_path):
                    return full_path

    return None


def _read_resource_as_data_uri(
    url: str,
    storage_root: str,
    session_id: str,
    filename_map: Optional[dict[str, str]] = None,
    local_path_to_storage: Optional[dict[str, str]] = None,
) -> Optional[str]:
    """Read a resource file from disk and return it as a base64 data URI."""
    path = _resolve_local_path(url, storage_root, session_id, filename_map, local_path_to_storage)
    if not path:
        return None

    try:
        with open(path, "rb") as f:
            data = f.read()

        # Determine MIME type from extension
        ext = path.rsplit(".", 1)[-1].lower() if "." in path else "bin"
        mime = _extension_to_mime(ext)
        b64 = base64.b64encode(data).decode("ascii")
        return f"data:{mime};base64,{b64}"
    except OSError as exc:
        logger.warning("Failed to read resource for inlining: %s — %s", path, exc)
        return None


def _read_text_resource(
    url: str,
    storage_root: str,
    session_id: str,
    local_path_to_storage: Optional[dict[str, str]] = None,
) -> Optional[str]:
    """Read a text resource file from disk."""
    path = _resolve_local_path(url, storage_root, session_id, local_path_to_storage=local_path_to_storage)
    if not path:
        return None

    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except OSError as exc:
        logger.warning("Failed to read text resource: %s — %s", path, exc)
        return None


def _extension_to_mime(ext: str) -> str:
    """Map a file extension to a MIME type."""
    mapping = {
        "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "png": "image/png", "gif": "image/gif",
        "webp": "image/webp", "svg": "image/svg+xml",
        "bmp": "image/bmp", "ico": "image/x-icon",
        "avif": "image/avif", "heic": "image/heic",
        "tiff": "image/tiff", "tif": "image/tiff",
        "css": "text/css",
        "js": "application/javascript", "mjs": "application/javascript",
        "woff": "font/woff", "woff2": "font/woff2",
        "ttf": "font/ttf", "otf": "font/otf", "eot": "application/vnd.ms-fontobject",
        "html": "text/html",
        "json": "application/json",
    }
    return mapping.get(ext, "application/octet-stream")


# ---------------------------------------------------------------------------
# Public entry point: convert_html
# ---------------------------------------------------------------------------


def _maybe_fix_bin_extension(filename: str, filename_ext_map: Optional[dict[str, str]]) -> str:
    """If filename ends with .bin, look up its base name in filename_ext_map
    to find the correct extension from resources already stored on disk.
    """
    if not filename.endswith(".bin") or not filename_ext_map:
        return filename
    base = filename[:-4]  # remove ".bin"
    ext = filename_ext_map.get(base)
    if ext:
        return f"{base}.{ext}"
    return filename


def convert_html(
    html_string: str,
    tab_url: str,
    filename_map: Optional[dict[str, str]] = None,
    is_linked_page: bool = False,
    path: Optional[str] = None,
    page_filename_map: Optional[dict[str, str]] = None,
    content_type_map: Optional[dict[str, str]] = None,
    filename_ext_map: Optional[dict[str, str]] = None,
) -> str:
    """Convert all resource URLs in HTML to relative local paths.

    This is the main entry point, port of convertHtml from html-converter.ts.
    Parses HTML once and applies all conversions on the same soup tree.

    Args:
        html_string: The merged HTML content.
        tab_url: The original page URL (used for URL resolution).
        filename_map: Mapping of original URLs → local filenames.
        is_linked_page: If True, use ../ prefix (page is in pages/ dir).
        path: Override path prefix (default: "./" or "../" for linked pages).
        page_filename_map: Optional mapping of page URL → resolved filename
            for deduplicated linked page filenames.
        content_type_map: Optional mapping of original URL → MIME type,
            used to determine correct extensions for extensionless URLs when
            the filename map lookup misses.
        filename_ext_map: Optional mapping of basename-without-extension →
            image extension, derived from resources' local_path values.
            Used as a safety net when a .bin extension would otherwise be generated.

    Returns:
        The converted HTML string with local resource paths.
    """
    if path is None:
        path = "../" if is_linked_page else "./"

    soup = BeautifulSoup(html_string, "lxml")

    # 1. Remove <base> tag first
    _remove_base_tag(soup)

    # 2. Convert links (they may reference pages)
    _convert_links(soup, tab_url, path, page_filename_map=page_filename_map)

    # 3. Convert images (including lazy-load and srcset)
    _convert_images(soup, tab_url, path, filename_map, content_type_map, filename_ext_map)

    # 4. Convert background images (inline styles + <style> tags)
    _convert_background_images(soup, tab_url, path, filename_map, content_type_map, filename_ext_map)

    # 5. Convert object elements
    _convert_object_elements(soup, tab_url, path)

    # 6. Convert stylesheets
    _convert_stylesheets(soup, tab_url, path, filename_map)

    # 7. Convert scripts
    _convert_scripts(soup, tab_url, path, filename_map)

    return str(soup)


# ---------------------------------------------------------------------------
# CSS inlining for file:// protocol compatibility
# ---------------------------------------------------------------------------


def inline_css_into_html(
    html_string: str,
    storage_root: str,
    session_id: str,
    filename_map: Optional[dict[str, str]] = None,
    path: str = "./",
    local_path_to_storage: Optional[dict[str, str]] = None,
) -> str:
    """Replace <link rel="stylesheet"> with inline <style> tags for file:// compatibility.

    Reads CSS files from disk and embeds their content directly in the HTML,
    adjusting url() paths to be relative to the HTML file's location.

    Args:
        html_string: HTML with converted local paths (./styles/..., ../images/... etc).
        storage_root: Root directory for session storage.
        session_id: Session identifier.
        filename_map: Mapping of original URLs → local filenames (optional).
        path: Path prefix used in the HTML ("./" for root, "../" for linked pages).
        local_path_to_storage: Mapping of local_path → actual disk path (optional).

    Returns:
        Modified HTML with stylesheets inlined as <style> tags.
    """
    soup = BeautifulSoup(html_string, "lxml")

    # When CSS is inlined from styles/ into root index.html, url() references
    # that were ../images/ need to become ./images/. For linked pages in pages/,
    # the path stays ../images/.
    if path == "./":
        css_path_adjustment = (r"\.\.\/", "./")
    else:
        css_path_adjustment = None  # linked pages keep ../ paths

    for link in soup.find_all("link", rel="stylesheet"):
        href = link.get("href", "")
        if not href or not isinstance(href, str):
            continue

        # Read the CSS file from disk
        css_content = _read_text_resource(href, storage_root, session_id, local_path_to_storage)
        if css_content is None:
            logger.warning("CSS file not found for inlining, keeping <link>: %s", href)
            continue

        # Adjust url() paths: ../images/ → ./images/ when inlining into root
        if css_path_adjustment:
            css_content = re.sub(
                r"(url\(\s*['\"]?)\.\.\/",
                rf"\1{css_path_adjustment[1]}",
                css_content,
            )

        style_tag = soup.new_tag("style")
        style_tag.string = css_content
        link.replace_with(style_tag)

    return str(soup)


# ---------------------------------------------------------------------------
# HtmlConverterService facade
# ---------------------------------------------------------------------------


class HtmlConverterService:
    """Facade for the HTML converter functions.

    Provides a service-style interface matching the pattern used by
    HtmlMergerService and other server services.
    """

    def convert_html(
        self,
        html_string: str,
        tab_url: str,
        filename_map: Optional[dict[str, str]] = None,
        is_linked_page: bool = False,
        path: Optional[str] = None,
        page_filename_map: Optional[dict[str, str]] = None,
        content_type_map: Optional[dict[str, str]] = None,
        filename_ext_map: Optional[dict[str, str]] = None,
    ) -> str:
        """Convert all resource URLs in HTML to relative local paths."""
        return convert_html(html_string, tab_url, filename_map, is_linked_page, path,
                            page_filename_map, content_type_map, filename_ext_map)

    def convert_linked_page_html(
        self,
        html_string: str,
        tab_url: str,
        filename_map: Optional[dict[str, str]] = None,
        page_filename_map: Optional[dict[str, str]] = None,
        content_type_map: Optional[dict[str, str]] = None,
        filename_ext_map: Optional[dict[str, str]] = None,
    ) -> str:
        """Convert HTML for a linked page (uses ../ prefix)."""
        return convert_html(html_string, tab_url, filename_map=filename_map,
                            is_linked_page=True, page_filename_map=page_filename_map,
                            content_type_map=content_type_map,
                            filename_ext_map=filename_ext_map)

    def convert_css_file(
        self,
        css_content: str,
        tab_url: str,
        filename_map: Optional[dict[str, str]] = None,
        storage_root: Optional[str] = None,
        session_id: Optional[str] = None,
        content_type_map: Optional[dict[str, str]] = None,
        filename_ext_map: Optional[dict[str, str]] = None,
    ) -> str:
        """Rewrite url() references in standalone CSS files."""
        return _convert_css_file_impl(css_content, tab_url, filename_map, storage_root, session_id,
                                       content_type_map, filename_ext_map)

    def convert_to_single_file(
        self,
        html_string: str,
        tab_url: str,
        storage_root: str,
        session_id: str,
        filename_map: Optional[dict[str, str]] = None,
        local_path_to_storage: Optional[dict[str, str]] = None,
    ) -> str:
        """Produce self-contained HTML with all resources inlined as base64."""
        return convert_html_to_single_file(
            html_string, tab_url, storage_root, session_id, filename_map, local_path_to_storage
        )

    def write_single_file_to_disk(
        self,
        html_string: str,
        tab_url: str,
        storage_root: str,
        session_id: str,
        output_path: str,
        filename_map: Optional[dict[str, str]] = None,
        local_path_to_storage: Optional[dict[str, str]] = None,
    ) -> None:
        """Write self-contained HTML to disk with streaming writes."""
        write_single_file_to_disk(
            html_string, tab_url, storage_root, session_id,
            output_path, filename_map, local_path_to_storage,
        )

    def inline_css_into_html(
        self,
        html_string: str,
        storage_root: str,
        session_id: str,
        filename_map: Optional[dict[str, str]] = None,
        path: str = "./",
        local_path_to_storage: Optional[dict[str, str]] = None,
    ) -> str:
        """Replace <link rel="stylesheet"> with inline <style> tags."""
        return inline_css_into_html(html_string, storage_root, session_id, filename_map, path, local_path_to_storage)


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

html_converter_service = HtmlConverterService()
