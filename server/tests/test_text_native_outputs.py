"""Tests for text-native-downloads monolith behavior (tasks 3.1–3.3, 4.1–4.2).

Verifies:
  3.1 – Session-create options parse/store downloadHtml and
        downloadContentAsText with backward-compatible defaults.
  3.2 – zip_assembler output rules: text-only assembly (no index.html, no
        HTML-only extras), raw single-file delivery (output_type "file" +
        filename + MIME), multi-file → zip, singleFile HTML unchanged.
  3.3 – Local assembly scenarios: markdown-only → raw content.md;
        content-only → raw content.txt; multi-page markdown → zip without
        index.html; html+md → zip with both; options defaults compatible.
  4.1/4.2 – Cloud push carries markdown_content / text_content parts;
        text-only push (empty html_content, no assets); legacy payload
        unchanged; both the standard and the single-file cloud variant.
"""

import asyncio
import os
import sys
import types
import zipfile

import pytest

from app.services.zip_assembler import (
    ZipAssemblerService,
    output_content_type_for,
)

# ---------------------------------------------------------------------------
# Proto stubs: make archive_pb2 importable the same way test_cloud_delete.py
# does, so the push_to_archive tests run for real (not skipped) in isolation.
# ---------------------------------------------------------------------------

_PROTO_DIR = os.path.normpath(os.path.join(
    os.path.dirname(__file__), "..", "..", "pagepocket", "shared", "proto_generated",
))
if os.path.isdir(_PROTO_DIR) and _PROTO_DIR not in sys.path:
    sys.path.insert(0, _PROTO_DIR)


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
    session_id="text-native-1",
    url="https://example.com/page",
    options=None,
    pagepocket_user_id=None,
    pagepocket_plan="free",
):
    """Mock session object carrying every attribute assemble_session reads."""
    return types.SimpleNamespace(
        id=session_id,
        url=url,
        status="assembling",
        assembly_phase="assembling_zip",
        assembly_progress_pct=0,
        options=options if options is not None else {},
        pagepocket_user_id=pagepocket_user_id,
        pagepocket_plan=pagepocket_plan,
        cloud_status=None,
        cloud_page_id=None,
        cloud_error=None,
        zip_path=None,
        error_message=None,
        filename_map={},
    )


MAIN_HTML = (
    "<!DOCTYPE html><html><head><title>Test Page</title></head>"
    "<body><p>Main content</p><a href=\"/about\">About</a></body></html>"
)


def _prepare_session_dir(storage_root, session_id, content_text=None):
    session_dir = os.path.join(storage_root, session_id)
    os.makedirs(session_dir, exist_ok=True)
    if content_text is not None:
        with open(os.path.join(session_dir, "content.txt"), "w") as f:
            f.write(content_text)
    return session_dir


def _run_assemble_session(assembler, session, main_html, *, linked=None, patch_push=None):
    """Run the REAL assemble_session with collaborators stubbed out.

    Stubs only the heavy external surfaces (merger, HTML conversion,
    resources, cloud assets); markdown conversion and every branch decision
    run for real. ``patch_push`` receives a setter to replace
    ``archive_client.push_to_archive`` (imported at call time inside the
    cloud branch).
    """
    from app.services import archive_client
    from app.services import zip_assembler as za_module
    from app.services.html_converter import html_converter_service
    from app.services.html_merger import MergeResult

    merge_results = {"main": MergeResult(success=True, html=main_html)}
    if linked:
        for page_hash, (page_html, page_url) in linked.items():
            merge_results[page_hash] = MergeResult(
                success=True, html=page_html, page_url=page_url,
            )

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

    async def _factory():
        return _FakeDB()

    # db_session_factory is used as `async with db_session_factory() as db`,
    # so it must return the async context manager directly (not a coroutine).
    def factory():
        return _FakeDB()

    async def _no_resources(db, sid):
        return []

    async def _no_prefix(db, sid, prefix):
        return []

    async def _no_progress(db, sess, phase, pct, **kwargs):
        pass

    async def _no_assets(sid, db, archive_paths=None):
        return []

    def _identity(html, *args, **kwargs):
        return html

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(za_module.html_merger_service, "merge_session",
                   lambda sid: merge_results)
        mp.setattr(assembler, "_get_all_resources", _no_resources)
        mp.setattr(assembler, "_get_resources_by_prefix", _no_prefix)
        mp.setattr(assembler, "_update_progress", _no_progress)
        mp.setattr(assembler, "_build_cloud_assets", _no_assets)
        mp.setattr(html_converter_service, "convert_html", _identity)
        mp.setattr(html_converter_service, "convert_linked_page_html", _identity)
        mp.setattr(html_converter_service, "inline_css_into_html", _identity)
        mp.setattr(html_converter_service, "write_single_file_to_disk",
                   lambda main_html, tab_url, root, sid, html_path, fmap, lps:
                   open(html_path, "w").write(main_html) or None)
        if patch_push is not None:
            patch_push(lambda push: mp.setattr(archive_client, "push_to_archive", push))
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(
                assembler.assemble_session(session.id, factory)
            )
        finally:
            loop.close()


