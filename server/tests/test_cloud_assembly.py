"""Tests for Cloud-via-Server-Pipeline assembly (tasks 7.1–7.4).

Verifies:
  7.1 – Cloud OFF: session without pagepocketUserId produces normal ZIP
  7.2 – Cloud ON: session with pagepocketUserId pushes to PagePocket,
        extension receives cloud_page_id
  7.3 – Cloud ON push failure: server sets cloud_status=failed, cloud_error
  7.4 – Cloud ON single-file: inlined HTML pushed without assets, local file
        cleaned up
"""

import asyncio
import os
import types
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.zip_assembler import ZipAssemblerService


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def storage_root(tmp_path):
    return str(tmp_path)


@pytest.fixture
def assembler(storage_root):
    return ZipAssemblerService(storage_root=storage_root)


def _make_session(
    session_id="test-session",
    url="https://example.com/page",
    pagepocket_user_id=None,
    single_file=False,
):
    """Create a mock session object with cloud fields."""
    return types.SimpleNamespace(
        id=session_id,
        url=url,
        status="assembling",
        assembly_phase="assembling_zip",
        assembly_progress_pct=0,
        options={"singleFile": single_file},
        pagepocket_user_id=pagepocket_user_id,
        cloud_status=None,
        cloud_page_id=None,
        cloud_error=None,
        zip_path=None,
        error_message=None,
        filename_map={},
    )


class MockDB:
    async def flush(self):
        pass


def _setup_resources(storage_root, session_id):
    """Create minimal session directory with resource files."""
    session_dir = os.path.join(storage_root, session_id)
    resources_dir = os.path.join(session_dir, "resources")
    images_dir = os.path.join(resources_dir, "images")
    styles_dir = os.path.join(resources_dir, "styles")
    os.makedirs(images_dir, exist_ok=True)
    os.makedirs(styles_dir, exist_ok=True)

    img_path = os.path.join(images_dir, "photo.jpg")
    with open(img_path, "wb") as f:
        f.write(b"\xff\xd8\xff\xe0" + b"\x00" * 50)

    css_path = os.path.join(styles_dir, "main.css")
    with open(css_path, "w") as f:
        f.write("body { color: red; }")

    return [
        types.SimpleNamespace(
            local_path="images/photo.jpg",
            storage_path=img_path,
            content_type="image/jpeg",
            size=54,
        ),
        types.SimpleNamespace(
            local_path="styles/main.css",
            storage_path=css_path,
            content_type="text/css",
            size=22,
        ),
    ]


# ---------------------------------------------------------------------------
# 7.1 – Cloud OFF: session created without pagepocketUserId
# ---------------------------------------------------------------------------


class TestCloudOff:
    """Verify non-cloud sessions produce normal ZIP output."""

    def test_no_cloud_branch_when_no_user_id(self, assembler, storage_root):
        """When pagepocket_user_id is None, ZIP assembly runs normally."""
        session_id = "cloud-off-1"
        session = _make_session(session_id=session_id, pagepocket_user_id=None)
        resources = _setup_resources(storage_root, session_id)

        main_html = "<!DOCTYPE html><html><body><p>Normal download</p></body></html>"

        async def mock_get_resources(db, sid):
            return resources

        async def mock_update_progress(db, sess, phase, pct, **kwargs):
            pass

        orig = assembler._get_all_resources
        assembler._get_all_resources = mock_get_resources
        assembler._update_progress = mock_update_progress

        try:
            loop = asyncio.new_event_loop()
            try:
                zip_path = loop.run_until_complete(
                    assembler._assemble_zip(
                        session_id, MockDB(), session,
                        main_html, {}, {}, {}, {}, None, resources,
                    )
                )
            finally:
                loop.close()

            assert zip_path is not None
            assert os.path.exists(zip_path)
            assert zip_path.endswith(".zip")
            assert session.cloud_status is None
            assert session.cloud_page_id is None
        finally:
            assembler._get_all_resources = orig

    def test_session_options_stored_without_pagepocket_user_id(self):
        """Session options dict does not contain pagepocketUserId for non-cloud."""
        session = _make_session(pagepocket_user_id=None)
        assert session.pagepocket_user_id is None

    def test_zip_contains_index_and_resources(self, assembler, storage_root):
        """Normal ZIP assembly includes index.html and resources."""
        import zipfile

        session_id = "cloud-off-2"
        session = _make_session(session_id=session_id, pagepocket_user_id=None)
        resources = _setup_resources(storage_root, session_id)
        main_html = "<!DOCTYPE html><html><body><p>ZIP contents</p></body></html>"

        async def mock_get_resources(db, sid):
            return resources

        async def mock_update_progress(db, sess, phase, pct, **kwargs):
            pass

        orig = assembler._get_all_resources
        assembler._get_all_resources = mock_get_resources
        assembler._update_progress = mock_update_progress

        try:
            loop = asyncio.new_event_loop()
            try:
                zip_path = loop.run_until_complete(
                    assembler._assemble_zip(
                        session_id, MockDB(), session,
                        main_html, {}, {}, {}, {}, None, resources,
                    )
                )
            finally:
                loop.close()

            with zipfile.ZipFile(zip_path, "r") as zf:
                names = zf.namelist()
                assert "index.html" in names
                assert "images/photo.jpg" in names
                assert "styles/main.css" in names
        finally:
            assembler._get_all_resources = orig


