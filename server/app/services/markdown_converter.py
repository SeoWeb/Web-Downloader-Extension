"""HTML → Markdown conversion service (download-as-markdown 1.2).

Converts merged page HTML to clean Markdown with original absolute URLs.

Design decisions implemented (openspec/changes/download-as-markdown):
  D3 — strip non-content elements (parity with the extension's
       NON_CONTENT_SELECTOR) and resolve relative ``href``/``src`` values
       against the page's original URL BEFORE conversion, so the produced
       Markdown references original absolute URLs (conversion runs
       pre-URL-rewrite per D2, but the merged HTML still contains whatever
       relative values the source page had).
  D1 — ``markdownify`` (pure-Python, bs4-based) as the converter, matching
       the monolith's existing BeautifulSoup stack.

Failure handling lives with the caller (D6): this module may raise; the
assembler wraps every conversion in try/except so a conversion error never
fails assembly.
"""

import logging
import re
from urllib.parse import urljoin

from bs4 import BeautifulSoup
from markdownify import MarkdownConverter

logger = logging.getLogger(__name__)

# Non-content elements removed before conversion — parity with the
# extension's NON_CONTENT_SELECTOR used for content.txt extraction (D3).
NON_CONTENT_SELECTOR = "script, style, noscript, template, svg"

# URI shapes left untouched during URL resolution: embedded data, script
# payloads, and non-HTTP schemes have no meaningful absolute form.
_SKIPPED_URI_PREFIXES = ("data:", "javascript:", "mailto:", "tel:")

# Normalization: 3+ consecutive newlines collapse to a single blank line.
_EXCESS_NEWLINES_RE = re.compile(r"\n{3,}")

# Shared converter instance (stateless; safe to reuse across calls).
_converter = MarkdownConverter(heading_style="ATX", bullets="-")


def _resolve_url(value: str, base_url: str) -> str:
    """Resolve a URL attribute value against ``base_url``.

    Returns the value unchanged (not an absolute URL) when it must not be
    resolved: empty, a pure fragment (``#...``), or a ``data:`` /
    ``javascript:`` / ``mailto:`` / ``tel:`` URI. Absolute URLs pass
    through ``urljoin`` unchanged, so they are returned as-is.
    """
    stripped = value.strip()
    if (
        not stripped
        or stripped.startswith("#")
        or stripped.lower().startswith(_SKIPPED_URI_PREFIXES)
    ):
        return value
    return urljoin(base_url, stripped)


def convert_html_to_markdown(html: str, base_url: str) -> str:
    """Convert an HTML document to Markdown.

    Steps:
      1. Parse with BeautifulSoup (``lxml``, falling back to
         ``html.parser`` if the lxml parse fails).
      2. Decompose ``script, style, noscript, template, svg`` (D3).
      3. Resolve relative ``a[href]`` / ``img[src]`` values against
         ``base_url`` with ``urljoin`` so the Markdown references original
         absolute URLs (fragments and data:/javascript:/mailto:/tel:
         URIs are left untouched).
      4. Convert with markdownify (ATX headings, ``-`` bullets).
      5. Normalize whitespace: strip the ends, collapse 3+ consecutive
         newlines to 2.

    Empty or whitespace-only input returns ``""``.
    """
    if not html or not html.strip():
        return ""

    try:
        soup = BeautifulSoup(html, "lxml")
    except Exception as exc:
        logger.debug("lxml parse failed (%s); falling back to html.parser", exc)
        soup = BeautifulSoup(html, "html.parser")

    if soup is None:
        return ""

    # Strip non-content elements before conversion (D3).
    for element in soup.select(NON_CONTENT_SELECTOR):
        element.decompose()

    # Resolve relative URLs against the page's original URL so the
    # Markdown carries original absolute links/images.
    for anchor in soup.find_all("a", href=True):
        anchor["href"] = _resolve_url(anchor["href"], base_url)
    for image in soup.find_all("img", src=True):
        image["src"] = _resolve_url(image["src"], base_url)

    markdown = _converter.convert_soup(soup)

    # Normalize: strip the ends, collapse 3+ consecutive newlines to 2.
    return _EXCESS_NEWLINES_RE.sub("\n\n", markdown).strip()
