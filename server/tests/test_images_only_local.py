"""Round 9: images-only LOCAL assembly (downloadHtml=false, no md/text).

Verifies:
  - A local (pagepocket_user_id=None) session with downloadHtml=false that
    produced NO text document but DID capture image resources builds a
    browsable ZIP instead of failing in _assemble_text_only: a generated
    gallery index.html at the ZIP root plus every image at its regular
    archive path (images/ tree, 3.7 collision dedup) — the local mirror of
    the Round 8 cloud gallery push.
  - The truly-nothing case (no documents AND no image resources) still
    fails via the text-only path, now with the cloud-aligned error.
  - A session WITH a text document (markdown on) and images keeps the
    text-only contract: images-only assembly does not trigger.

Non-goals (unchanged, covered elsewhere): cloud gallery push
(test_cloud_gallery.py), local HTML / markdown / text paths
(test_zip_assembler.py, test_text_native_outputs.py).
"""

import asyncio
import os
import types
import zipfile
from urllib.parse import unquote

import pytest

from app.services.html_merger import MergeResult
from app.services.zip_assembler import (
    LOCAL_NOTHING_TO_ASSEMBLE_ERROR,
    ZipAssemblerService,
)

# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

MAIN_HTML = (
    "<!DOCTYPE html><html><head><title>Test Page</title></head>"
    "<body><p>Main content</p></body></html>"
)


@pytest.fixture
def storage_root(tmp_path):
    return str(tmp_path)


@pytest.fixture
def assembler(storage_root):
    return ZipAssemblerService(storage_root=storage_root)


def _make_resource(
    resource_id, local_path, content_type, storage_root, session_id, data=b"\xff\xd8\xff\xe0img",
):
    """Fake resource row carrying every attribute the assembler reads."""
    storage_path = os.path.join(
        storage_root, session_id, "resources", f"{resource_id}.bin",
    )
    os.makedirs(os.path.dirname(storage_path), exist_ok=True)
    with open(storage_path, "wb") as f:
        f.write(data)
    return types.SimpleNamespace(
        id=resource_id,
        original_url=f"https://example.com/{local_path}",
        url_hash=resource_id,
        local_path=local_path,
        storage_path=storage_path,
        content_type=content_type,
        size=len(data),
    )


def _make_session(session_id, url="https://example.com/page", options=None):
    """Mock session object carrying every attribute assemble_session reads."""
    return types.SimpleNamespace(
        id=session_id,
        url=url,
        status="assembling",
        assembly_phase="assembling_zip",
        assembly_progress_pct=0,
        options=options if options is not None else {},
        pagepocket_user_id=None,  # LOCAL mode
        pagepocket_plan=None,
        cloud_status=None,
        cloud_page_id=None,
        cloud_error=None,
        zip_path=None,
        error_message=None,
        filename_map={},
    )


def _prepare_session_dir(storage_root, session_id):
    session_dir = os.path.join(storage_root, session_id)
    os.makedirs(session_dir, exist_ok=True)
    return session_dir


def _run_assemble_session(assembler, session, main_html, resources, *,
                          text_only_spy=None):
    """Run the REAL assemble_session with collaborators stubbed out.

    Same stubbing strategy as test_text_native_outputs._run_assemble_session,
    but ``resources`` feeds _get_all_resources so the images-only routing and
    the 3.7 collision resolution run for real.
    """
    from app.services import zip_assembler as za_module
    from app.services.html_converter import html_converter_service

    merge_results = {"main": MergeResult(success=True, html=main_html)}

    class _Result:
        def __init__(self, value):
            self._value = value

        def scalar_one_or_none(self):
            return self._value

    class _FakeDB:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def execute(self, _stmt):
            return _Result(session)

        async def flush(self):
            pass

    def factory():
        return _FakeDB()

    async def _get_resources(db, sid):
        return resources

    async def _no_prefix(db, sid, prefix):
        return []

    async def _no_progress(db, sess, phase, pct, **kwargs):
        pass

    def _identity(html, *args, **kwargs):
        return html

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(za_module.html_merger_service, "merge_session",
                   lambda sid: merge_results)
        mp.setattr(assembler, "_get_all_resources", _get_resources)
        mp.setattr(assembler, "_get_resources_by_prefix", _no_prefix)
        mp.setattr(assembler, "_update_progress", _no_progress)
        mp.setattr(html_converter_service, "convert_html", _identity)
        mp.setattr(html_converter_service, "convert_linked_page_html", _identity)
        mp.setattr(html_converter_service, "inline_css_into_html", _identity)
        if text_only_spy is not None:
            mp.setattr(assembler, "_assemble_text_only", text_only_spy)
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(
                assembler.assemble_session(session.id, factory)
            )
        finally:
            loop.close()


# ---------------------------------------------------------------------------
# Images-only → gallery ZIP
# ---------------------------------------------------------------------------