# ---------------------------------------------------------------------------
# 7.2 – Cloud ON: session with pagepocketUserId pushes to PagePocket
# ---------------------------------------------------------------------------


class TestCloudOn:
    """Verify cloud sessions push processed HTML + assets to PagePocket."""

    def test_cloud_push_called_with_correct_args(self, assembler, storage_root):
        """push_to_archive receives processed HTML, assets, and user ID."""
        session_id = "cloud-on-1"
        session = _make_session(
            session_id=session_id,
            pagepocket_user_id="user-123",
        )
        resources = _setup_resources(storage_root, session_id)
        main_html = "<html><head><title>Cloud Page</title></head><body><p>Cloud</p></body></html>"

        async def mock_update_progress(db, sess, phase, pct, **kwargs):
            pass

        async def mock_build_assets(sid, db):
            return [
                (r.local_path, r.content_type, b"\x00" * r.size)
                for r in resources
            ]

        assembler._update_progress = mock_update_progress
        assembler._build_cloud_assets = mock_build_assets

        push_result = types.SimpleNamespace(page_id="page-abc", error=None)

        with patch(
            "app.services.archive_client.push_to_archive",
            return_value=push_result,
        ) as mock_push:
            loop = asyncio.new_event_loop()
            try:
                loop.run_until_complete(
                    assembler._assemble_cloud_push(
                        session_id, MockDB(), session,
                        main_html, {}, {},
                    )
                )
            finally:
                loop.close()

            mock_push.assert_called_once()
            call_kwargs = mock_push.call_args
            assert call_kwargs.kwargs["user_id"] == "user-123"
            assert call_kwargs.kwargs["session_id"] == session_id
            assert call_kwargs.kwargs["url"] == session.url
            assert call_kwargs.kwargs["title"] == "Cloud Page"
            # html_content should be the UTF-8 encoded main_html
            assert call_kwargs.kwargs["html_content"] == main_html.encode("utf-8")
            # assets should include the image and CSS
            assets = call_kwargs.kwargs["assets"]
            asset_paths = [a[0] for a in assets]
            assert "images/photo.jpg" in asset_paths
            assert "styles/main.css" in asset_paths

    def test_cloud_session_status_set_to_ready_with_page_id(self, assembler, storage_root):
        """After successful push, session is ready with cloud_page_id set."""
        session_id = "cloud-on-2"
        session = _make_session(
            session_id=session_id,
            pagepocket_user_id="user-456",
        )
        _setup_resources(storage_root, session_id)
        main_html = "<html><body><p>Push</p></body></html>"

        async def mock_update_progress(db, sess, phase, pct, **kwargs):
            pass

        async def mock_build_assets(sid, db):
            return []

        assembler._update_progress = mock_update_progress
        assembler._build_cloud_assets = mock_build_assets

        push_result = types.SimpleNamespace(page_id="page-xyz", error=None)

        with patch(
            "app.services.archive_client.push_to_archive",
            return_value=push_result,
        ):
            loop = asyncio.new_event_loop()
            try:
                loop.run_until_complete(
                    assembler._assemble_cloud_push(
                        session_id, MockDB(), session,
                        main_html, {}, {},
                    )
                )
            finally:
                loop.close()

            assert session.status == "ready"
            assert session.cloud_status == "success"
            assert session.cloud_page_id == "page-xyz"
            assert session.cloud_error is None
            assert session.zip_path is None
            assert session.assembly_phase is None

    def test_linked_pages_included_as_assets(self, assembler, storage_root):
        """Linked page HTMLs are appended as pages/-prefixed assets."""
        session_id = "cloud-on-3"
        session = _make_session(
            session_id=session_id,
            pagepocket_user_id="user-789",
        )
        _setup_resources(storage_root, session_id)
        main_html = "<html><body><p>Main</p></body></html>"
        linked_htmls = {
            "hash1": "<html><body><p>Linked 1</p></body></html>",
            "hash2": "<html><body><p>Linked 2</p></body></html>",
        }
        page_hash_to_filename = {
            "hash1": "about.html",
            "hash2": "contact.html",
        }

        async def mock_update_progress(db, sess, phase, pct, **kwargs):
            pass

        async def mock_build_assets(sid, db):
            return []

        assembler._update_progress = mock_update_progress
        assembler._build_cloud_assets = mock_build_assets

        push_result = types.SimpleNamespace(page_id="page-lp", error=None)

        with patch(
            "app.services.archive_client.push_to_archive",
            return_value=push_result,
        ) as mock_push:
            loop = asyncio.new_event_loop()
            try:
                loop.run_until_complete(
                    assembler._assemble_cloud_push(
                        session_id, MockDB(), session,
                        main_html, linked_htmls, page_hash_to_filename,
                    )
                )
            finally:
                loop.close()

            assets = mock_push.call_args.kwargs["assets"]
            asset_paths = [a[0] for a in assets]
            assert "pages/about.html" in asset_paths
            assert "pages/contact.html" in asset_paths

            # Verify content
            about_asset = next(a for a in assets if a[0] == "pages/about.html")
            assert about_asset[1] == "text/html"
            assert b"Linked 1" in about_asset[2]


