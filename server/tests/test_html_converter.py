#!/usr/bin/env python3
"""Verification tests for HTML Converter Service (tasks 5.11–5.13).

5.11 – Verify: converter produces correct relative paths for a test HTML
        document with all resource types.
5.12 – Verify: CSS file URL conversion produces correct ../images/ references.
5.13 – Verify: linked page conversion uses ../ prefix correctly for all
        resource types.
"""

import os
import sys
import tempfile

# Ensure app package is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.services.html_converter import (
    convert_html,
    convert_html_for_linked_page,
    _convert_css_file_impl as convert_css_file,
    _lookup_content_type,
    _resolve_local_path,
    fix_filename,
    generate_image_filename,
    generate_page_filename,
    inline_css_into_html,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

TAB_URL = "https://example.com/page/article"
TAB_ORIGIN = "https://example.com"

SAMPLE_FILENAME_MAP = {
    "https://example.com/images/photo.jpg": "images/photo.jpg",
    "https://example.com/images/logo.png": "images/logo.png",
    "https://example.com/images/hero.webp": "images/hero.webp",
    "https://example.com/css/style.css": "styles/style.css",
    "https://example.com/js/app.js": "scripts/app.js",
    "https://example.com/docs/report.pdf": "documents/report.pdf",
    "https://example.com/fonts/roboto.woff2": "fonts/roboto.woff2",
}

SAMPLE_CONTENT_TYPE_MAP = {
    "https://cdn.example.com/img/abc123": "image/jpeg",
    "https://cdn.example.com/img/def456": "image/png",
    "https://cdn.other.com/assets/hero": "image/webp",
    "https://example.com/images/photo.jpg": "image/jpeg",
    "https://cdn.example.com/img/noext": "image/gif",
}


def _has_attr(html: str, tag: str, attr: str, value: str) -> bool:
    """Quick check: does the HTML contain tag[attr] with the given value?"""
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "lxml")
    for el in soup.find_all(tag):
        v = el.get(attr, "")
        if v == value:
            return True
    return False


def _get_attr(html: str, tag: str, attr: str) -> list[str]:
    """Get all values of an attribute from matching tags."""
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "lxml")
    return [el.get(attr, "") for el in soup.find_all(tag) if el.get(attr)]


# ---------------------------------------------------------------------------
# 5.11 – Verify: converter produces correct relative paths for all types
# ---------------------------------------------------------------------------