# ---------------------------------------------------------------------------
# 3.1 – Session-create options: parsing + persistence + defaults
# ---------------------------------------------------------------------------


class TestSessionOptions:
    """Task 3.1: downloadHtml / downloadContentAsText reach stored options."""

    def test_defaults_are_backward_compatible(self):
        """Absent options ⇒ HTML on, text flag off (legacy payloads)."""
        from app.api.routes.sessions import SessionOptions

        opts = SessionOptions()
        assert opts.downloadHtml is True
        assert opts.downloadContentAsText is False
        # Legacy fields unchanged.
        assert opts.singleFile is False
        assert opts.downloadContentAsMarkdown is False

    def test_explicit_text_only_selection_parses(self):
        from app.api.routes.sessions import SessionOptions

        opts = SessionOptions(
            downloadHtml=False,
            downloadContentAsMarkdown=True,
            downloadContentAsText=True,
        )
        assert opts.downloadHtml is False
        assert opts.downloadContentAsText is True

    @pytest.mark.asyncio
    async def test_create_session_persists_new_options(self, tmp_path, sqlite_db):
        """POST /sessions body with the new keys stores them on the row."""
        from app.api.routes.sessions import (
            CreateSessionRequest,
            SessionOptions,
            create_session,
        )
        from app.models.client import Client

        _engine, factory = sqlite_db
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("app.config.settings.storage_root", str(tmp_path))
            async with factory() as db:
                body = CreateSessionRequest(
                    url="https://example.com/page",
                    options=SessionOptions(
                        downloadHtml=False,
                        downloadContentAsMarkdown=True,
                        downloadContentAsText=True,
                    ),
                )
                resp = await create_session(
                    body=body, client=Client(id="c1", api_key="k"), db=db,
                )
                await db.commit()

        assert resp.options["downloadHtml"] is False
        assert resp.options["downloadContentAsText"] is True
        assert resp.options["downloadContentAsMarkdown"] is True
        assert resp.options["singleFile"] is False

        async with factory() as db:
            from sqlalchemy import select

            from app.models.session import Session

            row = (await db.execute(
                select(Session).where(Session.id == resp.id)
            )).scalar_one()
        assert row.options["downloadHtml"] is False
        assert row.options["downloadContentAsText"] is True

    @pytest.mark.asyncio
    async def test_create_session_legacy_payload_gets_defaults(
        self, tmp_path, sqlite_db,
    ):
        """Old session payload (no new keys) → defaults, legacy keys intact."""
        from app.api.routes.sessions import (
            CreateSessionRequest,
            SessionOptions,
            create_session,
        )
        from app.models.client import Client

        _engine, factory = sqlite_db
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("app.config.settings.storage_root", str(tmp_path))
            async with factory() as db:
                # Exactly the pre-change extension body shape.
                body = CreateSessionRequest(
                    url="https://example.com/page",
                    options=SessionOptions(retentionDays=3),
                )
                resp = await create_session(
                    body=body, client=Client(id="c2", api_key="k"), db=db,
                )
                await db.commit()

        assert resp.options["downloadHtml"] is True
        assert resp.options["downloadContentAsText"] is False
        assert resp.options["retentionDays"] == 3


# ---------------------------------------------------------------------------
# output_type "file" payload semantics (result/status fields)
# ---------------------------------------------------------------------------


class TestResolveOutputFields:
    """output_type generalization: "file" for raw text, html/zip unchanged."""

    @staticmethod
    def _session(status="ready", zip_path="/tmp/x/content.md", options=None):
        return types.SimpleNamespace(
            status=status, zip_path=zip_path, options=options or {},
        )

    def test_file_output_reports_filename_and_mime(self):
        from app.api.routes.sessions import _resolve_output_fields

        session = self._session(options={
            "outputFilename": "content.md",
            "outputContentType": "text/markdown; charset=utf-8",
        })
        assert _resolve_output_fields(session) == (
            "file", "content.md", "text/markdown; charset=utf-8",
        )

    def test_single_file_html_unchanged(self):
        from app.api.routes.sessions import _resolve_output_fields

        session = self._session(
            zip_path="/tmp/x/page.html",
            options={"singleFile": True},
        )
        assert _resolve_output_fields(session) == ("html", None, None)

    def test_zip_unchanged(self):
        from app.api.routes.sessions import _resolve_output_fields

        assert _resolve_output_fields(self._session(
            zip_path="/tmp/x/bundle.zip", options={},
        )) == ("zip", None, None)

    def test_file_metadata_wins_over_single_file_flag(self):
        """singleFile ignored for text-only output (text rules win)."""
        from app.api.routes.sessions import _resolve_output_fields

        session = self._session(options={
            "singleFile": True,
            "outputFilename": "content.txt",
            "outputContentType": "text/plain; charset=utf-8",
        })
        assert _resolve_output_fields(session) == (
            "file", "content.txt", "text/plain; charset=utf-8",
        )

    def test_not_ready_or_missing_file_are_none(self):
        from app.api.routes.sessions import _resolve_output_fields

        assert _resolve_output_fields(self._session(status="assembling")) \
            == (None, None, None)
        assert _resolve_output_fields(self._session(zip_path=None)) \
            == (None, None, None)

    def test_response_models_carry_new_fields(self):
        """Result/status payloads expose output_filename/output_content_type."""
        from datetime import datetime, timezone

        from app.api.routes.sessions import SessionResponse, SessionStatusResponse

        now = datetime.now(timezone.utc)
        resp = SessionResponse(
            id="s", url="https://example.com", status="ready",
            created_at=now, expires_at=now,
            output_type="file",
            output_filename="content.md",
            output_content_type="text/markdown; charset=utf-8",
        )
        assert resp.output_filename == "content.md"
        assert resp.output_content_type == "text/markdown; charset=utf-8"

        status = SessionStatusResponse(
            id="s", status="ready", url="https://example.com",
        )
        assert status.output_filename is None
        assert status.output_content_type is None