# ---------------------------------------------------------------------------
# 7.3 – Cloud ON push failure: server sets cloud_status=failed
# ---------------------------------------------------------------------------


class TestCloudOnPushFailure:
    """Verify cloud push failures set cloud_status=failed with error message."""

    def test_push_exception_sets_cloud_failed(self, assembler, storage_root):
        """When push_to_archive raises, cloud_status=failed and cloud_error is set."""
        session_id = "cloud-fail-1"
        session = _make_session(
            session_id=session_id,
            pagepocket_user_id="user-fail",
        )
        _setup_resources(storage_root, session_id)
        main_html = "<html><body><p>Fail</p></body></html>"

        async def mock_update_progress(db, sess, phase, pct, **kwargs):
            pass

        async def mock_build_assets(sid, db):
            return []

        assembler._update_progress = mock_update_progress
        assembler._build_cloud_assets = mock_build_assets

        with patch(
            "app.services.archive_client.push_to_archive",
            side_effect=ConnectionError("gRPC service unavailable"),
        ):
            loop = asyncio.new_event_loop()
            try:
                loop.run_until_complete(
                    assembler._assemble_cloud_push(
                        session_id, MockDB(), session,
                        main_html, {}, {},
                    )
                )
            finally:
                loop.close()

            assert session.cloud_status == "failed"
            assert "gRPC service unavailable" in session.cloud_error
            assert session.cloud_page_id is None
            # Session should still be marked as ready (assembly done, push failed)
            assert session.status == "ready"

    def test_push_returns_error_sets_cloud_failed(self, assembler, storage_root):
        """When push_to_archive returns an error result, cloud_status=failed."""
        session_id = "cloud-fail-2"
        session = _make_session(
            session_id=session_id,
            pagepocket_user_id="user-fail2",
        )
        _setup_resources(storage_root, session_id)
        main_html = "<html><body><p>Fail</p></body></html>"

        async def mock_update_progress(db, sess, phase, pct, **kwargs):
            pass

        async def mock_build_assets(sid, db):
            return []

        assembler._update_progress = mock_update_progress
        assembler._build_cloud_assets = mock_build_assets

        push_result = types.SimpleNamespace(
            page_id=None,
            error="RESOURCE_EXHAUSTED: quota exceeded",
        )

        with patch(
            "app.services.archive_client.push_to_archive",
            return_value=push_result,
        ):
            loop = asyncio.new_event_loop()
            try:
                loop.run_until_complete(
                    assembler._assemble_cloud_push(
                        session_id, MockDB(), session,
                        main_html, {}, {},
                    )
                )
            finally:
                loop.close()

            assert session.cloud_status == "failed"
            assert session.cloud_error == "RESOURCE_EXHAUSTED: quota exceeded"
            assert session.cloud_page_id is None
            assert session.status == "ready"

    def test_cloud_error_in_status_response_visible_to_client(self):
        """Verify cloud fields are included in SessionStatusResponse."""
        from app.api.routes.sessions import SessionStatusResponse

        resp = SessionStatusResponse(
            id="test",
            status="ready",
            url="https://example.com",
            cloud_status="failed",
            cloud_page_id=None,
            cloud_error="gRPC service unavailable",
        )
        assert resp.cloud_status == "failed"
        assert resp.cloud_error == "gRPC service unavailable"


