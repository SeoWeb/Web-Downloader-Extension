"""Tests for Round 8: images-only cloud sessions push a gallery page.

Production evidence (2026-10-27, session 48a92f67, alks.fi): an images-only
cloud session (downloadHtml=false, no markdown/text) uploaded 351 images and
finalized fine, but the cloud push failed by design — the zero-document
guard rejected the push, the cloud branch never builds a local ZIP, and the
archive data model requires html_content or a text document. The session had
NO representation anywhere.

Verifies:
  – Images-only cloud session → a gallery page is pushed with the captured
    images as pushed assets, cloud_status="success" (push-only, no local
    zip).
  – Gallery title: <title> of the merged main HTML when present, else the
    source URL hostname; " — Image Gallery" suffix.
  – Nothing at all (no documents, no images) → cloud_status="failed" with
    the explicit CLOUD_NOTHING_TO_PUSH_ERROR.
  – Regression: html push and markdown/text push payloads are unchanged
    (gallery only applies when NO document exists).
  – Asset paths with spaces/unicode → src percent-encoded and
    attribute-escaped, unquoting back to the exact pushed filenames;
    stable path ordering.
"""

import asyncio
import re
import types
from unittest.mock import patch
from urllib.parse import unquote

import pytest

from app.services.zip_assembler import (
    CLOUD_NOTHING_TO_PUSH_ERROR,
    ZipAssemblerService,
)


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def storage_root(tmp_path):
    return str(tmp_path)


@pytest.fixture
def assembler(storage_root):
    return ZipAssemblerService(storage_root=storage_root)


class MockDB:
    async def flush(self):
        pass


def _make_session(
    session_id="gallery-1",
    url="https://example.com/page",
    pagepocket_user_id="user-1",
):
    """Mock session object carrying every attribute the push path reads."""
    return types.SimpleNamespace(
        id=session_id,
        url=url,
        status="assembling",
        assembly_phase="assembling_zip",
        assembly_progress_pct=0,
        options={"singleFile": False},
        pagepocket_user_id=pagepocket_user_id,
        cloud_status=None,
        cloud_page_id=None,
        cloud_error=None,
        zip_path=None,
        error_message=None,
        filename_map={},
    )


def _run_cloud_push(
    assembler, session, main_html, *,
    build_assets=None, download_html=False,
    markdown_content=None, text_content=None,
    push_result=None,
):
    """Run _assemble_cloud_push with collaborators stubbed; capture kwargs.

    Mirrors the TestCloudPushTextParts pattern in test_text_native_outputs:
    _build_cloud_assets is replaced (the seam the zero-document guard uses)
    and archive_client.push_to_archive is patched to capture its payload.
    """
    captured = {}
    push_result = push_result or types.SimpleNamespace(
        page_id="page-ok", error=None,
    )

    async def _mock_build(sid, db, archive_paths=None):
        return list(build_assets or [])

    async def _no_progress(db, sess, phase, pct, **kwargs):
        pass

    assembler._build_cloud_assets = _mock_build
    assembler._update_progress = _no_progress

    def _capture_push(**kwargs):
        captured.update(kwargs)
        return push_result

    with patch(
        "app.services.archive_client.push_to_archive",
        side_effect=_capture_push,
    ):
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(
                assembler._assemble_cloud_push(
                    session.id, MockDB(), session,
                    main_html, {}, {},
                    download_html=download_html,
                    markdown_content=markdown_content,
                    text_content=text_content,
                )
            )
        finally:
            loop.close()
    return captured


def _img_srcs(html_text):
    return re.findall(r'<img src="([^"]+)"', html_text)


# ---------------------------------------------------------------------------
# Gallery push (images-only cloud session)
# ---------------------------------------------------------------------------