# ---------------------------------------------------------------------------
# 3.2/3.3 – Text-only assembly and output-shape rules (zip_assembler)
# ---------------------------------------------------------------------------


class TestTextOnlyAssembly:
    """downloadHtml=false → text documents only; shape follows D3."""

    def test_markdown_only_single_page_is_raw_file(self, assembler, storage_root):
        """Markdown-only single page → exactly one raw content.md (3.3)."""
        session_id = "tn-md-only"
        _prepare_session_dir(storage_root, session_id)
        session = _make_session(session_id, options={
            "downloadHtml": False,
            "downloadContentAsMarkdown": True,
        })

        loop = asyncio.new_event_loop()
        try:
            out_path = loop.run_until_complete(
                assembler._assemble_text_only(
                    session_id, MockDB(), session,
                    content_md="# Test Page\n\nMain content.",
                    content_text=None,
                    page_md_list={},
                    page_hash_to_filename={},
                )
            )
        finally:
            loop.close()

        session_dir = os.path.join(storage_root, session_id)
        # Exactly one file in the session dir, and it is content.md.
        assert os.listdir(session_dir) == ["content.md"]
        assert out_path == os.path.join(session_dir, "content.md")
        with open(out_path, "r", encoding="utf-8") as f:
            assert f.read() == "# Test Page\n\nMain content."
        # Raw single-file metadata recorded for the result/status payloads.
        assert session.options["outputFilename"] == "content.md"
        assert session.options["outputContentType"] == "text/markdown; charset=utf-8"

    def test_content_only_is_raw_txt(self, assembler, storage_root):
        """Content-only (markdown off) → exactly one raw content.txt (3.3)."""
        session_id = "tn-txt-only"
        _prepare_session_dir(storage_root, session_id)
        session = _make_session(session_id, options={"downloadHtml": False})

        loop = asyncio.new_event_loop()
        try:
            out_path = loop.run_until_complete(
                assembler._assemble_text_only(
                    session_id, MockDB(), session,
                    content_md=None,
                    content_text="Extracted page text.",
                    page_md_list={},
                    page_hash_to_filename={},
                )
            )
        finally:
            loop.close()

        session_dir = os.path.join(storage_root, session_id)
        assert os.listdir(session_dir) == ["content.txt"]
        assert session.options["outputFilename"] == "content.txt"
        assert session.options["outputContentType"] == "text/plain; charset=utf-8"
        with open(out_path, "r", encoding="utf-8") as f:
            assert f.read() == "Extracted page text."

    def test_multi_page_markdown_zip_without_index_html(self, assembler, storage_root):
        """Multi-page markdown → zip with text files only, no index.html (3.3)."""
        session_id = "tn-multi-md"
        _prepare_session_dir(storage_root, session_id)
        session = _make_session(session_id, options={
            "downloadHtml": False,
            "downloadContentAsMarkdown": True,
        })

        loop = asyncio.new_event_loop()
        try:
            out_path = loop.run_until_complete(
                assembler._assemble_text_only(
                    session_id, MockDB(), session,
                    content_md="# Main\n\nBody.",
                    content_text=None,
                    page_md_list={
                        "abc123": "<!-- source: https://example.com/about -->\n\n# About",
                    },
                    page_hash_to_filename={"abc123": "about.html"},
                )
            )
        finally:
            loop.close()

        assert zipfile.is_zipfile(out_path)
        with zipfile.ZipFile(out_path, "r") as zf:
            names = zf.namelist()
            assert sorted(names) == ["content.md", "pages/about.md"]
            # No HTML anywhere in a text-only artifact.
            assert not any(n.endswith(".html") for n in names)
            assert "index.html" not in names
            assert zf.read("content.md").decode("utf-8") == "# Main\n\nBody."
        # No raw-delivery metadata for a multi-file artifact.
        assert "outputFilename" not in session.options

    def test_text_zip_holds_every_selected_format(self, assembler, storage_root):
        """md + uploaded text + linked md → zip with all three, no HTML extras."""
        session_id = "tn-all-text"
        _prepare_session_dir(storage_root, session_id)
        session = _make_session(session_id, options={
            "downloadHtml": False,
            "downloadContentAsMarkdown": True,
            "downloadContentAsText": True,
        })

        loop = asyncio.new_event_loop()
        try:
            out_path = loop.run_until_complete(
                assembler._assemble_text_only(
                    session_id, MockDB(), session,
                    content_md="# Main",
                    content_text="Page text.",
                    page_md_list={"h1": "# Linked"},
                    page_hash_to_filename={"h1": "linked.html"},
                )
            )
        finally:
            loop.close()

        with zipfile.ZipFile(out_path, "r") as zf:
            names = set(zf.namelist())
        assert names == {"content.md", "content.txt", "pages/linked.md"}

    def test_single_page_md_from_linked_page_is_flattened(
        self, assembler, storage_root,
    ):
        """A lone linked-page .md is delivered raw under its basename (D3)."""
        session_id = "tn-lone-page-md"
        _prepare_session_dir(storage_root, session_id)
        session = _make_session(session_id, options={
            "downloadHtml": False,
            "downloadContentAsMarkdown": True,
        })

        loop = asyncio.new_event_loop()
        try:
            out_path = loop.run_until_complete(
                assembler._assemble_text_only(
                    session_id, MockDB(), session,
                    content_md=None,  # main conversion failed (D6 isolation)
                    content_text=None,
                    page_md_list={"abc123": "<!-- source: u -->"},
                    page_hash_to_filename={"abc123": "about.html"},
                )
            )
        finally:
            loop.close()

        assert os.path.basename(out_path) == "about.md"
        assert session.options["outputFilename"] == "about.md"
        assert session.options["outputContentType"] == "text/markdown; charset=utf-8"

    def test_text_only_without_any_text_fails(self, assembler, storage_root):
        """HTML off + conversion failed + nothing uploaded → failed session."""
        session_id = "tn-empty"
        _prepare_session_dir(storage_root, session_id)
        session = _make_session(session_id, options={"downloadHtml": False})

        loop = asyncio.new_event_loop()
        try:
            out_path = loop.run_until_complete(
                assembler._assemble_text_only(
                    session_id, MockDB(), session,
                    content_md=None,
                    content_text=None,
                    page_md_list={},
                    page_hash_to_filename={},
                )
            )
        finally:
            loop.close()

        assert out_path is None
        assert session.status == "failed"
        assert "no text content" in session.error_message