class TestImagesOnlyLocalZip:
    """Round 9: images-only local session builds a gallery ZIP."""

    def test_images_only_session_builds_gallery_zip(
        self, assembler, storage_root,
    ):
        """downloadHtml=false, no md/text, images captured → ready + ZIP."""
        session_id = "imgonly-zip"
        _prepare_session_dir(storage_root, session_id)
        resources = [
            _make_resource("r1", "images/example.com/a.jpg", "image/jpeg",
                           storage_root, session_id, b"A" * 32),
            _make_resource("r2", "images/example.com/pic 1.png", "image/png",
                           storage_root, session_id, b"B" * 32),
        ]
        session = _make_session(session_id, options={"downloadHtml": False})

        async def _spy(*args, **kwargs):
            raise AssertionError("_assemble_text_only must not be invoked")

        _run_assemble_session(assembler, session, MAIN_HTML, resources,
                              text_only_spy=_spy)

        assert session.status == "ready"
        assert session.error_message is None
        assert session.zip_path and session.zip_path.endswith(".zip")
        assert os.path.exists(session.zip_path)

        with zipfile.ZipFile(session.zip_path, "r") as zf:
            names = set(zf.namelist())
            index_html = zf.read("index.html").decode("utf-8")

        # index.html + every image entry — exact archive paths
        assert names == {
            "index.html",
            "images/example.com/a.jpg",
            "images/example.com/pic 1.png",
        }
        # Gallery document: title from the merged main HTML <title>, one
        # <img> per resource, and the src matching the zip-relative path
        # (percent-encoded for URL/attribute safety).
        assert "Test Page — Image Gallery" in index_html
        assert '<img src="images/example.com/a.jpg"' in index_html
        assert 'src="images/example.com/pic%201.png"' in index_html
        assert index_html.count("<img ") == 2

    def test_gallery_src_values_unquote_to_zip_entries(
        self, assembler, storage_root,
    ):
        """Every <img src> resolves to an actual ZIP entry after unquoting."""
        import re

        session_id = "imgonly-src"
        _prepare_session_dir(storage_root, session_id)
        resources = [
            _make_resource("r1", "images/host/a&b.jpg", "image/jpeg",
                           storage_root, session_id),
            _make_resource("r2", "images/host/ü nicode.png", "image/png",
                           storage_root, session_id),
        ]
        session = _make_session(session_id, options={"downloadHtml": False})

        _run_assemble_session(assembler, session, MAIN_HTML, resources)

        with zipfile.ZipFile(session.zip_path, "r") as zf:
            names = set(zf.namelist())
            index_html = zf.read("index.html").decode("utf-8")

        srcs = re.findall(r'<img src="([^"]+)"', index_html)
        assert len(srcs) == 2
        for src in srcs:
            assert unquote(src) in names, (
                f"gallery src {src!r} does not resolve to a ZIP entry"
            )

    def test_image_content_type_includes_non_images_prefix_paths(
        self, assembler, storage_root,
    ):
        """image/* content type qualifies even without an images/ path —
        the same predicate as the Round 8 cloud gallery filter."""
        session_id = "imgonly-mime"
        _prepare_session_dir(storage_root, session_id)
        resources = [
            _make_resource("r1", "media/banner.webp", "image/webp",
                           storage_root, session_id),
        ]
        session = _make_session(session_id, options={"downloadHtml": False})

        _run_assemble_session(assembler, session, MAIN_HTML, resources)

        assert session.status == "ready"
        with zipfile.ZipFile(session.zip_path, "r") as zf:
            assert set(zf.namelist()) == {"index.html", "media/banner.webp"}

    def test_colliding_image_paths_get_stable_suffixes(
        self, assembler, storage_root,
    ):
        """3.7 collision dedup: two images with the same local_path both
        land in the ZIP under distinct suffixed archive paths."""
        session_id = "imgonly-collide"
        _prepare_session_dir(storage_root, session_id)
        resources = [
            _make_resource("r1", "images/site/dup.jpg", "image/jpeg",
                           storage_root, session_id, b"first"),
            _make_resource("r2", "images/site/dup.jpg", "image/jpeg",
                           storage_root, session_id, b"second"),
        ]
        session = _make_session(session_id, options={"downloadHtml": False})

        _run_assemble_session(assembler, session, MAIN_HTML, resources)

        assert session.status == "ready"
        with zipfile.ZipFile(session.zip_path, "r") as zf:
            names = sorted(zf.namelist())
            index_html = zf.read("index.html").decode("utf-8")
            payloads = {
                n: zf.read(n) for n in names if n != "index.html"
            }

        image_names = [n for n in names if n != "index.html"]
        assert len(image_names) == 2
        assert all(n.startswith("images/site/dup") for n in image_names)
        # Both files present, distinct contents (no silent overwrite)
        assert set(payloads.values()) == {b"first", b"second"}
        # Gallery references exactly the two written entries
        import re

        srcs = re.findall(r'<img src="([^"]+)"', index_html)
        assert sorted(unquote(s) for s in srcs) == image_names

    def test_missing_image_file_skipped_but_zip_still_built(
        self, assembler, storage_root,
    ):
        """6.6 rule: an unreadable resource is skipped with a warning; the
        gallery ZIP is still produced from the remaining images."""
        session_id = "imgonly-missing"
        session_dir = _prepare_session_dir(storage_root, session_id)
        good = _make_resource("r1", "images/site/good.jpg", "image/jpeg",
                              storage_root, session_id)
        bad = _make_resource("r2", "images/site/gone.jpg", "image/jpeg",
                             storage_root, session_id)
        os.remove(bad.storage_path)  # vanish from disk
        session = _make_session(session_id, options={"downloadHtml": False})

        _run_assemble_session(assembler, session, MAIN_HTML, [good, bad])

        assert session.status == "ready"
        with zipfile.ZipFile(session.zip_path, "r") as zf:
            assert set(zf.namelist()) == {"index.html", "images/site/good.jpg"}
        assert session_dir  # artifact lives in the session dir


