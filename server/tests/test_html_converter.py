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
    fix_filename,
    generate_image_filename,
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
    # With image extension
    assert generate_image_filename("https://example.com/img/photo.jpg") == "photo.jpg"
    # Without image extension
    result = generate_image_filename("https://example.com/bbcswebdav/xid-31821076_1")
    assert result.endswith(".bin")  # Default extension when no Content-Type
    # With Content-Type
    result = generate_image_filename("/bbcswebdav/xid-31821076_1", "image/png")
    assert result.endswith(".png")


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