class TestOutputShapeRules:
    """Multi-file → zip; singleFile HTML unchanged; text-only only when HTML
    is off and singleFile unset (3.2/3.3)."""

    def test_html_md_bundle_zip_has_both(self, assembler, storage_root):
        """html+md (HTML on) → zip containing index.html AND content.md."""
        session_id = "tn-html-md"
        _prepare_session_dir(storage_root, session_id)
        session = _make_session(session_id, options={
            "downloadHtml": True,
            "downloadContentAsMarkdown": True,
        })

        loop = asyncio.new_event_loop()
        try:
            zip_path = loop.run_until_complete(
                assembler._assemble_zip(
                    session_id, MockDB(), session,
                    "<html><body><p>Index</p></body></html>",
                    {}, {}, {}, {}, None,
                    all_resources=[],
                    content_md="# Index\n\nBody.",
                    page_md_list={},
                )
            )
        finally:
            loop.close()

        assert zip_path.endswith(".zip")
        with zipfile.ZipFile(zip_path, "r") as zf:
            names = zf.namelist()
        assert "index.html" in names
        assert "content.md" in names
        assert "outputFilename" not in session.options

    def test_single_file_html_branch_unchanged(self, assembler, storage_root):
        """singleFile (HTML on) → .html artifact, no file metadata recorded."""
        session_id = "tn-single-html"
        _prepare_session_dir(storage_root, session_id)
        session = _make_session(session_id, options={
            "singleFile": True,
            "downloadHtml": True,
        })

        loop = asyncio.new_event_loop()
        try:
            html_path = loop.run_until_complete(
                assembler._assemble_single_file(
                    session_id, MockDB(), session,
                    "<html><body><p>Single</p></body></html>",
                    "https://example.com/page", {}, None,
                )
            )
        finally:
            loop.close()

        assert html_path.endswith(".html")
        assert os.path.exists(html_path)
        # No raw-file metadata for the html output type (unchanged payload).
        assert "outputFilename" not in session.options
        assert "outputContentType" not in session.options

    def test_output_content_type_mapping(self):
        """Pinned MIME map: .md → markdown, .txt → plain."""
        assert output_content_type_for("content.md") == \
            "text/markdown; charset=utf-8"
        assert output_content_type_for("content.txt") == \
            "text/plain; charset=utf-8"
        assert output_content_type_for("other.bin") == \
            "application/octet-stream"