# ---------------------------------------------------------------------------
# Truly-nothing case: text-only failure path still hit
# ---------------------------------------------------------------------------


class TestNothingToAssemble:
    """No documents AND no image resources → text-only failure, aligned msg."""

    def test_no_resources_fails_with_aligned_error(
        self, assembler, storage_root,
    ):
        session_id = "imgonly-empty"
        session_dir = _prepare_session_dir(storage_root, session_id)
        session = _make_session(session_id, options={"downloadHtml": False})

        _run_assemble_session(assembler, session, MAIN_HTML, [])

        assert session.status == "failed"
        assert session.error_message == LOCAL_NOTHING_TO_ASSEMBLE_ERROR
        assert not [n for n in os.listdir(session_dir) if n.endswith(".zip")]

    def test_non_image_resources_without_docs_still_fail(
        self, assembler, storage_root,
    ):
        """Non-image resources alone never trigger the images-only branch."""
        session_id = "imgonly-noimg"
        session_dir = _prepare_session_dir(storage_root, session_id)
        resources = [
            _make_resource("r1", "styles/main.css", "text/css",
                           storage_root, session_id, b"body{}"),
            _make_resource("r2", "scripts/app.js", "text/javascript",
                           storage_root, session_id, b"console.log(1)"),
        ]
        session = _make_session(session_id, options={"downloadHtml": False})

        _run_assemble_session(assembler, session, MAIN_HTML, resources)

        assert session.status == "failed"
        assert session.error_message == LOCAL_NOTHING_TO_ASSEMBLE_ERROR
        assert not [n for n in os.listdir(session_dir) if n.endswith(".zip")]


# ---------------------------------------------------------------------------
# Document present → text-only contract unchanged
# ---------------------------------------------------------------------------


class TestDocumentBeatsImages:
    """The images-only branch only fires when there is NO text document."""

    def test_markdown_document_with_images_stays_text_only(
        self, assembler, storage_root,
    ):
        """downloadHtml=false + markdown on + images → raw content.md,
        images excluded (text-native-downloads D3) — not a gallery ZIP."""
        session_id = "imgonly-mddoc"
        _prepare_session_dir(storage_root, session_id)
        resources = [
            _make_resource("r1", "images/site/photo.jpg", "image/jpeg",
                           storage_root, session_id),
        ]
        session = _make_session(
            session_id,
            options={
                "downloadHtml": False,
                "downloadContentAsMarkdown": True,
            },
        )

        _run_assemble_session(assembler, session, MAIN_HTML, resources)

        assert session.status == "ready"
        assert os.path.basename(session.zip_path) == "content.md"
        assert session.options["outputFilename"] == "content.md"
        # Raw file, not a ZIP
        assert not session.zip_path.endswith(".zip")
        assert not os.path.isdir(session.zip_path)

    def test_uploaded_content_txt_with_images_stays_text_only(
        self, assembler, storage_root,
    ):
        """content.txt present + images → raw content.txt delivery."""
        session_id = "imgonly-txtdoc"
        session_dir = _prepare_session_dir(storage_root, session_id)
        with open(os.path.join(session_dir, "content.txt"), "w") as f:
            f.write("Extracted text")
        resources = [
            _make_resource("r1", "images/site/photo.jpg", "image/jpeg",
                           storage_root, session_id),
        ]
        session = _make_session(
            session_id,
            options={"downloadHtml": False, "downloadContentAsText": True},
        )

        _run_assemble_session(assembler, session, MAIN_HTML, resources)

        assert session.status == "ready"
        assert os.path.basename(session.zip_path) == "content.txt"
        assert session.options["outputContentType"] == "text/plain; charset=utf-8"
