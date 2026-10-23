#!/usr/bin/env python3
"""Verification tests for the Markdown conversion service (download-as-markdown 1.3).

Covers:
  - Headings, links, images, inline code / pre blocks, tables, lists
  - No script/style content leakage (D3 non-content stripping)
  - Relative → absolute URL resolution against the page's original URL
  - Fragment / data: URIs left untouched
  - Empty / whitespace-only input returns ""
"""

import os
import sys

# Ensure app package is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.services.markdown_converter import convert_html_to_markdown


# ---------------------------------------------------------------------------
# Basic element conversion
# ---------------------------------------------------------------------------


def test_headings_become_atx():
    """h1-h3 convert to ATX-style # headings."""
    html = "<html><body><h1>Title</h1><h2>Section</h2><h3>Sub</h3></body></html>"
    md = convert_html_to_markdown(html, "https://example.com/page")
    assert "# Title" in md
    assert "## Section" in md
    assert "### Sub" in md


def test_links_use_absolute_url():
    """Anchors convert to [text](absolute-url)."""
    html = '<html><body><a href="https://example.com/target">Read this</a></body></html>'
    md = convert_html_to_markdown(html, "https://example.com/page")
    assert "[Read this](https://example.com/target)" in md


def test_images_use_absolute_url():
    """Images convert to ![alt](absolute-url)."""
    html = (
        '<html><body><img src="https://example.com/images/photo.jpg" '
        'alt="A photo"></body></html>'
    )
    md = convert_html_to_markdown(html, "https://example.com/page")
    assert "![A photo](https://example.com/images/photo.jpg)" in md


def test_inline_code():
    """Inline <code> renders as backtick code."""
    html = "<html><body><p>Run <code>x = 1</code> first</p></body></html>"
    md = convert_html_to_markdown(html, "https://example.com/page")
    assert "`x = 1`" in md


def test_pre_block():
    """<pre><code> blocks render as a code block without crashing."""
    html = (
        "<html><body><pre><code>def f():\n    return 1\n"
        "</code></pre></body></html>"
    )
    md = convert_html_to_markdown(html, "https://example.com/page")
    assert "def f():" in md
    assert "return 1" in md


def test_table_renders_without_crashing():
    """Tables convert without raising and keep their cell text."""
    html = (
        "<html><body><table>"
        "<tr><th>A</th><th>B</th></tr>"
        "<tr><td>1</td><td>2</td></tr>"
        "</table></body></html>"
    )
    md = convert_html_to_markdown(html, "https://example.com/page")
    assert isinstance(md, str)
    for cell in ("A", "B", "1", "2"):
        assert cell in md


def test_unordered_list_uses_dash_bullets():
    """<ul><li> converts to dash bullets."""
    html = (
        "<html><body><ul><li>One</li><li>Two</li>"
        "<li><p>Three</p></li></ul></body></html>"
    )
    md = convert_html_to_markdown(html, "https://example.com/page")
    assert "- One" in md
    assert "- Two" in md
    assert "- Three" in md


# ---------------------------------------------------------------------------
# Non-content stripping (D3)
# ---------------------------------------------------------------------------


def test_script_and_style_contents_absent():
    """Inline <script>/<style> contents appear nowhere in the markdown."""
    html = (
        "<html><head><style>.secret { color: red; } /* STYLEMARKER */</style></head>"
        "<body><p>Visible text</p>"
        "<script>var secret = 'SCRIPTMARKER';</script>"
        "</body></html>"
    )
    md = convert_html_to_markdown(html, "https://example.com/page")
    assert "Visible text" in md
    assert "SCRIPTMARKER" not in md
    assert "STYLEMARKER" not in md


def test_noscript_template_svg_stripped():
    """noscript/template/svg elements are removed before conversion."""
    html = (
        "<html><body><p>Kept</p>"
        "<noscript>NOSCRIPTMARKER</noscript>"
        "<template>TEMPLATEMARKER</template>"
        '<svg><text>SVGMARKER</text></svg>'
        "</body></html>"
    )
    md = convert_html_to_markdown(html, "https://example.com/page")
    assert "Kept" in md
    for marker in ("NOSCRIPTMARKER", "TEMPLATEMARKER", "SVGMARKER"):
        assert marker not in md


# ---------------------------------------------------------------------------
# URL resolution
# ---------------------------------------------------------------------------


def test_relative_href_resolved_against_base_url():
    """/about on base https://example.com/docs → https://example.com/about."""
    html = '<html><body><a href="/about">About</a></body></html>'
    md = convert_html_to_markdown(html, "https://example.com/docs")
    assert "[About](https://example.com/about)" in md


def test_relative_src_resolved_against_base_url():
    """Relative img src resolves against the base URL, keeping subpaths."""
    html = '<html><body><img src="img/pic.png" alt="Pic"></body></html>'
    md = convert_html_to_markdown(html, "https://example.com/docs/page")
    assert "![Pic](https://example.com/docs/img/pic.png)" in md


def test_absolute_urls_kept_as_is():
    """Already-absolute URLs pass through unchanged."""
    html = (
        "<html><body>"
        '<a href="https://other.com/x?a=1">Link</a>'
        '<img src="https://cdn.example.com/i.gif" alt="I">'
        "</body></html>"
    )
    md = convert_html_to_markdown(html, "https://example.com/page")
    assert "[Link](https://other.com/x?a=1)" in md
    assert "![I](https://cdn.example.com/i.gif)" in md


def test_fragment_links_untouched():
    """Pure-fragment hrefs are not resolved away."""
    html = '<html><body><a href="#section">Jump</a></body></html>'
    md = convert_html_to_markdown(html, "https://example.com/page")
    assert "[Jump](#section)" in md


def test_data_uri_src_untouched():
    """data: URIs are not mangled by URL resolution."""
    data_uri = "data:image/png;base64,iVBORw0KGgo="
    html = f'<html><body><img src="{data_uri}" alt="Px"></body></html>'
    md = convert_html_to_markdown(html, "https://example.com/page")
    assert f"![Px]({data_uri})" in md


def test_mailto_and_javascript_links_untouched():
    """mailto:/javascript: hrefs are left as written."""
    html = (
        "<html><body>"
        '<a href="mailto:a@b.com">Mail</a>'
        '<a href="javascript:void(0)">Js</a>'
        "</body></html>"
    )
    md = convert_html_to_markdown(html, "https://example.com/page")
    assert "[Mail](mailto:a@b.com)" in md
    assert "](javascript:void(0))" in md


# ---------------------------------------------------------------------------
# Whitespace normalization + empty input
# ---------------------------------------------------------------------------


def test_whitespace_normalized():
    """Output is stripped and 3+ consecutive newlines collapse to 2."""
    html = (
        "<html><body><h1>A</h1><p>First</p><br><br><br><br>"
        "<p>Second</p></body></html>"
    )
    md = convert_html_to_markdown(html, "https://example.com/page")
    assert md == md.strip()
    assert "\n\n\n" not in md


def test_empty_input_returns_empty_string():
    """Empty input converts to an empty string."""
    assert convert_html_to_markdown("", "https://example.com/page") == ""


def test_whitespace_only_input_returns_empty_string():
    """Whitespace-only input converts to an empty string."""
    assert convert_html_to_markdown("   \n\t  ", "https://example.com/page") == ""


def test_only_non_content_elements_yields_empty_string():
    """A document with only stripped elements normalizes to an empty string."""
    html = (
        "<html><head><style>.a { color: red; }</style></head>"
        "<body><script>var x = 1;</script></body></html>"
    )
    assert convert_html_to_markdown(html, "https://example.com/page") == ""