class TestFullAssemblyFlow:
    """End-to-end assemble_session wiring for the new output rules."""

    def test_markdown_only_local_download_is_raw_content_md(
        self, assembler, storage_root,
    ):
        """html off + md on → session ready with raw content.md (3.3)."""
        session_id = "tn-flow-md"
        _prepare_session_dir(storage_root, session_id)
        session = _make_session(session_id, options={
            "downloadHtml": False,
            "downloadContentAsMarkdown": True,
        })

        _run_assemble_session(assembler, session, MAIN_HTML)

        session_dir = os.path.join(storage_root, session_id)
        assert os.listdir(session_dir) == ["content.md"]
        assert session.zip_path == os.path.join(session_dir, "content.md")
        assert session.status == "ready"
        assert session.options["outputFilename"] == "content.md"
        assert session.options["outputContentType"] == "text/markdown; charset=utf-8"

    def test_legacy_options_still_produce_html_zip(self, assembler, storage_root):
        """Old session payload (no new keys) → unchanged zip with index.html."""
        session_id = "tn-flow-legacy"
        _prepare_session_dir(storage_root, session_id)
        session = _make_session(session_id, options={
            "singleFile": False,
            "retentionDays": 7,
            "downloadContentAsMarkdown": False,
        })

        _run_assemble_session(assembler, session, MAIN_HTML)

        assert session.status == "ready"
        assert session.zip_path.endswith(".zip")
        with zipfile.ZipFile(session.zip_path, "r") as zf:
            names = zf.namelist()
        assert "index.html" in names
        assert "content.md" not in names
        assert "outputFilename" not in session.options

    def test_single_file_cloud_variant_pushes_markdown_part(
        self, assembler, storage_root,
    ):
        """Cloud single-file + md option → push carries the markdown part (4.1)."""
        session_id = "tn-flow-cloud-single"
        _prepare_session_dir(storage_root, session_id)
        session = _make_session(
            session_id,
            options={"singleFile": True, "downloadContentAsMarkdown": True},
            pagepocket_user_id="user-cloud",
        )

        captured = {}

        def _fake_push_result():
            return types.SimpleNamespace(page_id="page-1", error=None)

        def _patch(setter):
            def _capture(**kwargs):
                captured.update(kwargs)
                return _fake_push_result()

            setter(_capture)

        _run_assemble_session(
            assembler, session, MAIN_HTML, patch_push=_patch,
        )

        assert captured["user_id"] == "user-cloud"
        assert captured["html_content"] == MAIN_HTML.encode("utf-8")
        assert captured["assets"] == []
        # The Phase-1b shared-converter document: body text with original
        # absolute URLs (pre-URL-rewrite, design D2).
        assert b"Main content" in captured["markdown_content"]
        assert b"](https://example.com/about)" in captured["markdown_content"]
        assert captured["text_content"] is None
        # Single-file cloud keeps its contract: no local output left behind.
        assert session.zip_path is None
        assert session.cloud_status == "success"
        session_dir = os.path.join(storage_root, session_id)
        assert not [n for n in os.listdir(session_dir) if n.endswith(".html")]

    def test_single_file_with_html_off_produces_single_file_html(
        self, assembler, storage_root,
    ):
        """singleFile + HTML off → singleFile implies HTML delivery: the
        single-file HTML artifact is produced (md flag ignored per D7),
        never text-only assembly."""
        session_id = "tn-flow-sf-text"
        _prepare_session_dir(storage_root, session_id)
        session = _make_session(session_id, options={
            "singleFile": True,
            "downloadHtml": False,
            "downloadContentAsMarkdown": True,
        })

        _run_assemble_session(assembler, session, MAIN_HTML)

        session_dir = os.path.join(storage_root, session_id)
        assert session.status == "ready"
        assert session.zip_path.endswith(".html")
        assert os.path.exists(session.zip_path)
        # Exactly one artifact: the single-file HTML (no content.md).
        assert os.listdir(session_dir) == [os.path.basename(session.zip_path)]

    def test_single_file_with_all_text_flags_off_does_not_fail(
        self, assembler, storage_root,
    ):
        """Regression: singleFile + downloadHtml=false + both text flags off
        (what current extension builds send) used to fall into text-only
        assembly and fail with "Text-only download produced no text content".
        singleFile implies HTML delivery, so the session must complete with
        the single-file HTML artifact."""
        session_id = "tn-flow-sf-coerce"
        _prepare_session_dir(storage_root, session_id)
        session = _make_session(session_id, options={
            "singleFile": True,
            "downloadHtml": False,
            "downloadContentAsText": False,
            "downloadContentAsMarkdown": False,
        })

        _run_assemble_session(assembler, session, MAIN_HTML)

        session_dir = os.path.join(storage_root, session_id)
        assert session.status == "ready"
        assert session.error_message is None
        assert session.zip_path.endswith(".html")
        assert os.path.exists(session.zip_path)
        assert os.listdir(session_dir) == [os.path.basename(session.zip_path)]
        # Raw-file metadata is for text outputs only; html output is unchanged.
        assert "outputFilename" not in session.options
        assert "outputContentType" not in session.options