def test_image_src_conversion_with_filename_map():
    """Image src converted to ./images/<mapped_filename> via filename map."""
    html = '<html><body><img src="https://example.com/images/photo.jpg"></body></html>'
    result = convert_html(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert _has_attr(result, "img", "src", "./images/photo.jpg"), (
        f"Expected ./images/photo.jpg, got: {_get_attr(result, 'img', 'src')}"
    )


def test_image_src_conversion_without_map():
    """Image src converted to ./images/<generated_filename> when not in map."""
    html = '<html><body><img src="https://other.com/img/banner.jpg"></body></html>'
    result = convert_html(html, TAB_URL, filename_map={})
    srcs = _get_attr(result, "img", "src")
    assert any(s.startswith("./images/") for s in srcs), (
        f"Expected ./images/ prefix, got: {srcs}"
    )


def test_lazy_load_data_src():
    """Lazy-load data-src attribute converted to local path (5.2)."""
    html = '<html><body><img data-src="https://example.com/images/logo.png" src="placeholder.gif"></body></html>'
    result = convert_html(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert _has_attr(result, "img", "data-src", "./images/logo.png"), (
        f"Expected data-src=./images/logo.png, got: {_get_attr(result, 'img', 'data-src')}"
    )


def test_srcset_conversion():
    """srcset URLs converted to local paths (5.3)."""
    html = '<html><body><img srcset="https://example.com/images/hero.webp 2x, https://example.com/images/photo.jpg 1x"></body></html>'
    result = convert_html(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    srcsets = _get_attr(result, "img", "srcset")
    assert len(srcsets) == 1
    # Should contain both local paths with descriptors
    assert "./images/hero.webp 2x" in srcsets[0], f"Missing hero.webp in: {srcsets[0]}"
    assert "./images/photo.jpg 1x" in srcsets[0], f"Missing photo.jpg in: {srcsets[0]}"


def test_inline_style_background_image():
    """Inline style background-image URL converted (5.4)."""
    html = '<html><body><div style="background-image: url(\'https://example.com/images/photo.jpg\')"></div></body></html>'
    result = convert_html(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert "./images/photo.jpg" in result, (
        f"Expected ./images/photo.jpg in inline style, got: {result}"
    )


def test_script_conversion():
    """Script src converted to ./scripts/ (5.5)."""
    html = '<html><body><script src="https://example.com/js/app.js"></script></body></html>'
    result = convert_html(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert _has_attr(result, "script", "src", "./scripts/app.js"), (
        f"Expected ./scripts/app.js, got: {_get_attr(result, 'script', 'src')}"
    )


def test_stylesheet_conversion():
    """Stylesheet href converted to ./styles/ (5.6)."""
    html = '<html><head><link rel="stylesheet" href="https://example.com/css/style.css"></head><body></body></html>'
    result = convert_html(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert _has_attr(result, "link", "href", "./styles/style.css"), (
        f"Expected ./styles/style.css, got: {_get_attr(result, 'link', 'href')}"
    )


def test_preload_link_conversion():
    """<link rel="preload"> chunks/fonts must be rewritten to local paths.

    Next.js references most JS chunks and fonts via preload/modulepreload
    links rather than <script src> / <link rel="stylesheet">. Without this
    they stay absolute and 404 in the archived preview.
    """
    html = (
        '<html><head>'
        '<link rel="preload" as="script" href="https://example.com/_next/static/chunks/1s6lcszef--st.js?dpl=dpl_abc">'
        '<link rel="modulepreload" href="https://example.com/_next/static/chunks/vendor.js">'
        '<link rel="preload" as="style" href="https://example.com/_next/static/css/main.css">'
        '<link rel="preload" as="font" href="https://example.com/_next/static/media/roboto.woff2" crossorigin>'
        '</head><body></body></html>'
    )
    result = convert_html(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert _has_attr(result, "link", "href", "./scripts/1s6lcszef-st.js"), (
        f"Expected ./scripts/1s6lcszef-st.js, got: {_get_attr(result, 'link', 'href')}"
    )
    # All preload references must be archive-relative, never host-absolute.
    assert "/_next/" not in result, f"Absolute /_next/ path leaked: {result}"
    assert _has_attr(result, "link", "href", "./scripts/vendor.js"), (
        f"Expected ./scripts/vendor.js, got: {_get_attr(result, 'link', 'href')}"
    )
    assert _has_attr(result, "link", "href", "./styles/main.css"), (
        f"Expected ./styles/main.css, got: {_get_attr(result, 'link', 'href')}"
    )
    assert _has_attr(result, "link", "href", "./images/roboto.woff2"), (
        f"Expected ./images/roboto.woff2, got: {_get_attr(result, 'link', 'href')}"
    )


def test_link_document_conversion():
    """Link to document → ./documents/<filename> (5.7)."""
    html = '<html><body><a href="https://example.com/docs/report.pdf">Report</a></body></html>'
    result = convert_html(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert _has_attr(result, "a", "href", "./documents/report.pdf"), (
        f"Expected ./documents/report.pdf, got: {_get_attr(result, 'a', 'href')}"
    )


def test_link_html_page_conversion():
    """Same-origin HTML link → ./pages/<filename>.html (5.7)."""
    html = '<html><body><a href="https://example.com/about.html">About</a></body></html>'
    result = convert_html(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert _has_attr(result, "a", "href", "./pages/about.html"), (
        f"Expected ./pages/about.html, got: {_get_attr(result, 'a', 'href')}"
    )


def test_link_clean_url_conversion():
    """Clean URL (no extension) → ./pages/<name>.html (5.7)."""
    html = '<html><body><a href="https://example.com/contact">Contact</a></body></html>'
    result = convert_html(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert _has_attr(result, "a", "href", "./pages/contact.html"), (
        f"Expected ./pages/contact.html, got: {_get_attr(result, 'a', 'href')}"
    )


def test_external_link_unchanged():
    """External link href is left unchanged (5.7)."""
    html = '<html><body><a href="https://other.com/page">External</a></body></html>'
    result = convert_html(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert _has_attr(result, "a", "href", "https://other.com/page"), (
        f"Expected external link unchanged, got: {_get_attr(result, 'a', 'href')}"
    )


def test_anchor_link_unchanged():
    """Anchor-only links (#) are left unchanged (5.7)."""
    html = '<html><body><a href="#section1">Section</a></body></html>'
    result = convert_html(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert _has_attr(result, "a", "href", "#section1"), (
        f"Expected #section1 unchanged, got: {_get_attr(result, 'a', 'href')}"
    )


def test_object_element_conversion():
    """Object element with image type → ./images/ (5.8)."""
    html = '<html><body><object type="image/svg+xml" data="https://example.com/images/icon.svg"></object></body></html>'
    result = convert_html(html, TAB_URL, filename_map={})
    datas = _get_attr(result, "object", "data")
    assert any(d.startswith("./images/") for d in datas), (
        f"Expected ./images/ prefix, got: {datas}"
    )


def test_base_tag_removed():
    """<base> tag is removed during conversion."""
    html = '<html><head><base href="https://example.com/"></head><body></body></html>'
    result = convert_html(html, TAB_URL, filename_map={})
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(result, "lxml")
    assert soup.find("base") is None, "Expected <base> tag to be removed"


def test_all_resource_types_combined():
    """Full HTML with all resource types converts correctly (5.11)."""
    html = """<!DOCTYPE html>
<html>
<head>
    <base href="https://example.com/">
    <link rel="stylesheet" href="https://example.com/css/style.css">
</head>
<body>
    <img src="https://example.com/images/photo.jpg">
    <img data-src="https://example.com/images/logo.png" src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==">
    <img srcset="https://example.com/images/hero.webp 2x">
    <div style="background-image: url('https://example.com/images/photo.jpg')"></div>
    <script src="https://example.com/js/app.js"></script>
    <a href="https://example.com/docs/report.pdf">Report</a>
    <a href="https://example.com/about.html">About</a>
    <a href="https://other.com/external">External</a>
    <a href="#section1">Section</a>
    <object type="image/svg+xml" data="https://example.com/images/diagram.svg"></object>
</body>
</html>"""

    result = convert_html(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)

    # Verify all expected conversions
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(result, "lxml")

    # Base tag removed
    assert soup.find("base") is None

    # Image → ./images/photo.jpg
    img_srcs = [img.get("src", "") for img in soup.find_all("img")]
    assert "./images/photo.jpg" in img_srcs, f"Missing ./images/photo.jpg in: {img_srcs}"

    # Lazy-load → ./images/logo.png
    data_srcs = [img.get("data-src", "") for img in soup.find_all("img") if img.get("data-src")]
    assert "./images/logo.png" in data_srcs, f"Missing ./images/logo.png in: {data_srcs}"

    # Srcset contains local path
    srcsets = [img.get("srcset", "") for img in soup.find_all("img") if img.get("srcset")]
    assert any("./images/hero.webp" in s for s in srcsets), f"Missing hero.webp in srcset: {srcsets}"

    # Stylesheet → ./styles/style.css
    links = soup.find_all("link", rel="stylesheet")
    assert any(l.get("href") == "./styles/style.css" for l in links)

    # Script → ./scripts/app.js
    scripts = [s.get("src", "") for s in soup.find_all("script", src=True)]
    assert "./scripts/app.js" in scripts

    # Link to doc → ./documents/report.pdf
    hrefs = [a.get("href", "") for a in soup.find_all("a")]
    assert "./documents/report.pdf" in hrefs
    assert "./pages/about.html" in hrefs

    # External link unchanged
    assert "https://other.com/external" in hrefs

    # Anchor unchanged
    assert "#section1" in hrefs

    print("  [PASS] All resource types convert correctly")


# ---------------------------------------------------------------------------
# 5.12 – Verify: CSS file URL conversion produces correct ../images/
# ---------------------------------------------------------------------------


def test_css_file_image_url():
    """CSS url() with image → ../images/<filename> (5.12)."""
    css = "body { background-image: url('https://example.com/images/bg.jpg'); }"
    result = convert_css_file(css, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert "../images/bg.jpg" in result, f"Expected ../images/bg.jpg, got: {result}"


def test_css_file_font_url():
    """CSS url() with font → ../fonts/<filename> (5.12)."""
    css = "@font-face { font-family: 'Roboto'; src: url('https://example.com/fonts/roboto.woff2') format('woff2'); }"
    result = convert_css_file(css, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert "../fonts/roboto.woff2" in result, f"Expected ../fonts/roboto.woff2, got: {result}"


def test_css_file_data_uri_unchanged():
    """CSS url() with data URI left unchanged (5.12)."""
    css = "body { background: url(data:image/png;base64,iVBORw0KGgo=); }"
    result = convert_css_file(css, TAB_URL, filename_map={})
    assert "data:image/png;base64" in result, f"Data URI should be unchanged, got: {result}"


def test_css_file_relative_path_unchanged():
    """CSS url() with already-relative path left unchanged (5.12)."""
    css = ".icon { background: url('../images/icon.svg'); }"
    result = convert_css_file(css, TAB_URL, filename_map={})
    assert "../images/icon.svg" in result, f"Relative path should be unchanged, got: {result}"


def test_css_file_import_same_directory():
    """CSS @import url() to uploaded stylesheet → ./filename (5.12)."""
    css = '@import url("https://example.com/css/style.css");'
    result = convert_css_file(css, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert "./style.css" in result, (
        f"Expected same-directory import, got: {result}"
    )


def test_css_file_query_params_stripped():
    """CSS url() with query parameters strips them (5.12)."""
    css = "body { background: url('https://example.com/images/bg.jpg?v=1.2'); }"
    result = convert_css_file(css, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    # Should not contain query params in the output
    assert "?v=1.2" not in result, f"Query params should be stripped, got: {result}"
    assert "../images/bg.jpg" in result, f"Expected ../images/bg.jpg, got: {result}"


def test_css_file_external_import_unchanged():
    """CSS @import of external origin is left unchanged (5.12)."""
    css = '@import url("https://fonts.googleapis.com/css2?family=Roboto");'
    result = convert_css_file(css, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert "https://fonts.googleapis.com" in result, (
        f"External import should be unchanged, got: {result}"
    )


# ---------------------------------------------------------------------------
# 5.13 – Verify: linked page conversion uses ../ prefix correctly
# ---------------------------------------------------------------------------


def test_linked_page_images():
    """Linked page image references use ../images/ (5.13)."""
    html = '<html><body><img src="https://example.com/images/photo.jpg"></body></html>'
    result = convert_html_for_linked_page(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert _has_attr(result, "img", "src", "../images/photo.jpg"), (
        f"Expected ../images/photo.jpg, got: {_get_attr(result, 'img', 'src')}"
    )


def test_linked_page_stylesheets():
    """Linked page CSS references use ../styles/ (5.13)."""
    html = '<html><head><link rel="stylesheet" href="https://example.com/css/style.css"></head><body></body></html>'
    result = convert_html_for_linked_page(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert _has_attr(result, "link", "href", "../styles/style.css"), (
        f"Expected ../styles/style.css, got: {_get_attr(result, 'link', 'href')}"
    )


def test_linked_page_scripts():
    """Linked page JS references use ../scripts/ (5.13)."""
    html = '<html><body><script src="https://example.com/js/app.js"></script></body></html>'
    result = convert_html_for_linked_page(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert _has_attr(result, "script", "src", "../scripts/app.js"), (
        f"Expected ../scripts/app.js, got: {_get_attr(result, 'script', 'src')}"
    )


def test_linked_page_documents():
    """Linked page document links use ../documents/ (5.13)."""
    html = '<html><body><a href="https://example.com/docs/report.pdf">Report</a></body></html>'
    result = convert_html_for_linked_page(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert _has_attr(result, "a", "href", "../documents/report.pdf"), (
        f"Expected ../documents/report.pdf, got: {_get_attr(result, 'a', 'href')}"
    )


def test_linked_page_html_links():
    """Linked page HTML links use ../pages/ (5.13)."""
    html = '<html><body><a href="https://example.com/about.html">About</a></body></html>'
    result = convert_html_for_linked_page(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert _has_attr(result, "a", "href", "../pages/about.html"), (
        f"Expected ../pages/about.html, got: {_get_attr(result, 'a', 'href')}"
    )


def test_linked_page_background_images():
    """Linked page background-image uses ../images/ (5.13)."""
    html = '<html><body><div style="background-image: url(\'https://example.com/images/photo.jpg\')"></div></body></html>'
    result = convert_html_for_linked_page(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert "../images/photo.jpg" in result, (
        f"Expected ../images/photo.jpg in background-image, got: {result}"
    )


def test_linked_page_object_elements():
    """Linked page object elements use ../images/ (5.13)."""
    html = '<html><body><object type="image/svg+xml" data="https://example.com/images/diagram.svg"></object></body></html>'
    result = convert_html_for_linked_page(html, TAB_URL, filename_map={})
    datas = _get_attr(result, "object", "data")
    assert any(d.startswith("../images/") for d in datas), (
        f"Expected ../images/ prefix, got: {datas}"
    )


def test_linked_page_all_resource_types():
    """Linked page with all resource types uses ../ prefix (5.13)."""
    html = """<!DOCTYPE html>
<html>
<head>
    <link rel="stylesheet" href="https://example.com/css/style.css">
</head>
<body>
    <img src="https://example.com/images/photo.jpg">
    <div style="background-image: url('https://example.com/images/logo.png')"></div>
    <script src="https://example.com/js/app.js"></script>
    <a href="https://example.com/docs/report.pdf">Report</a>
    <a href="https://example.com/about.html">About</a>
</body>
</html>"""

    result = convert_html_for_linked_page(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)

    # All paths must use ../ prefix
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(result, "lxml")

    # Image
    img_srcs = [img.get("src", "") for img in soup.find_all("img")]
    assert "../images/photo.jpg" in img_srcs, f"Image: {img_srcs}"

    # Stylesheet
    links = [l.get("href", "") for l in soup.find_all("link", rel="stylesheet")]
    assert "../styles/style.css" in links, f"Stylesheet: {links}"

    # Script
    scripts = [s.get("src", "") for s in soup.find_all("script", src=True)]
    assert "../scripts/app.js" in scripts, f"Script: {scripts}"

    # Document link
    hrefs = [a.get("href", "") for a in soup.find_all("a")]
    assert "../documents/report.pdf" in hrefs, f"Doc link: {hrefs}"

    # HTML page link
    assert "../pages/about.html" in hrefs, f"Page link: {hrefs}"

    # Background image
    assert "../images/logo.png" in result, "Background image not using ../"

    print("  [PASS] Linked page all resource types use ../ prefix")


# ---------------------------------------------------------------------------
# Additional coverage tests (verification fixes)
# ---------------------------------------------------------------------------


def test_style_tag_background_image():
    """<style> tag background-image URL converted (5.4)."""
    html = '<html><head><style>body { background-image: url(\'https://example.com/images/photo.jpg\'); }</style></head><body></body></html>'
    result = convert_html(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert "./images/photo.jpg" in result, (
        f"Expected ./images/photo.jpg in <style> tag, got: {result}"
    )


def test_script_filename_map():
    """Script src uses filename map when available (5.5)."""
    html = '<html><body><script src="https://example.com/js/app.js"></script></body></html>'
    filename_map_with_script = {
        **SAMPLE_FILENAME_MAP,
        "https://example.com/js/app.js": "scripts/app.js",
    }
    result = convert_html(html, TAB_URL, filename_map=filename_map_with_script)
    assert _has_attr(result, "script", "src", "./scripts/app.js"), (
        f"Expected ./scripts/app.js via filename map, got: {_get_attr(result, 'script', 'src')}"
    )


def test_stylesheet_filename_map():
    """Stylesheet href uses filename map when available (5.6)."""
    html = '<html><head><link rel="stylesheet" href="https://example.com/css/style.css"></head><body></body></html>'
    result = convert_html(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert _has_attr(result, "link", "href", "./styles/style.css"), (
        f"Expected ./styles/style.css via filename map, got: {_get_attr(result, 'link', 'href')}"
    )


def test_source_src_attribute():
    """<source src> attribute converted to local path (5.1)."""
    html = '<html><body><picture><source src="https://example.com/images/photo.jpg" type="image/jpeg"><img src="https://example.com/images/photo.jpg"></picture></body></html>'
    result = convert_html(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    srcs = _get_attr(result, "source", "src")
    assert any(s == "./images/photo.jpg" for s in srcs), (
        f"Expected ./images/photo.jpg on <source src>, got: {srcs}"
    )


def test_source_src_with_data_uri_unchanged():
    """<source src> with data URI is left unchanged."""
    html = '<html><body><picture><source src="data:image/webp;base64,UklGRiQ=" type="image/webp"></picture></body></html>'
    result = convert_html(html, TAB_URL, filename_map={})
    srcs = _get_attr(result, "source", "src")
    assert any(s.startswith("data:image/webp") for s in srcs), (
        f"Expected data URI unchanged on <source src>, got: {srcs}"
    )


def test_linked_page_style_tag_background_image():
    """Linked page <style> tag background-image uses ../images/ prefix (5.13)."""
    html = '<html><head><style>body { background-image: url(\'https://example.com/images/photo.jpg\'); }</style></head><body></body></html>'
    result = convert_html_for_linked_page(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert "../images/photo.jpg" in result, (
        f"Expected ../images/photo.jpg in linked page <style> tag, got: {result}"
    )


# ---------------------------------------------------------------------------
# Utility function tests
# ---------------------------------------------------------------------------


def test_fix_filename():
    """fixFilename port works correctly."""
    assert fix_filename("photo.jpg") == "photo.jpg"
    assert fix_filename("PHOTO.JPG") == "PHOTO.jpg"  # Only extension is lowered
    assert fix_filename("my file.png") == "my file.png"  # Spaces not in sanitize regex
    assert fix_filename("file?query=1") == "file.bin"  # No extension after ? strip
    assert fix_filename("") == "unknown_file"
    assert fix_filename("no-ext") == "no-ext.bin"


def test_generate_image_filename():
    """generateImageFilename port works correctly."""
    # Single-segment path with image extension
    assert generate_image_filename("https://example.com/photo.jpg") == "photo.jpg"
    # Multi-segment path with image extension includes parent for uniqueness
    result = generate_image_filename("https://example.com/img/photo.jpg")
    assert result == "img_photo.jpg"
    # eBay-style: unique parent segment prevents collision
    result = generate_image_filename("https://i.ebayimg.com/images/g/hXIAAOSwu-BoJfB9/s-l960.webp")
    assert "hXIAAOSwu-BoJfB9" in result and result.endswith(".webp")
    # Without image extension
    result = generate_image_filename("https://example.com/bbcswebdav/xid-31821076_1")
    assert result.endswith(".bin")  # Default extension when no Content-Type
    # With Content-Type
    result = generate_image_filename("/bbcswebdav/xid-31821076_1", "image/png")
    assert result.endswith(".png")


# ---------------------------------------------------------------------------
# generate_page_filename tests (linked-page-scraping-parity task 5.1)
# ---------------------------------------------------------------------------


def test_generate_page_filename_basic():
    """Basic URL produces filename from last path segment."""
    assert generate_page_filename("https://example.com/about") == "about.html"


def test_generate_page_filename_nested_path():
    """Nested path uses only the last segment."""
    assert generate_page_filename("https://example.com/about/team") == "team.html"


def test_generate_page_filename_root_url():
    """Root URL falls back to page.html."""
    assert generate_page_filename("https://example.com/") == "page.html"


def test_generate_page_filename_root_no_slash():
    """Root URL without trailing slash falls back to page.html."""
    assert generate_page_filename("https://example.com") == "page.html"


def test_generate_page_filename_already_html():
    """URL already ending in .html preserves the extension."""
    assert generate_page_filename("https://example.com/about.html") == "about.html"


def test_generate_page_filename_trailing_slash():
    """URL with trailing slash uses the last non-empty segment."""
    assert generate_page_filename("https://example.com/about/") == "about.html"


def test_generate_page_filename_query_params():
    """Query parameters are stripped before filename generation."""
    assert generate_page_filename("https://example.com/about?ref=nav") == "about.html"


def test_generate_page_filename_fragment():
    """Fragment identifiers are stripped."""
    assert generate_page_filename("https://example.com/about#section") == "about.html"


def test_generate_page_filename_special_chars():
    """Special characters in path segment are sanitized by fix_filename."""
    result = generate_page_filename("https://example.com/hello<world>")
    assert result.endswith(".html")
    # Angle brackets should be sanitized (replaced with dashes)
    assert "<" not in result
    assert ">" not in result


def test_generate_page_filename_empty_input():
    """Empty/None input returns page.html."""
    assert generate_page_filename("") == "page.html"
    assert generate_page_filename(None) == "page.html"


def test_generate_page_filename_matches_convert_links():
    """generate_page_filename produces same filenames as convert_links for same URLs."""
    # For /about/team, both should produce 'team.html'
    url = "https://example.com/about/team"
    filename = generate_page_filename(url)
    # convert_links for a clean URL produces pages/team.html
    html = f'<a href="/about/team">Team</a>'
    converted = convert_html(html, "https://example.com")
    assert f"pages/{filename}" in converted, (
        f"convert_links produced different filename than generate_page_filename "
        f"for {url}: expected pages/{filename} in {converted}"
    )


def test_inline_style_css_custom_property_url():
    """CSS custom property url() converted in inline styles (3.1)."""
    html = '<html><body><div style="--image-url: url(\'https://example.com/images/photo.jpg\')"></div></body></html>'
    result = convert_html(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert "./images/photo.jpg" in result, (
        f"Expected ./images/photo.jpg in custom property, got: {result}"
    )


def test_inline_style_shorthand_background_url():
    """Shorthand background: url() converted in inline styles (3.2)."""
    html = '<html><body><div style="background: url(\'https://example.com/images/photo.jpg\') no-repeat"></div></body></html>'
    result = convert_html(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert "./images/photo.jpg" in result, (
        f"Expected ./images/photo.jpg in shorthand background, got: {result}"
    )


def test_inline_style_list_style_image_url():
    """list-style-image: url() converted in inline styles (3.3)."""
    html = '<html><body><ul><li style="list-style-image: url(\'https://example.com/images/bullet.png\')"></li></ul></body></html>'
    result = convert_html(html, TAB_URL, filename_map={
        **SAMPLE_FILENAME_MAP,
        "https://example.com/images/bullet.png": "images/bullet.png",
    })
    assert "./images/bullet.png" in result, (
        f"Expected ./images/bullet.png in list-style-image, got: {result}"
    )


def test_style_tag_css_custom_property_url():
    """CSS custom property url() in <style> tag converted (3.4)."""
    html = '<html><head><style>.hero { --hero-image: url(\'https://example.com/images/photo.jpg\'); }</style></head><body></body></html>'
    result = convert_html(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert "./images/photo.jpg" in result, (
        f"Expected ./images/photo.jpg in <style> custom property, got: {result}"
    )


def test_multiple_url_in_same_inline_style():
    """Multiple url() references in same inline style each converted (3.5)."""
    html = '<html><body><div style="background: url(\'https://example.com/images/photo.jpg\'); --icon: url(\'https://example.com/images/logo.png\')"></div></body></html>'
    result = convert_html(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert "./images/photo.jpg" in result, (
        f"Expected ./images/photo.jpg, got: {result}"
    )
    assert "./images/logo.png" in result, (
        f"Expected ./images/logo.png, got: {result}"
    )


def test_data_uri_preserved_in_non_bg_context():
    """Data URI in non-background-image url() context preserved (3.6)."""
    html = '<html><body><div style="content: url(data:image/svg+xml;base64,PHN2ZyB4bWxucz0=)"></div></body></html>'
    result = convert_html(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    assert "data:image/svg+xml;base64" in result, (
        f"Data URI should be preserved, got: {result}"
    )


def test_fragment_url_preserved():
    """Fragment-only url() reference preserved."""
    html = '<html><body><div style="clip-path: url(#clipShape)"></div></body></html>'
    result = convert_html(html, TAB_URL, filename_map={})
    assert "url(#clipShape)" in result, (
        f"Fragment URL should be preserved, got: {result}"
    )


# ---------------------------------------------------------------------------
# Single-parse verification tests (server-mode-performance)
# ---------------------------------------------------------------------------


def test_single_parse_converts_all_element_types():
    """Single parse of convert_html converts all 7 element types on one soup tree.

    Verifies that parsing happens once and all conversion passes operate on
    the same soup object, producing correct output for every element type.
    """
    html = """<!DOCTYPE html>
<html>
<head>
    <base href="https://example.com/">
    <link rel="stylesheet" href="https://example.com/css/style.css">
    <style>body { background-image: url('https://example.com/images/photo.jpg'); }</style>
</head>
<body>
    <img src="https://example.com/images/photo.jpg">
    <img data-src="https://example.com/images/logo.png" src="data:placeholder">
    <img srcset="https://example.com/images/hero.webp 2x">
    <div style="background-image: url('https://example.com/images/photo.jpg')"></div>
    <script src="https://example.com/js/app.js"></script>
    <a href="https://example.com/docs/report.pdf">Report</a>
    <a href="https://example.com/about.html">About</a>
    <object type="image/svg+xml" data="https://example.com/images/diagram.svg"></object>
</body>
</html>"""

    result = convert_html(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(result, "lxml")

    # 1. Base tag removed
    assert soup.find("base") is None, "Base tag should be removed"

    # 2. Links converted
    hrefs = [a.get("href", "") for a in soup.find_all("a")]
    assert "./documents/report.pdf" in hrefs, f"Link conversion missing: {hrefs}"

    # 3. Images converted
    img_srcs = [img.get("src", "") for img in soup.find_all("img")]
    assert "./images/photo.jpg" in img_srcs, f"Image conversion missing: {img_srcs}"

    # 4. Background images converted (inline style)
    assert "./images/photo.jpg" in result, "Background image not converted"

    # 5. Object elements converted
    obj_datas = [obj.get("data", "") for obj in soup.find_all("object")]
    assert any(d.startswith("./images/") for d in obj_datas), f"Object conversion missing: {obj_datas}"

    # 6. Stylesheets converted
    links = soup.find_all("link", rel="stylesheet")
    assert any(l.get("href") == "./styles/style.css" for l in links), "Stylesheet conversion missing"

    # 7. Scripts converted
    scripts = [s.get("src", "") for s in soup.find_all("script", src=True)]
    assert "./scripts/app.js" in scripts, f"Script conversion missing: {scripts}"


def test_conversion_order_preserved():
    """Conversion order: remove base → links → images → bg images → objects → stylesheets → scripts.

    Verify by checking that a <base> tag is removed before links are converted
    (if base were still present, it could affect URL resolution). Also verify
    that images converted after links don't break link hrefs.
    """
    # HTML with a base tag and a link that should be converted as a page link
    html = """<html>
<head>
    <base href="https://example.com/">
</head>
<body>
    <a href="https://example.com/about">About</a>
    <img src="https://example.com/images/photo.jpg">
    <link rel="stylesheet" href="https://example.com/css/style.css">
    <script src="https://example.com/js/app.js"></script>
</body>
</html>"""

    result = convert_html(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(result, "lxml")

    # Base tag must be gone
    assert soup.find("base") is None, "Base tag should be removed first"

    # Link should be converted to local path (not affected by base tag)
    hrefs = [a.get("href", "") for a in soup.find_all("a")]
    assert "./pages/about.html" in hrefs, f"Link should be ./pages/about.html, got: {hrefs}"

    # Image, stylesheet, and script should all be converted
    assert "./images/photo.jpg" in result, "Image not converted"
    assert "./styles/style.css" in result, "Stylesheet not converted"
    assert "./scripts/app.js" in result, "Script not converted"


def test_single_parse_linked_page_uses_dotdot_prefix():
    """Linked page single-parse conversion uses ../ prefix for all resource types."""
    html = """<html>
<head>
    <link rel="stylesheet" href="https://example.com/css/style.css">
</head>
<body>
    <img src="https://example.com/images/photo.jpg">
    <div style="background-image: url('https://example.com/images/logo.png')"></div>
    <script src="https://example.com/js/app.js"></script>
    <a href="https://example.com/docs/report.pdf">Report</a>
    <object type="image/svg+xml" data="https://example.com/images/diagram.svg"></object>
</body>
</html>"""

    result = convert_html_for_linked_page(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(result, "lxml")

    # All paths must use ../ prefix
    img_srcs = [img.get("src", "") for img in soup.find_all("img")]
    assert "../images/photo.jpg" in img_srcs, f"Image: {img_srcs}"

    links = [l.get("href", "") for l in soup.find_all("link", rel="stylesheet")]
    assert "../styles/style.css" in links, f"Stylesheet: {links}"

    scripts = [s.get("src", "") for s in soup.find_all("script", src=True)]
    assert "../scripts/app.js" in scripts, f"Script: {scripts}"

    hrefs = [a.get("href", "") for a in soup.find_all("a")]
    assert "../documents/report.pdf" in hrefs, f"Doc link: {hrefs}"

    assert "../images/logo.png" in result, "Background image not using ../"

    obj_datas = [obj.get("data", "") for obj in soup.find_all("object")]
    assert any(d.startswith("../images/") for d in obj_datas), f"Object: {obj_datas}"


def test_single_parse_output_deterministic():
    """Same input always produces the same output (single-parse is deterministic)."""
    html = '<html><body><img src="https://example.com/images/photo.jpg"><a href="https://example.com/about">About</a></body></html>'

    result1 = convert_html(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)
    result2 = convert_html(html, TAB_URL, filename_map=SAMPLE_FILENAME_MAP)

    assert result1 == result2, "Single-parse conversion should produce deterministic output"


# ---------------------------------------------------------------------------
# Content-type map fallback tests (fix-bin-image-extensions)
# ---------------------------------------------------------------------------


def test_lookup_content_type_exact_match():
    """_lookup_content_type finds exact URL match."""
    assert _lookup_content_type(
        "https://cdn.example.com/img/abc123", TAB_URL, SAMPLE_CONTENT_TYPE_MAP
    ) == "image/jpeg"


def test_lookup_content_type_clean_url():
    """_lookup_content_type matches after stripping query params."""
    assert _lookup_content_type(
        "https://cdn.example.com/img/abc123?wid=400&fmt=jpeg", TAB_URL, SAMPLE_CONTENT_TYPE_MAP
    ) == "image/jpeg"


def test_lookup_content_type_resolved_url():
    """_lookup_content_type resolves relative URLs before lookup."""
    ct_map = {"https://example.com/img/abc": "image/png"}
    # Relative URL resolved against tab_url
    assert _lookup_content_type("/img/abc", TAB_URL, ct_map) == "image/png"


def test_lookup_content_type_no_match():
    """_lookup_content_type returns None when URL not found."""
    assert _lookup_content_type(
        "https://unknown.com/img/xyz", TAB_URL, SAMPLE_CONTENT_TYPE_MAP
    ) is None


def test_lookup_content_type_none_map():
    """_lookup_content_type returns None when map is None."""
    assert _lookup_content_type("https://cdn.example.com/img/abc123", TAB_URL, None) is None


def test_img_src_extensionless_url_with_content_type():
    """<img src> with extensionless URL uses content-type for correct extension."""
    html = '<html><body><img src="https://cdn.example.com/img/abc123?wid=400&fmt=jpeg"></body></html>'
    result = convert_html(html, TAB_URL, filename_map={}, content_type_map=SAMPLE_CONTENT_TYPE_MAP)
    srcs = _get_attr(result, "img", "src")
    assert any(s.startswith("./images/") and s.endswith(".jpg") for s in srcs), (
        f"Expected .jpg extension from content-type, got: {srcs}"
    )
    assert not any(s.endswith(".bin") for s in srcs), (
        f"Should not have .bin extension when content-type available, got: {srcs}"
    )


def test_img_src_no_content_type_falls_back_to_bin():
    """<img src> with extensionless URL and no content-type falls back to .bin."""
    html = '<html><body><img src="https://unknown.com/img/xyz"></body></html>'
    result = convert_html(html, TAB_URL, filename_map={}, content_type_map=SAMPLE_CONTENT_TYPE_MAP)
    srcs = _get_attr(result, "img", "src")
    assert any(s.endswith(".bin") for s in srcs), (
        f"Expected .bin fallback, got: {srcs}"
    )


def test_lazy_load_extensionless_url_with_content_type():
    """Lazy-load data-src with extensionless URL uses content-type for extension."""
    html = '<html><body><img data-src="https://cdn.example.com/img/abc123" src="placeholder.gif"></body></html>'
    result = convert_html(html, TAB_URL, filename_map={}, content_type_map=SAMPLE_CONTENT_TYPE_MAP)
    data_srcs = _get_attr(result, "img", "data-src")
    assert any(s.endswith(".jpg") for s in data_srcs), (
        f"Expected .jpg from content-type in data-src, got: {data_srcs}"
    )


def test_srcset_extensionless_url_with_content_type():
    """srcset URL with no extension uses content-type for correct extension."""
    html = '<html><body><img srcset="https://cdn.example.com/img/abc123 2x"></body></html>'
    result = convert_html(html, TAB_URL, filename_map={}, content_type_map=SAMPLE_CONTENT_TYPE_MAP)
    srcsets = _get_attr(result, "img", "srcset")
    assert any(".jpg" in s for s in srcsets), (
        f"Expected .jpg from content-type in srcset, got: {srcsets}"
    )


def test_source_src_extensionless_url_with_content_type():
    """<source src> with extensionless URL uses content-type for extension."""
    html = '<html><body><picture><source src="https://cdn.example.com/img/abc123" type="image/jpeg"></picture></body></html>'
    result = convert_html(html, TAB_URL, filename_map={}, content_type_map=SAMPLE_CONTENT_TYPE_MAP)
    srcs = _get_attr(result, "source", "src")
    assert any(s.endswith(".jpg") for s in srcs), (
        f"Expected .jpg from content-type on <source src>, got: {srcs}"
    )


def test_inline_style_extensionless_url_with_content_type():
    """CSS url() in inline style with extensionless URL uses content-type."""
    html = '<html><body><div style="background-image: url(\'https://cdn.example.com/img/abc123\')"></div></body></html>'
    result = convert_html(html, TAB_URL, filename_map={}, content_type_map=SAMPLE_CONTENT_TYPE_MAP)
    assert ".jpg" in result, (
        f"Expected .jpg from content-type in inline style url(), got: {result}"
    )


def test_style_tag_extensionless_url_with_content_type():
    """CSS url() in <style> tag with extensionless URL uses content-type."""
    html = '<html><head><style>.bg { background: url(\'https://cdn.example.com/img/abc123\'); }</style></head><body></body></html>'
    result = convert_html(html, TAB_URL, filename_map={}, content_type_map=SAMPLE_CONTENT_TYPE_MAP)
    assert ".jpg" in result, (
        f"Expected .jpg from content-type in <style> tag url(), got: {result}"
    )


def test_external_css_url_extensionless_with_content_type():
    """External CSS url() with extensionless URL uses content-type."""
    html = '<html><body><div style="background: url(\'https://cdn.other.com/assets/hero\')"></div></body></html>'
    result = convert_html(html, TAB_URL, filename_map={}, content_type_map=SAMPLE_CONTENT_TYPE_MAP)
    assert ".webp" in result, (
        f"Expected .webp from content-type for external URL, got: {result}"
    )


def test_css_file_extensionless_url_with_content_type():
    """Standalone CSS file url() with extensionless URL uses content-type."""
    css = "body { background: url('https://cdn.example.com/img/abc123'); }"
    result = convert_css_file(css, TAB_URL, filename_map={}, content_type_map=SAMPLE_CONTENT_TYPE_MAP)
    assert ".jpg" in result, (
        f"Expected .jpg from content-type in CSS file url(), got: {result}"
    )


def test_content_type_map_does_not_override_filename_map():
    """Filename map takes priority over content-type map."""
    html = '<html><body><img src="https://example.com/images/photo.jpg"></body></html>'
    result = convert_html(
        html, TAB_URL,
        filename_map={"https://example.com/images/photo.jpg": "images/photo.jpg"},
        content_type_map=SAMPLE_CONTENT_TYPE_MAP,
    )
    srcs = _get_attr(result, "img", "src")
    assert "./images/photo.jpg" in srcs, (
        f"Filename map should win, got: {srcs}"
    )


def test_linked_page_extensionless_url_with_content_type():
    """Linked page content-type fallback uses ../ prefix."""
    html = '<html><body><img src="https://cdn.example.com/img/abc123"></body></html>'
    result = convert_html_for_linked_page(
        html, TAB_URL, filename_map={}, content_type_map=SAMPLE_CONTENT_TYPE_MAP,
    )
    srcs = _get_attr(result, "img", "src")
    assert any(s.startswith("../images/") and s.endswith(".jpg") for s in srcs), (
        f"Expected ../images/...jpg for linked page, got: {srcs}"
    )


def test_all_fallback_paths_content_type_aware():
    """All 6 fallback paths produce correct extension from content-type map."""
    ct_map = {"https://cdn.example.com/img/x": "image/png"}
    html = """<html>
<head><style>.bg { background: url('https://cdn.example.com/img/x'); }</style></head>
<body>
    <img src="https://cdn.example.com/img/x">
    <img data-src="https://cdn.example.com/img/x" src="placeholder.gif">
    <img srcset="https://cdn.example.com/img/x 2x">
    <picture><source src="https://cdn.example.com/img/x"></picture>
    <div style="background: url('https://cdn.example.com/img/x')"></div>
</body>
</html>"""
    result = convert_html(html, TAB_URL, filename_map={}, content_type_map=ct_map)

    # Count .png occurrences across all converted paths
    assert result.count(".png") >= 6, (
        f"Expected .png in all 6 fallback paths, found {result.count('.png')} in:\n{result}"
    )
    # No .bin anywhere
    assert ".bin" not in result, (
        f"Should have no .bin when content-type available, got: {result}"
    )


# ---------------------------------------------------------------------------
# CSS inlining for file:// protocol (inline-css-file-protocol-fix)
# ---------------------------------------------------------------------------


def _make_css_file(storage_root, session_id, relative_path, content):
    """Helper: write a CSS file to the test storage tree and return full path."""
    import os
    file_dir = os.path.join(storage_root, session_id, "resources", os.path.dirname(relative_path))
    os.makedirs(file_dir, exist_ok=True)
    file_path = os.path.join(storage_root, session_id, "resources", relative_path)
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(content)
    return file_path


def test_inline_css_replaces_link_with_style():
    """<link rel="stylesheet"> replaced with inline <style> tag."""
    with tempfile.TemporaryDirectory() as tmp:
        sid = "test-session"
        _make_css_file(tmp, sid, "styles/main.css", "body { color: red; }")

        html = '<html><head><link rel="stylesheet" href="./styles/main.css"></head><body></body></html>'
        result = inline_css_into_html(html, tmp, sid, path="./")

        from bs4 import BeautifulSoup
        soup = BeautifulSoup(result, "lxml")
        assert soup.find("link", rel="stylesheet") is None, "Link tag should be removed"
        style = soup.find("style")
        assert style is not None, "Style tag should exist"
        assert "body { color: red; }" in (style.string or ""), f"CSS content missing, got: {style.string}"


def test_inline_css_adjusts_url_paths_for_root():
    """url(../images/) adjusted to url(./images/) when inlining into root page."""
    with tempfile.TemporaryDirectory() as tmp:
        sid = "test-session"
        css_with_urls = "body { background: url(../images/bg.jpg); }"
        _make_css_file(tmp, sid, "styles/theme.css", css_with_urls)

        html = '<html><head><link rel="stylesheet" href="./styles/theme.css"></head><body></body></html>'
        result = inline_css_into_html(html, tmp, sid, path="./")

        assert "./images/bg.jpg" in result, f"Expected ./images/ path, got: {result}"
        assert "../images/bg.jpg" not in result, f"../images/ should be rewritten, got: {result}"


def test_inline_css_preserves_url_paths_for_linked_page():
    """url(../images/) preserved when inlining into linked page (../ prefix)."""
    with tempfile.TemporaryDirectory() as tmp:
        sid = "test-session"
        css_with_urls = "body { background: url(../images/bg.jpg); }"
        _make_css_file(tmp, sid, "styles/theme.css", css_with_urls)

        html = '<html><head><link rel="stylesheet" href="../styles/theme.css"></head><body></body></html>'
        result = inline_css_into_html(html, tmp, sid, path="../")

        assert "../images/bg.jpg" in result, f"../images/ should be preserved for linked page, got: {result}"


def test_inline_css_missing_file_keeps_link():
    """Missing CSS file leaves <link> tag unchanged."""
    with tempfile.TemporaryDirectory() as tmp:
        sid = "test-session"
        # No CSS file created
        html = '<html><head><link rel="stylesheet" href="./styles/missing.css"></head><body></body></html>'
        result = inline_css_into_html(html, tmp, sid, path="./")

        from bs4 import BeautifulSoup
        soup = BeautifulSoup(result, "lxml")
        link = soup.find("link", rel="stylesheet")
        assert link is not None, "Link tag should be preserved when CSS file missing"


def test_inline_css_multiple_stylesheets():
    """Multiple <link> tags all replaced with inline <style> tags."""
    with tempfile.TemporaryDirectory() as tmp:
        sid = "test-session"
        _make_css_file(tmp, sid, "styles/a.css", ".a { color: blue; }")
        _make_css_file(tmp, sid, "styles/b.css", ".b { color: green; }")

        html = '<html><head><link rel="stylesheet" href="./styles/a.css"><link rel="stylesheet" href="./styles/b.css"></head><body></body></html>'
        result = inline_css_into_html(html, tmp, sid, path="./")

        from bs4 import BeautifulSoup
        soup = BeautifulSoup(result, "lxml")
        styles = soup.find_all("style")
        assert len(styles) == 2, f"Expected 2 style tags, got {len(styles)}"
        combined = " ".join(s.string or "" for s in styles)
        assert "color: blue" in combined, f"Missing first CSS, got: {combined}"
        assert "color: green" in combined, f"Missing second CSS, got: {combined}"


# ---------------------------------------------------------------------------
# Extensionless stylesheet/script fallbacks (inline-css-file-protocol-fix)
# ---------------------------------------------------------------------------


def test_extensionless_stylesheet_gets_css_extension():
    """Stylesheet URL with no extension gets .css fallback."""
    html = '<html><head><link rel="stylesheet" href="/styles/main"></head><body></body></html>'
    result = convert_html(html, TAB_URL, filename_map={})
    hrefs = _get_attr(result, "link", "href")
    assert any(h.endswith(".css") for h in hrefs), f"Expected .css extension, got: {hrefs}"
    assert any("styles/" in h for h in hrefs), f"Expected styles/ prefix, got: {hrefs}"


def test_extensionless_script_gets_js_extension():
    """Script URL with no extension gets .js fallback."""
    html = '<html><body><script src="/scripts/client"></script></body></html>'
    result = convert_html(html, TAB_URL, filename_map={})
    srcs = _get_attr(result, "script", "src")
    assert any(s.endswith(".js") for s in srcs), f"Expected .js extension, got: {srcs}"
    assert any("scripts/" in s for s in srcs), f"Expected scripts/ prefix, got: {srcs}"


def test_stylesheet_undefined_prefix_stripped():
    """Stylesheet filename starting with 'undefined' has prefix stripped."""
    html = '<html><head><link rel="stylesheet" href="https://example.com/css/undefinedhome.desktop.css"></head><body></body></html>'
    result = convert_html(html, TAB_URL, filename_map={})
    hrefs = _get_attr(result, "link", "href")
    assert any("undefined" not in h for h in hrefs), f"Expected 'undefined' stripped, got: {hrefs}"
    assert any("home.desktop.css" in h for h in hrefs), f"Expected home.desktop.css, got: {hrefs}"


def test_script_undefined_prefix_stripped():
    """Script filename starting with 'undefined' has prefix stripped."""
    html = '<html><body><script src="https://example.com/js/undefinedbrowser-perf.8417c6bba72228fa2e29.js"></script></body></html>'
    result = convert_html(html, TAB_URL, filename_map={})
    srcs = _get_attr(result, "script", "src")
    assert any("undefined" not in s for s in srcs), f"Expected 'undefined' stripped, got: {srcs}"
    assert any("browser-perf.8417c6bba72228fa2e29.js" in s for s in srcs), f"Expected browser-perf filename, got: {srcs}"


def test_extensionless_stylesheet_linked_page():
    """Extensionless stylesheet on linked page uses ../ prefix with .css fallback."""
    html = '<html><head><link rel="stylesheet" href="/styles/main"></head><body></body></html>'
    result = convert_html_for_linked_page(html, TAB_URL, filename_map={})
    hrefs = _get_attr(result, "link", "href")
    assert any(h.startswith("../styles/") and h.endswith(".css") for h in hrefs), (
        f"Expected ../styles/...css for linked page, got: {hrefs}"
    )


def test_extensionless_script_linked_page():
    """Extensionless script on linked page uses ../ prefix with .js fallback."""
    html = '<html><body><script src="/scripts/client"></script></body></html>'
    result = convert_html_for_linked_page(html, TAB_URL, filename_map={})
    srcs = _get_attr(result, "script", "src")
    assert any(s.startswith("../scripts/") and s.endswith(".js") for s in srcs), (
        f"Expected ../scripts/...js for linked page, got: {srcs}"
    )


# ---------------------------------------------------------------------------
# UUID-based storage path resolution (inline-css-file-protocol-fix)
# ---------------------------------------------------------------------------


def test_resolve_local_path_with_uuid_map():
    """_resolve_local_path resolves UUID-stored file via mapping."""
    import uuid
    with tempfile.TemporaryDirectory() as tmp:
        sid = "test-session"
        resources_dir = os.path.join(tmp, sid, "resources")
        os.makedirs(resources_dir, exist_ok=True)

        # Create a UUID-named file on disk
        uuid_name = str(uuid.uuid4())
        uuid_path = os.path.join(resources_dir, uuid_name)
        with open(uuid_path, "w") as f:
            f.write("body { color: red; }")

        # Mapping: local_path → actual disk path
        mapping = {"styles/main.css": uuid_path}

        result = _resolve_local_path(
            "./styles/main.css", tmp, sid, local_path_to_storage=mapping
        )
        assert result == uuid_path, f"Expected {uuid_path}, got: {result}"


def test_resolve_local_path_without_map_falls_back():
    """_resolve_local_path falls back to direct path when no mapping."""
    with tempfile.TemporaryDirectory() as tmp:
        sid = "test-session"
        resources_dir = os.path.join(tmp, sid, "resources", "styles")
        os.makedirs(resources_dir, exist_ok=True)

        # Create file at human-readable path
        file_path = os.path.join(resources_dir, "main.css")
        with open(file_path, "w") as f:
            f.write("body { color: red; }")

        result = _resolve_local_path(
            "./styles/main.css", tmp, sid, local_path_to_storage=None
        )
        assert result is not None, "Should find file via direct path fallback"
        assert result.endswith("styles/main.css"), f"Got: {result}"


def test_resolve_local_path_uuid_map_takes_priority():
    """UUID mapping takes priority over direct path."""
    import uuid
    with tempfile.TemporaryDirectory() as tmp:
        sid = "test-session"
        resources_dir = os.path.join(tmp, sid, "resources")
        os.makedirs(resources_dir, exist_ok=True)

        # Create UUID-named file
        uuid_name = str(uuid.uuid4())
        uuid_path = os.path.join(resources_dir, uuid_name)
        with open(uuid_path, "w") as f:
            f.write("uuid content")

        # Also create human-readable file (should NOT be returned)
        styles_dir = os.path.join(resources_dir, "styles")
        os.makedirs(styles_dir, exist_ok=True)
        with open(os.path.join(styles_dir, "main.css"), "w") as f:
            f.write("human content")

        mapping = {"styles/main.css": uuid_path}
        result = _resolve_local_path(
            "./styles/main.css", tmp, sid, local_path_to_storage=mapping
        )
        assert result == uuid_path, f"UUID mapping should win, got: {result}"


def test_inline_css_with_uuid_storage():
    """inline_css_into_html works with UUID-stored CSS files via mapping."""
    import uuid
    with tempfile.TemporaryDirectory() as tmp:
        sid = "test-session"
        resources_dir = os.path.join(tmp, sid, "resources")
        os.makedirs(resources_dir, exist_ok=True)

        # Create UUID-named CSS file
        uuid_name = str(uuid.uuid4())
        uuid_path = os.path.join(resources_dir, uuid_name)
        with open(uuid_path, "w") as f:
            f.write("body { color: blue; }")

        mapping = {"styles/theme.css": uuid_path}

        html = '<html><head><link rel="stylesheet" href="./styles/theme.css"></head><body></body></html>'
        result = inline_css_into_html(html, tmp, sid, path="./", local_path_to_storage=mapping)

        from bs4 import BeautifulSoup
        soup = BeautifulSoup(result, "lxml")
        assert soup.find("link", rel="stylesheet") is None, "Link should be replaced"
        style = soup.find("style")
        assert style is not None, "Style tag should exist"
        assert "color: blue" in (style.string or ""), f"CSS content missing, got: {style.string}"


def test_inline_css_with_uuid_storage_and_url_adjustment():
    """UUID-stored CSS with url() paths gets adjusted when inlining into root."""
    import uuid
    with tempfile.TemporaryDirectory() as tmp:
        sid = "test-session"
        resources_dir = os.path.join(tmp, sid, "resources")
        os.makedirs(resources_dir, exist_ok=True)

        uuid_name = str(uuid.uuid4())
        uuid_path = os.path.join(resources_dir, uuid_name)
        with open(uuid_path, "w") as f:
            f.write("body { background: url(../images/bg.jpg); }")

        mapping = {"styles/theme.css": uuid_path}

        html = '<html><head><link rel="stylesheet" href="./styles/theme.css"></head><body></body></html>'
        result = inline_css_into_html(html, tmp, sid, path="./", local_path_to_storage=mapping)

        assert "./images/bg.jpg" in result, f"Expected ./images/ path, got: {result}"
        assert "../images/bg.jpg" not in result, f"../images/ should be rewritten"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def run_all():
    tests = [
        # 5.11
        test_image_src_conversion_with_filename_map,
        test_image_src_conversion_without_map,
        test_lazy_load_data_src,
        test_srcset_conversion,
        test_inline_style_background_image,
        test_script_conversion,
        test_stylesheet_conversion,
        test_preload_link_conversion,
        test_link_document_conversion,
        test_link_html_page_conversion,
        test_link_clean_url_conversion,
        test_external_link_unchanged,
        test_anchor_link_unchanged,
        test_object_element_conversion,
        test_base_tag_removed,
        test_all_resource_types_combined,
        # 5.12
        test_css_file_image_url,
        test_css_file_font_url,
        test_css_file_data_uri_unchanged,
        test_css_file_relative_path_unchanged,
        test_css_file_import_same_directory,
        test_css_file_query_params_stripped,
        test_css_file_external_import_unchanged,
        # 5.13
        test_linked_page_images,
        test_linked_page_stylesheets,
        test_linked_page_scripts,
        test_linked_page_documents,
        test_linked_page_html_links,
        test_linked_page_background_images,
        test_linked_page_object_elements,
        test_linked_page_all_resource_types,
        # Utility
        test_fix_filename,
        test_generate_image_filename,
        # Additional coverage
        test_style_tag_background_image,
        test_script_filename_map,
        test_stylesheet_filename_map,
        test_source_src_attribute,
        test_source_src_with_data_uri_unchanged,
        test_linked_page_style_tag_background_image,
        # generate_page_filename (linked-page-scraping-parity 5.1)
        test_generate_page_filename_basic,
        test_generate_page_filename_nested_path,
        test_generate_page_filename_root_url,
        test_generate_page_filename_root_no_slash,
        test_generate_page_filename_already_html,
        test_generate_page_filename_trailing_slash,
        test_generate_page_filename_query_params,
        test_generate_page_filename_fragment,
        test_generate_page_filename_special_chars,
        test_generate_page_filename_empty_input,
        test_generate_page_filename_matches_convert_links,
        # CSS url() conversion (fix-css-url-conversion)
        test_inline_style_css_custom_property_url,
        test_inline_style_shorthand_background_url,
        test_inline_style_list_style_image_url,
        test_style_tag_css_custom_property_url,
        test_multiple_url_in_same_inline_style,
        test_data_uri_preserved_in_non_bg_context,
        test_fragment_url_preserved,
        # Single-parse verification (server-mode-performance)
        test_single_parse_converts_all_element_types,
        test_conversion_order_preserved,
        test_single_parse_linked_page_uses_dotdot_prefix,
        test_single_parse_output_deterministic,
        # Content-type map fallback (fix-bin-image-extensions)
        test_lookup_content_type_exact_match,
        test_lookup_content_type_clean_url,
        test_lookup_content_type_resolved_url,
        test_lookup_content_type_no_match,
        test_lookup_content_type_none_map,
        test_img_src_extensionless_url_with_content_type,
        test_img_src_no_content_type_falls_back_to_bin,
        test_lazy_load_extensionless_url_with_content_type,
        test_srcset_extensionless_url_with_content_type,
        test_source_src_extensionless_url_with_content_type,
        test_inline_style_extensionless_url_with_content_type,
        test_style_tag_extensionless_url_with_content_type,
        test_external_css_url_extensionless_with_content_type,
        test_css_file_extensionless_url_with_content_type,
        test_content_type_map_does_not_override_filename_map,
        test_linked_page_extensionless_url_with_content_type,
        test_all_fallback_paths_content_type_aware,
        # CSS inlining (inline-css-file-protocol-fix)
        test_inline_css_replaces_link_with_style,
        test_inline_css_adjusts_url_paths_for_root,
        test_inline_css_preserves_url_paths_for_linked_page,
        test_inline_css_missing_file_keeps_link,
        test_inline_css_multiple_stylesheets,
        # Extensionless/undefined fallbacks (inline-css-file-protocol-fix)
        test_extensionless_stylesheet_gets_css_extension,
        test_extensionless_script_gets_js_extension,
        test_stylesheet_undefined_prefix_stripped,
        test_script_undefined_prefix_stripped,
        test_extensionless_stylesheet_linked_page,
        test_extensionless_script_linked_page,
        # UUID-based storage path resolution (inline-css-file-protocol-fix)
        test_resolve_local_path_with_uuid_map,
        test_resolve_local_path_without_map_falls_back,
        test_resolve_local_path_uuid_map_takes_priority,
        test_inline_css_with_uuid_storage,
        test_inline_css_with_uuid_storage_and_url_adjustment,
    ]

    passed = 0
    failed = 0
    for test_fn in tests:
        name = test_fn.__name__
        try:
            test_fn()
            print(f"  [PASS] {name}")
            passed += 1
        except AssertionError as e:
            print(f"  [FAIL] {name}: {e}")
            failed += 1
        except Exception as e:
            print(f"  [ERROR] {name}: {e}")
            failed += 1

    print(f"\nResults: {passed} passed, {failed} failed, {passed + failed} total")
    return failed == 0


if __name__ == "__main__":
    success = run_all()
    sys.exit(0 if success else 1)