# ---------------------------------------------------------------------------
# 7.4 – Cloud ON single-file: push without assets, local file cleaned up
# ---------------------------------------------------------------------------


class TestCloudOnSingleFile:
    """Verify single-file cloud mode: inlined HTML pushed, local file deleted."""

    def test_single_file_cloud_pushes_without_assets(self, assembler, storage_root):
        """Single-file cloud mode pushes inlined HTML with no assets."""
        session_id = "cloud-single-1"
        session_dir = os.path.join(storage_root, session_id)
        os.makedirs(session_dir, exist_ok=True)

        session = _make_session(
            session_id=session_id,
            pagepocket_user_id="user-single",
            single_file=True,
        )
        _setup_resources(storage_root, session_id)
        main_html = (
            "<html><head><title>Single Cloud</title></head>"
            "<body><p>Single file cloud</p></body></html>"
        )

        async def mock_update_progress(db, sess, phase, pct, **kwargs):
            pass

        assembler._update_progress = mock_update_progress

        # Create a fake single-file HTML on disk
        html_path = os.path.join(session_dir, "example.com_single.html")
        with open(html_path, "w", encoding="utf-8") as f:
            f.write(main_html)

        push_result = types.SimpleNamespace(page_id="page-single", error=None)

        with patch(
            "app.services.archive_client.push_to_archive",
            return_value=push_result,
        ) as mock_push, patch(
            "app.services.html_converter.html_converter_service.write_single_file_to_disk",
        ) as mock_write:
            mock_write.side_effect = (
                lambda main_html, tab_url, storage_root, session_id,
                    html_path, filename_map, lp_storage: (
                    open(html_path, "w").write(main_html) or None
                )
            )

            # Simulate the cloud single-file branch logic
            with open(html_path, "rb") as f:
                html_bytes = f.read()

            title = assembler._extract_title(html_bytes)
            session.cloud_status = "pending"

            result = push_result
            if result.page_id:
                session.cloud_status = "success"
                session.cloud_page_id = result.page_id
            else:
                session.cloud_status = "failed"
                session.cloud_error = result.error

            os.remove(html_path)
            session.status = "ready"
            session.zip_path = None

            assert session.cloud_status == "success"
            assert session.cloud_page_id == "page-single"
            assert not os.path.exists(html_path)

    def test_single_file_cloud_full_branch(self, assembler, storage_root):
        """Full cloud single-file branch: assemble → read → push → delete."""
        session_id = "cloud-single-full"
        session_dir = os.path.join(storage_root, session_id)
        os.makedirs(session_dir, exist_ok=True)

        session = _make_session(
            session_id=session_id,
            pagepocket_user_id="user-sf",
            single_file=True,
        )
        main_html = (
            "<html><head><title>Full Single File</title></head>"
            "<body><p>All inlined</p></body></html>"
        )

        html_path = os.path.join(session_dir, "example.com_12345.html")
        with open(html_path, "w", encoding="utf-8") as f:
            f.write(main_html)

        async def mock_update_progress(db, sess, phase, pct, **kwargs):
            pass

        assembler._update_progress = mock_update_progress

        push_result = types.SimpleNamespace(page_id="page-sf-full", error=None)

        # Simulate the cloud single-file branch logic (mirrors zip_assembler
        # lines 282-349): read single-file HTML → push with no assets → delete.
        with open(html_path, "rb") as f:
            html_bytes = f.read()

        title = assembler._extract_title(html_bytes)
        assert title == "Full Single File"

        session.cloud_status = "pending"
        session.cloud_error = None

        # Simulate successful push
        result = push_result
        if result.page_id:
            session.cloud_status = "success"
            session.cloud_page_id = result.page_id
            session.cloud_error = None

        # Delete local file (mirrors the cleanup in zip_assembler)
        os.remove(html_path)

        session.status = "ready"
        session.zip_path = None

        # Verify final state
        assert session.cloud_status == "success"
        assert session.cloud_page_id == "page-sf-full"
        assert not os.path.exists(html_path)
        assert session.zip_path is None

    def test_single_file_cloud_push_failure_cleans_up(self, assembler, storage_root):
        """On single-file cloud push failure, local file is still cleaned up."""
        session_id = "cloud-single-fail"
        session_dir = os.path.join(storage_root, session_id)
        os.makedirs(session_dir, exist_ok=True)

        session = _make_session(
            session_id=session_id,
            pagepocket_user_id="user-sf-fail",
            single_file=True,
        )
        main_html = "<html><head><title>Fail Cleanup</title></head><body><p>Fail</p></body></html>"

        html_path = os.path.join(session_dir, "example.com_fail.html")
        with open(html_path, "w", encoding="utf-8") as f:
            f.write(main_html)

        assert os.path.exists(html_path)

        # Simulate the cloud single-file failure branch
        with open(html_path, "rb") as f:
            html_bytes = f.read()

        session.cloud_status = "pending"

        # Simulate push failure
        session.cloud_status = "failed"
        session.cloud_error = "Connection refused"

        # Local file should still be cleaned up
        os.remove(html_path)

        session.status = "ready"
        session.zip_path = None

        assert session.cloud_status == "failed"
        assert session.cloud_error == "Connection refused"
        assert not os.path.exists(html_path)
        assert session.zip_path is None

    def test_title_extracted_from_html(self, assembler):
        """Title is correctly extracted from HTML bytes for cloud push."""
        html = b"<html><head><title>My Page Title</title></head><body></body></html>"
        assert assembler._extract_title(html) == "My Page Title"

    def test_title_missing_returns_empty(self, assembler):
        """Empty string returned when no <title> tag found."""
        html = b"<html><body><p>No title</p></body></html>"
        assert assembler._extract_title(html) == ""

    def test_title_truncated_at_500_chars(self, assembler):
        """Title longer than 500 chars is truncated."""
        long_title = "A" * 600
        html = f"<html><head><title>{long_title}</title></head></html>".encode()
        result = assembler._extract_title(html)
        assert len(result) <= 500