# ---------------------------------------------------------------------------
# 4.1/4.2 – Cloud push payload rules
# ---------------------------------------------------------------------------


class TestCloudPushTextParts:
    """_assemble_cloud_push honors the text-format options (4.1)."""

    @staticmethod
    def _run_cloud_push(
        assembler, session, main_html, *,
        linked=None, filenames=None, download_html=True,
        markdown_content=None, text_content=None, build_assets=None,
        push_result=None,
    ):
        captured = {}
        push_result = push_result or types.SimpleNamespace(
            page_id="page-ok", error=None,
        )

        if build_assets is not None and not isinstance(build_assets, list):
            # An async spy callable replacing _build_cloud_assets outright.
            assembler._build_cloud_assets = build_assets
        else:
            async def _mock_build(sid, db, archive_paths=None):
                return list(build_assets or [])

            assembler._build_cloud_assets = _mock_build

        async def _no_progress(db, sess, phase, pct, **kwargs):
            pass

        assembler._update_progress = _no_progress

        def _capture_push(**kwargs):
            captured.update(kwargs)
            return push_result

        with patch_dict_archive_push(_capture_push):
            loop = asyncio.new_event_loop()
            try:
                loop.run_until_complete(
                    assembler._assemble_cloud_push(
                        session.id, MockDB(), session,
                        main_html, linked or {}, filenames or {},
                        download_html=download_html,
                        markdown_content=markdown_content,
                        text_content=text_content,
                    )
                )
            finally:
                loop.close()
        return captured

    def test_html_and_markdown_push_contains_both_parts(self, assembler):
        """html+md selection → html_content AND markdown_content (4.2)."""
        session = _make_session("tn-push-html-md", pagepocket_user_id="u1")
        main_html = "<html><head><title>T</title></head><body>Hi</body></html>"

        captured = self._run_cloud_push(
            assembler, session, main_html,
            markdown_content="# T\n\nHi",
            build_assets=[("images/a.png", "image/png", b"png")],
        )

        assert captured["html_content"] == main_html.encode("utf-8")
        assert captured["markdown_content"] == b"# T\n\nHi"
        assert captured["text_content"] is None
        assert [a[0] for a in captured["assets"]] == ["images/a.png"]
        assert captured["title"] == "T"

    def test_html_md_and_text_push_contains_all_parts(self, assembler):
        session = _make_session("tn-push-all", pagepocket_user_id="u2")

        captured = self._run_cloud_push(
            assembler, session, "<html><body>Hi</body></html>",
            markdown_content="# T",
            text_content="Plain text",
        )

        assert captured["html_content"] == b"<html><body>Hi</body></html>"
        assert captured["markdown_content"] == b"# T"
        assert captured["text_content"] == b"Plain text"

    def test_text_only_push_has_no_html_part_or_assets(self, assembler):
        """HTML off → empty html_content, no assets, markdown present (4.2)."""
        session = _make_session("tn-push-text-only", pagepocket_user_id="u3")

        build_calls = []

        async def _spy_build(sid, db, archive_paths=None):
            build_calls.append(sid)
            return []

        captured = self._run_cloud_push(
            assembler, session, "<html><body>ignored</body></html>",
            download_html=False,
            markdown_content="# Only text",
            build_assets=_spy_build,
        )

        assert captured["html_content"] == b""
        assert captured["markdown_content"] == b"# Only text"
        assert captured["assets"] == []
        assert build_calls == []  # HTML-only assets never built
        assert session.cloud_status == "success"

    def test_text_only_push_derives_title_from_markdown_h1(self, assembler):
        session = _make_session("tn-push-title", pagepocket_user_id="u4")

        captured = self._run_cloud_push(
            assembler, session, "<html><body>ignored</body></html>",
            download_html=False,
            markdown_content="# My Great Page\n\nBody",
        )

        assert captured["title"] == "My Great Page"

    def test_text_only_push_without_text_fails_before_rpc(self, assembler):
        """HTML off + no documents → deterministic failure, push never runs."""
        session = _make_session("tn-push-empty", pagepocket_user_id="u5")

        captured = self._run_cloud_push(
            assembler, session, "<html><body>ignored</body></html>",
            download_html=False,
            markdown_content=None,
            text_content=None,
            push_result=types.SimpleNamespace(page_id=None, error=None),
        )

        assert captured == {}  # push_to_archive never invoked
        assert session.cloud_status == "failed"
        assert "no text content" in session.cloud_error
        assert session.status == "ready"

    def test_legacy_push_payload_unchanged(self, assembler):
        """No text flags → payload identical to today's (4.2)."""
        session = _make_session("tn-push-legacy", pagepocket_user_id="u6")
        main_html = "<html><body>Legacy</body></html>"

        captured = self._run_cloud_push(
            assembler, session, main_html,
            linked={"h": "<html><body>L</body></html>"},
            filenames={"h": "linked.html"},
            build_assets=[("styles/a.css", "text/css", b"css")],
        )

        assert captured["html_content"] == main_html.encode("utf-8")
        assert captured["markdown_content"] is None
        assert captured["text_content"] is None
        asset_paths = [a[0] for a in captured["assets"]]
        assert asset_paths == ["styles/a.css", "pages/linked.html"]

    def test_text_only_push_counts_text_bytes_toward_preflight(
        self, assembler, monkeypatch,
    ):
        from app.services import archive_client as archive_client_mod

        monkeypatch.setattr(
            archive_client_mod, "CLOUD_PUSH_MAX_PAYLOAD_BYTES", 16,
        )
        session = _make_session("tn-push-oversize", pagepocket_user_id="u7")

        captured = self._run_cloud_push(
            assembler, session, "<html><body>ignored</body></html>",
            download_html=False,
            markdown_content="x" * 64,
        )

        assert captured == {}  # failed in pre-flight, push never ran
        assert session.cloud_status == "failed"
        assert "cloud limit" in session.cloud_error