class TestImagesOnlyGalleryPush:
    """No documents + image resources → gallery page push, success."""

    def test_images_only_session_pushes_gallery_page(self, assembler):
        session = _make_session("gallery-basic")
        main_html = (
            "<html><head><title>My Page</title></head><body>x</body></html>"
        )
        assets = [
            (f"images/photo-{i}.jpg", "image/jpeg", bytes([i]) * 10)
            for i in range(3)
        ]

        captured = _run_cloud_push(
            assembler, session, main_html, build_assets=assets,
        )

        # Push called exactly once with a gallery document (not the raw
        # main HTML — that is not wanted when downloadHtml is false).
        html_text = captured["html_content"].decode("utf-8")
        assert "<title>My Page — Image Gallery</title>" in html_text
        assert "My Page — Image Gallery" in html_text  # h1 too
        srcs = _img_srcs(html_text)
        assert srcs == [
            "images/photo-0.jpg", "images/photo-1.jpg", "images/photo-2.jpg",
        ]
        # The pushed assets are exactly the captured images (sorted).
        assert [a[0] for a in captured["assets"]] == [
            "images/photo-0.jpg", "images/photo-1.jpg", "images/photo-2.jpg",
        ]
        assert captured["title"] == "My Page — Image Gallery"
        assert captured["markdown_content"] is None
        assert captured["text_content"] is None
        assert captured["user_id"] == "user-1"
        assert captured["session_id"] == "gallery-basic"
        # Success state, push-only (no local artifact).
        assert session.cloud_status == "success"
        assert session.cloud_page_id == "page-ok"
        assert session.cloud_error is None
        assert session.status == "ready"
        assert session.zip_path is None
        assert session.assembly_phase is None

    def test_gallery_excludes_non_image_assets(self, assembler):
        """Only image resources become gallery assets/img tags."""
        session = _make_session("gallery-filter")
        assets = [
            ("styles/main.css", "text/css", b"css"),
            ("images/a.png", "image/png", b"png"),
            ("scripts/app.js", "text/javascript", b"js"),
        ]

        captured = _run_cloud_push(
            assembler, session, "<html><body>x</body></html>",
            build_assets=assets,
        )

        assert [a[0] for a in captured["assets"]] == ["images/a.png"]
        assert _img_srcs(captured["html_content"].decode("utf-8")) == [
            "images/a.png",
        ]

    def test_gallery_assets_are_sorted_by_path(self, assembler):
        """Stable ordering regardless of the build/DB order."""
        session = _make_session("gallery-order")
        assets = [
            ("images/c.png", "image/png", b"c"),
            ("images/a.png", "image/png", b"a"),
            ("images/b.png", "image/png", b"b"),
        ]

        captured = _run_cloud_push(
            assembler, session, "<html><body>x</body></html>",
            build_assets=assets,
        )

        expected = ["images/a.png", "images/b.png", "images/c.png"]
        assert [a[0] for a in captured["assets"]] == expected
        assert _img_srcs(captured["html_content"].decode("utf-8")) == expected

    def test_gallery_is_self_contained(self, assembler):
        """No external refs, no scripts; styles are inline only."""
        session = _make_session("gallery-standalone")
        captured = _run_cloud_push(
            assembler, session, "<html><body>x</body></html>",
            build_assets=[("images/a.png", "image/png", b"png")],
        )
        html_text = captured["html_content"].decode("utf-8")
        assert html_text.lstrip().startswith("<!DOCTYPE html>")
        assert "<style>" in html_text
        assert "<script" not in html_text
        # The only remote-looking URLs are the relative image srcs.
        for src in _img_srcs(html_text):
            assert "://" not in src
            assert src.startswith("images/")


# ---------------------------------------------------------------------------
# Gallery title
# ---------------------------------------------------------------------------


class TestGalleryTitle:
    def test_title_from_merged_main_html(self, assembler):
        """<title> of the merged main HTML wins (merge runs pre-branch)."""
        session = _make_session("gallery-title-html")
        main_html = (
            "<html><head><title>Deep Thoughts</title></head>"
            "<body>x</body></html>"
        )

        captured = _run_cloud_push(assembler, session, main_html,
                                   build_assets=[("images/a.png", "image/png", b"png")])

        assert captured["title"] == "Deep Thoughts — Image Gallery"
        assert "<title>Deep Thoughts — Image Gallery</title>" in (
            captured["html_content"].decode("utf-8")
        )

    def test_title_hostname_fallback_without_html_title(self, assembler):
        session = _make_session(
            "gallery-title-host", url="https://example.com/page",
        )

        captured = _run_cloud_push(
            assembler, session, "<html><body>no title here</body></html>",
            build_assets=[("images/a.png", "image/png", b"png")],
        )

        assert captured["title"] == "example.com — Image Gallery"


# ---------------------------------------------------------------------------
# Nothing to push (no documents, no images)
# ---------------------------------------------------------------------------