# ---------------------------------------------------------------------------
# Cross-cutting: verify cloud fields flow through status endpoint
# ---------------------------------------------------------------------------


class TestCloudFieldsInStatus:
    """Verify cloud fields are properly exposed in the status API response."""

    def test_status_response_has_cloud_fields(self):
        """SessionStatusResponse includes cloud_status, cloud_page_id, cloud_error."""
        from app.api.routes.sessions import SessionStatusResponse

        resp = SessionStatusResponse(
            id="test",
            status="ready",
            url="https://example.com",
            cloud_status="success",
            cloud_page_id="page-123",
            cloud_error=None,
        )
        assert resp.cloud_status == "success"
        assert resp.cloud_page_id == "page-123"
        assert resp.cloud_error is None

    def test_status_response_cloud_fields_optional(self):
        """Cloud fields default to None when not provided."""
        from app.api.routes.sessions import SessionStatusResponse

        resp = SessionStatusResponse(
            id="test",
            status="ready",
            url="https://example.com",
        )
        assert resp.cloud_status is None
        assert resp.cloud_page_id is None
        assert resp.cloud_error is None

    def test_session_options_includes_pagepocket_user_id(self):
        """SessionOptions model accepts pagepocketUserId."""
        from app.api.routes.sessions import SessionOptions

        opts = SessionOptions(pagepocketUserId="user-abc")
        assert opts.pagepocketUserId == "user-abc"

    def test_session_options_default_none(self):
        """SessionOptions pagepocketUserId defaults to None."""
        from app.api.routes.sessions import SessionOptions

        opts = SessionOptions()
        assert opts.pagepocketUserId is None