# ---------------------------------------------------------------------------
# push_to_archive payload building (4.1)
# ---------------------------------------------------------------------------


class _FakeContentDocument:
    def __init__(self, content_format="", data=b""):
        self.content_format = content_format
        self.data = data


class _FakeAsset:
    def __init__(self, filename="", content_type="", data=b""):
        self.filename = filename
        self.content_type = content_type
        self.data = data


class _FakeIngestPageRequest:
    def __init__(self, **kwargs):
        self._kwargs = kwargs
        for key, value in kwargs.items():
            setattr(self, key, value)


def _install_fake_proto(monkeypatch, *, with_content_document=True):
    """Inject a fake archive_pb2 module (ContentDocument optional)."""
    class _FakeProto:
        pass

    proto = _FakeProto()
    proto.Asset = _FakeAsset
    proto.IngestPageRequest = _FakeIngestPageRequest
    if with_content_document:
        proto.ContentDocument = _FakeContentDocument
    monkeypatch.setitem(sys.modules, "archive_pb2", proto)
    return proto


class TestPushToArchiveContentDocuments:
    """archive_client builds ContentDocument entries for text formats."""

    def _patch_stub(self, monkeypatch, stub):
        from app.services import archive_client

        monkeypatch.setattr(archive_client, "_get_stub", lambda: stub)
        return archive_client

    def test_request_carries_markdown_and_text_documents(self, monkeypatch):
        pytest.importorskip("grpc", reason="grpc not installed")
        archive_client = self._patch_stub(monkeypatch, types.SimpleNamespace())
        _install_fake_proto(monkeypatch, with_content_document=True)

        captured = {}

        def _capture(request, timeout=None):
            captured["request"] = request
            return types.SimpleNamespace(success=True, page_id="page-docs")

        stub = types.SimpleNamespace(IngestPage=_capture)
        self._patch_stub(monkeypatch, stub)

        result = archive_client.push_to_archive(
            user_id="u", session_id="s-docs", url="https://example.com",
            title="T", html_content=b"<html></html>", assets=[],
            markdown_content=b"# Md",
            text_content=b"Txt",
        )

        assert result.page_id == "page-docs"
        request = captured["request"]
        docs = list(request.content_documents)
        assert [d.content_format for d in docs] == ["markdown", "text"]
        assert docs[0].data == b"# Md"
        assert docs[1].data == b"Txt"
        assert request.html_content == b"<html></html>"

    def test_text_only_request_has_empty_html_content(self, monkeypatch):
        """Text-only push: html_content empty, markdown document present."""
        archive_client = self._patch_stub(monkeypatch, types.SimpleNamespace())
        _install_fake_proto(monkeypatch, with_content_document=True)

        captured = {}

        def _capture(request, timeout=None):
            captured["request"] = request
            return types.SimpleNamespace(success=True, page_id="page-txt")

        self._patch_stub(monkeypatch, types.SimpleNamespace(IngestPage=_capture))

        result = archive_client.push_to_archive(
            user_id="u", session_id="s-txt", url="https://example.com",
            title="T", html_content=b"", assets=[],
            markdown_content=b"# Md only",
        )

        assert result.page_id == "page-txt"
        request = captured["request"]
        assert request.html_content == b""
        docs = list(request.content_documents)
        assert [d.content_format for d in docs] == ["markdown"]

    def test_legacy_payload_builds_no_content_documents(self, monkeypatch):
        """No text flags → request identical to today's (no documents)."""
        archive_client = self._patch_stub(monkeypatch, types.SimpleNamespace())
        _install_fake_proto(monkeypatch, with_content_document=True)

        captured = {}

        def _capture(request, timeout=None):
            captured["request"] = request
            return types.SimpleNamespace(success=True, page_id="page-legacy")

        self._patch_stub(monkeypatch, types.SimpleNamespace(IngestPage=_capture))

        result = archive_client.push_to_archive(
            user_id="u", session_id="s-legacy", url="https://example.com",
            title="T", html_content=b"<html></html>",
            assets=[("a.png", "image/png", b"d")],
        )

        assert result.page_id == "page-legacy"
        request = captured["request"]
        docs = getattr(request, "content_documents", [])
        assert not docs
        assert request.html_content == b"<html></html>"
        assert request.assets[0].filename == "a.png"

    def test_proto_without_content_document_degrades_gracefully(
        self, monkeypatch,
    ):
        """Legacy stubs (D8): text parts dropped, HTML page still pushed."""
        archive_client = self._patch_stub(monkeypatch, types.SimpleNamespace())
        _install_fake_proto(monkeypatch, with_content_document=False)

        captured = {}

        def _capture(request, timeout=None):
            captured["request"] = request
            return types.SimpleNamespace(success=True, page_id="page-degrade")

        self._patch_stub(monkeypatch, types.SimpleNamespace(IngestPage=_capture))

        result = archive_client.push_to_archive(
            user_id="u", session_id="s-degrade", url="https://example.com",
            title="T", html_content=b"<html></html>", assets=[],
            markdown_content=b"# dropped",
        )

        assert result.page_id == "page-degrade"
        assert not getattr(captured["request"], "content_documents", [])
        assert captured["request"].html_content == b"<html></html>"

    def test_text_bytes_count_toward_preflight_cap(self, monkeypatch):
        pytest.importorskip("grpc", reason="grpc not installed")
        from app.services import archive_client

        monkeypatch.setattr(archive_client, "CLOUD_PUSH_MAX_PAYLOAD_BYTES", 32)
        stub = types.SimpleNamespace()
        self._patch_stub(monkeypatch, stub)

        result = archive_client.push_to_archive(
            user_id="u", session_id="s-cap", url="https://example.com",
            title="T", html_content=b"x" * 20, assets=[],
            markdown_content=b"m" * 20,
        )

        assert result.page_id is None
        assert "cloud limit" in result.error

    def test_real_proto_round_trips_content_documents(self, monkeypatch):
        """Against the regenerated archive_pb2 (additive field 8): the
        documents survive serialization with the pinned format enum."""
        try:
            import archive_pb2
        except ImportError:
            pytest.skip("archive proto stubs not available")
        if not hasattr(archive_pb2, "ContentDocument"):
            pytest.skip("proto predates ContentDocument (legacy backend)")

        archive_client = self._patch_stub(monkeypatch, types.SimpleNamespace())

        captured = {}

        def _capture(request, timeout=None):
            captured["request"] = request
            return types.SimpleNamespace(success=True, page_id="page-real")

        self._patch_stub(monkeypatch, types.SimpleNamespace(IngestPage=_capture))

        result = archive_client.push_to_archive(
            user_id="u", session_id="s-real", url="https://example.com",
            title="T", html_content=b"", assets=[],
            markdown_content=b"# Real",
            text_content=b"Real text",
        )

        assert result.page_id == "page-real"
        request = captured["request"]
        assert request.SerializeToString()  # wire-serializable
        assert request.html_content == b""
        docs = list(request.content_documents)
        assert [d.content_format for d in docs] == ["markdown", "text"]
        assert docs[0].data == b"# Real"
        assert docs[1].data == b"Real text"


# ---------------------------------------------------------------------------
# patch helper (module-level so both test classes can use it)
# ---------------------------------------------------------------------------


class _PushPatcher:
    """Context manager replacing archive_client.push_to_archive at call time.

    The assembler imports push_to_archive inside the cloud branch, so the
    module attribute must be patched for the duration of the call.
    """

    def __init__(self, replacement):
        self._replacement = replacement

    def __enter__(self):
        from app.services import archive_client

        self._original = archive_client.push_to_archive
        archive_client.push_to_archive = self._replacement
        return self

    def __exit__(self, *exc):
        from app.services import archive_client

        archive_client.push_to_archive = self._original
        return False


def patch_dict_archive_push(capture_fn):
    """Build a push_to_archive replacement that records kwargs and returns
    a canned success result (used via _PushPatcher)."""
    def _push(**kwargs):
        capture_fn(**kwargs)
        return types.SimpleNamespace(page_id="page-ok", error=None)
    return _PushPatcher(_push)