class TestNothingToPush:
    def test_no_documents_no_images_fails_explicitly(self, assembler):
        """The zero-document guard stays for sessions with no images."""
        session = _make_session("gallery-empty")

        captured = _run_cloud_push(
            assembler, session, "<html><body>ignored</body></html>",
            build_assets=[],
            push_result=types.SimpleNamespace(page_id=None, error=None),
        )

        assert captured == {}  # push_to_archive never invoked
        assert session.cloud_status == "failed"
        assert session.cloud_error == (
            "nothing to push: no HTML/text/markdown selected "
            "and no images captured"
        )
        assert session.cloud_error == CLOUD_NOTHING_TO_PUSH_ERROR
        assert session.cloud_page_id is None
        assert session.status == "ready"
        assert session.zip_path is None
        assert session.assembly_phase is None

    def test_no_resources_at_all_fails_explicitly(self, assembler):
        session = _make_session("gallery-nothing")

        captured = _run_cloud_push(
            assembler, session, "<html><body>ignored</body></html>",
            build_assets=None,
        )

        assert captured == {}
        assert session.cloud_status == "failed"
        assert session.cloud_error == CLOUD_NOTHING_TO_PUSH_ERROR


# ---------------------------------------------------------------------------
# Regression: existing push paths unchanged
# ---------------------------------------------------------------------------


class TestExistingPushPathsUnchanged:
    def test_html_push_payload_unchanged(self, assembler):
        """downloadHtml on → byte-identical payload, no gallery injected."""
        session = _make_session("gallery-reg-html")
        main_html = (
            "<html><head><title>Page</title></head><body>Legacy</body></html>"
        )
        assets = [("images/a.png", "image/png", b"png")]

        captured = _run_cloud_push(
            assembler, session, main_html,
            download_html=True, build_assets=assets,
        )

        assert captured["html_content"] == main_html.encode("utf-8")
        assert captured["title"] == "Page"
        assert [a[0] for a in captured["assets"]] == ["images/a.png"]
        assert captured["markdown_content"] is None
        assert captured["text_content"] is None
        # No gallery <img> tags injected into a normal HTML push.
        assert _img_srcs(captured["html_content"].decode("utf-8")) == []

    def test_markdown_text_push_payload_unchanged(self, assembler):
        """A real text-only push (md/text present) never becomes a gallery."""
        session = _make_session("gallery-reg-text")

        captured = _run_cloud_push(
            assembler, session, "<html><body>ignored</body></html>",
            download_html=False,
            markdown_content="# Doc Title",
            text_content="Plain text",
            build_assets=[("images/a.png", "image/png", b"png")],
        )

        assert captured["html_content"] == b""
        assert captured["markdown_content"] == b"# Doc Title"
        assert captured["text_content"] == b"Plain text"
        assert captured["assets"] == []  # text-only: no assets
        assert captured["title"] == "Doc Title"


# ---------------------------------------------------------------------------
# Escaping / pushed-filename matching
# ---------------------------------------------------------------------------


class TestGalleryEscaping:
    def test_src_escapes_spaces_and_unicode(self, assembler):
        """Weird asset paths: src is URL/attribute-safe and unquotes back
        to the EXACT pushed asset filename."""
        session = _make_session("gallery-escape")
        raw_names = [
            "images/ünïcode ñame.png",
            "images/my photo (1).jpg",
        ]
        assets = [(name, "image/png", b"png") for name in raw_names]

        captured = _run_cloud_push(
            assembler, session, "<html><body>x</body></html>",
            build_assets=assets,
        )

        pushed = [a[0] for a in captured["assets"]]
        assert pushed == sorted(raw_names)  # raw names pushed verbatim
        html_text = captured["html_content"].decode("utf-8")
        srcs = _img_srcs(html_text)
        assert len(srcs) == 2
        for src, raw in zip(srcs, pushed):
            # attribute-safe: no raw quotes, ampersands, angle brackets
            # or spaces inside the src attribute value
            for ch in ('"', "&", "<", ">", " "):
                assert ch not in src
            # resolves back to the exact pushed asset filename
            assert unquote(src) == raw
        # alt carries the basename (HTML-escaped is fine there)
        alts = re.findall(r'alt="([^"]*)"', html_text)
        assert sorted(alts) == ["my photo (1).jpg", "ünïcode ñame.png"]

    def test_ampersand_in_filename_is_fully_encoded(self, assembler):
        session = _make_session("gallery-amp")
        captured = _run_cloud_push(
            assembler, session, "<html><body>x</body></html>",
            build_assets=[("images/a&b \"q\".png", "image/png", b"png")],
        )
        html_text = captured["html_content"].decode("utf-8")
        (src,) = _img_srcs(html_text)
        assert src == "images/a%26b%20%22q%22.png"
        assert unquote(src) == 'images/a&b "q".png'
        assert [a[0] for a in captured["assets"]] == ['images/a&b "q".png']