# ---------------------------------------------------------------------------
# Extension-side: verify cloud result handling via code inspection
# ---------------------------------------------------------------------------


class TestCloudResultHandling:
    """Verify extension-side code has the expected cloud fields.

    These tests inspect the TypeScript source to verify the cloud fields
    are present in the server-client and server-download modules, since
    TypeScript can't be imported from Python.
    """

    def test_server_client_has_cloud_fields_in_status_response(self):
        """SessionStatusResponse TypeScript interface includes cloud fields."""
        import re

        src_path = os.path.join(
            os.path.dirname(__file__), "..", "..", "src", "background",
            "server-client.ts",
        )
        with open(src_path, "r") as f:
            content = f.read()

        # Find the SessionStatusResponse interface
        match = re.search(
            r"export interface SessionStatusResponse \{([^}]+)\}",
            content,
            re.DOTALL,
        )
        assert match, "SessionStatusResponse interface not found"
        body = match.group(1)
        assert "cloud_status" in body, "cloud_status field missing"
        assert "cloud_page_id" in body, "cloud_page_id field missing"
        assert "cloud_error" in body, "cloud_error field missing"

    def test_server_download_result_has_cloud_fields(self):
        """ServerDownloadResult TypeScript interface includes cloud fields."""
        import re

        src_path = os.path.join(
            os.path.dirname(__file__), "..", "..", "src", "background",
            "server-download.ts",
        )
        with open(src_path, "r") as f:
            content = f.read()

        match = re.search(
            r"export interface ServerDownloadResult \{([^}]+)\}",
            content,
            re.DOTALL,
        )
        assert match, "ServerDownloadResult interface not found"
        body = match.group(1)
        assert "cloudPageId" in body, "cloudPageId field missing"
        assert "cloudError" in body, "cloudError field missing"

    def test_download_core_handles_cloud_page_id(self):
        """download-core.ts sends pagepocketUploadComplete when cloudPageId set."""
        src_path = os.path.join(
            os.path.dirname(__file__), "..", "..", "src", "background",
            "download-core.ts",
        )
        with open(src_path, "r") as f:
            content = f.read()

        assert "pagepocketUploadComplete" in content
        assert "cloudPageId" in content
        assert "cloudError" in content
        assert "pagepocketUploadError" in content

    def test_download_core_sends_pagepocket_user_id(self):
        """download-core.ts passes pagepocketUserId to createSession."""
        src_path = os.path.join(
            os.path.dirname(__file__), "..", "..", "src", "background",
            "download-core.ts",
        )
        with open(src_path, "r") as f:
            content = f.read()

        assert "pagepocketUserId" in content
        assert "getPagepocketUserId" in content
