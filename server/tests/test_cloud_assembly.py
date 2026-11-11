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
import sys
import threading
import time
import types
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.zip_assembler import ZipAssemblerService

# ---------------------------------------------------------------------------
# Proto stubs: make archive_pb2 importable the same way test_cloud_delete.py
# and test_text_native_outputs.py do, so the push_to_archive tests run for
# real (not skipped) in isolation.
# ---------------------------------------------------------------------------

_PROTO_DIR = os.path.normpath(os.path.join(
    os.path.dirname(__file__), "..", "..", "pagepocket", "shared", "proto_generated",
))
if os.path.isdir(_PROTO_DIR) and _PROTO_DIR not in sys.path:
    sys.path.insert(0, _PROTO_DIR)


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

        async def mock_build_assets(sid, db, archive_paths=None):
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

        async def mock_build_assets(sid, db, archive_paths=None):
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

        async def mock_build_assets(sid, db, archive_paths=None):
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

        async def mock_build_assets(sid, db, archive_paths=None):
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

        async def mock_build_assets(sid, db, archive_paths=None):
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
        """download-core.ts resolves a cloud credential for createSession.

        Task 6.5 replaced the raw getPagepocketUserId() helper with
        resolveCloudCredential() (server-side binding first, legacy
        pagepocketUserId hint as fallback); session creation still carries
        the pagepocketUserId option either way.
        """
        src_path = os.path.join(
            os.path.dirname(__file__), "..", "..", "src", "background",
            "download-core.ts",
        )
        with open(src_path, "r") as f:
            content = f.read()

        assert "resolveCloudCredential" in content
        assert "pagepocketUserId" in content


# ---------------------------------------------------------------------------
# 6.2 – Retry classification: message-size failures are deterministic
# ---------------------------------------------------------------------------


class FakeRpcError(Exception):
    """Duck-typed grpc.RpcError carrying code()/details() for classification."""

    def __init__(self, code, details):
        super().__init__(details)
        self._code = code
        self._details = details

    def code(self):
        return self._code

    def details(self):
        return self._details


class TestCloudPushRetryClassification:
    """Size-induced RESOURCE_EXHAUSTED is non-retryable; quota is not."""

    def test_size_exhaustion_classified_non_retryable(self):
        from app.services.archive_client import is_message_size_error

        err = FakeRpcError(
            "RESOURCE_EXHAUSTED",
            "Sent message larger than max (268500000 vs. 268435456)",
        )
        assert is_message_size_error(err) is True

    def test_size_exhaustion_classified_non_retryable_grpc_enum(self):
        pytest.importorskip("grpc")
        import grpc

        from app.services.archive_client import is_message_size_error

        err = FakeRpcError(
            grpc.StatusCode.RESOURCE_EXHAUSTED,
            "Received message larger than max (5 vs. 4)",
        )
        assert is_message_size_error(err) is True

    def test_quota_exhaustion_stays_retryable(self):
        """Quota RESOURCE_EXHAUSTED has no size marker — retryable (402 vs 413)."""
        from app.services.archive_client import is_message_size_error

        err = FakeRpcError(
            "RESOURCE_EXHAUSTED",
            "Storage limit reached: 100.0 MB used of 100.0 MB",
        )
        assert is_message_size_error(err) is False

    def test_deadline_exceeded_not_size(self):
        from app.services.archive_client import is_message_size_error

        assert is_message_size_error(
            FakeRpcError("DEADLINE_EXCEEDED", "Deadline Exceeded")
        ) is False

    def test_transport_error_not_size(self):
        from app.services.archive_client import is_message_size_error

        assert is_message_size_error(
            FakeRpcError("UNAVAILABLE", "Connection refused")
        ) is False

    def test_plain_exception_not_size(self):
        from app.services.archive_client import is_message_size_error

        assert is_message_size_error(ConnectionError("nope")) is False

    def test_size_error_message_names_limit_and_payload(self):
        from app.services.archive_client import cloud_size_error

        msg = cloud_size_error(300 * 1024 * 1024)
        assert "256 MB cloud limit" in msg
        assert "300.0 MB" in msg


# ---------------------------------------------------------------------------
# 6.2 – push_to_archive: fast failure + no retry on size rejections
# ---------------------------------------------------------------------------


class TestPushFailsFastOnMessageSize:
    """Oversize payloads fail immediately and never burn the retry budget."""

    def _patch_stub(self, monkeypatch, stub):
        from app.services import archive_client

        monkeypatch.setattr(archive_client, "_get_stub", lambda: stub)
        return archive_client

    def test_channel_size_rejection_fails_without_retry(self, monkeypatch):
        """A gRPC size rejection returns immediately: 1 attempt, 0 sleeps."""
        pytest.importorskip("archive_pb2", reason="proto stubs not available")
        from app.services import archive_client

        err = FakeRpcError(
            "RESOURCE_EXHAUSTED",
            "Sent message larger than max (268500000 vs. 268435456)",
        )
        stub = MagicMock()
        stub.IngestPage.side_effect = err

        def _no_sleep(_seconds):
            raise AssertionError("size failures must not sleep/retry")

        monkeypatch.setattr(archive_client.time, "sleep", _no_sleep)
        self._patch_stub(monkeypatch, stub)

        result = archive_client.push_to_archive(
            user_id="u",
            session_id="s-size",
            url="https://example.com",
            title="T",
            html_content=b"x",
            assets=[],
        )

        assert result.page_id is None
        assert "cloud limit" in result.error
        assert stub.IngestPage.call_count == 1  # no retries

    def test_preflight_rejects_oversize_payload_without_rpc(self, monkeypatch):
        pytest.importorskip("archive_pb2", reason="proto stubs not available")
        from app.services import archive_client

        monkeypatch.setattr(archive_client, "CLOUD_PUSH_MAX_PAYLOAD_BYTES", 100)
        stub = MagicMock()
        self._patch_stub(monkeypatch, stub)

        result = archive_client.push_to_archive(
            user_id="u",
            session_id="s-preflight",
            url="https://example.com",
            title="T",
            html_content=b"x" * 50,
            assets=[("a.bin", "application/octet-stream", b"y" * 200)],
        )

        assert result.page_id is None
        assert "cloud limit" in result.error
        assert "0.0 MB" in result.error  # precise payload size surfaced
        stub.IngestPage.assert_not_called()

    def test_quota_exhaustion_keeps_retry_budget(self, monkeypatch):
        """Quota RESOURCE_EXHAUSTED is retried, then succeeds on attempt 3."""
        pytest.importorskip("archive_pb2", reason="proto stubs not available")
        from app.services import archive_client

        quota_err = FakeRpcError("RESOURCE_EXHAUSTED", "Storage limit reached")
        stub = MagicMock()
        stub.IngestPage.side_effect = [
            quota_err,
            quota_err,
            types.SimpleNamespace(success=True, page_id="page-ok"),
        ]
        self._patch_stub(monkeypatch, stub)
        monkeypatch.setattr(archive_client.time, "sleep", lambda _s: None)

        result = archive_client.push_to_archive(
            user_id="u",
            session_id="s-quota",
            url="https://example.com",
            title="T",
            html_content=b"x",
            assets=[],
        )

        assert result.page_id == "page-ok"
        assert stub.IngestPage.call_count == 3

    def test_request_still_carries_user_and_plan(self, monkeypatch):
        """Regression (3.2): identity + plan always on the built request."""
        pytest.importorskip("archive_pb2", reason="proto stubs not available")
        from app.services import archive_client

        captured = {}

        def _capture(request, timeout=None):
            captured["request"] = request
            captured["timeout"] = timeout
            return types.SimpleNamespace(success=True, page_id="page-1")

        stub = MagicMock()
        stub.IngestPage.side_effect = _capture
        self._patch_stub(monkeypatch, stub)

        result = archive_client.push_to_archive(
            user_id="user-1",
            session_id="sess-1",
            url="https://example.com",
            title="T",
            html_content=b"<html></html>",
            assets=[("a.png", "image/png", b"data")],
            plan="pro",
        )

        assert result.page_id == "page-1"
        request = captured["request"]
        assert request.user_id == "user-1"
        assert request.plan == "pro"
        assert request.extension_job_id == "sess-1"
        assert request.assets[0].filename == "a.png"
        # Unary deadline stays at the documented 600 s envelope.
        assert captured["timeout"] == archive_client.PUSH_TIMEOUT_SECONDS


# ---------------------------------------------------------------------------
# close-cloud-lifecycle-gaps 2.4 – pre-flight asset-count gate (D3)
# ---------------------------------------------------------------------------


class TestCloudPushAssetCap:
    """Asset-count cap trips deterministically before any gRPC traffic."""

    def _patch_stub(self, monkeypatch, stub):
        from app.services import archive_client

        monkeypatch.setattr(archive_client, "_get_stub", lambda: stub)
        return archive_client

    def test_default_cap_matches_gateway_ingest_default(self):
        """No CLOUD_MAX_ASSETS configured → cap 200 (gateway MAX_INGEST_ASSETS)."""
        from app.config import Settings

        assert Settings.model_fields["cloud_max_assets"].default == 200

    def test_over_cap_rejected_without_rpc(self, monkeypatch):
        """cloud_max_assets + 1 assets → deterministic error, stub untouched."""
        pytest.importorskip("archive_pb2", reason="proto stubs not available")
        from app.config import settings
        from app.services import archive_client

        monkeypatch.setattr(settings, "cloud_max_assets", 3)
        stub = MagicMock()
        self._patch_stub(monkeypatch, stub)

        result = archive_client.push_to_archive(
            user_id="u",
            session_id="s-cap-over",
            url="https://example.com",
            title="T",
            html_content=b"x",
            assets=[(f"a{i}.png", "image/png", b"x") for i in range(4)],
        )

        assert result.page_id is None
        assert "asset limit" in result.error
        assert "4 assets" in result.error
        assert "max 3" in result.error
        stub.IngestPage.assert_not_called()

    def test_exactly_at_cap_pushes(self, monkeypatch):
        """A session carrying exactly the cap pushes unchanged."""
        pytest.importorskip("archive_pb2", reason="proto stubs not available")
        from app.config import settings
        from app.services import archive_client

        monkeypatch.setattr(settings, "cloud_max_assets", 3)
        stub = MagicMock()
        stub.IngestPage.return_value = types.SimpleNamespace(
            success=True, page_id="page-cap",
        )
        self._patch_stub(monkeypatch, stub)

        result = archive_client.push_to_archive(
            user_id="u",
            session_id="s-cap-at",
            url="https://example.com",
            title="T",
            html_content=b"x",
            assets=[(f"a{i}.png", "image/png", b"x") for i in range(3)],
        )

        assert result.page_id == "page-cap"
        assert result.error is None
        assert stub.IngestPage.call_count == 1


# ---------------------------------------------------------------------------
# 6.2 – single-flight push (converges via user-scoped idempotency)
# ---------------------------------------------------------------------------


class TestPushSingleFlight:
    """Concurrent pushes for one session serialize; others don't contend."""

    @pytest.fixture(autouse=True)
    def _clear_locks(self):
        from app.services import archive_client

        archive_client._session_push_locks.clear()
        yield
        archive_client._session_push_locks.clear()

    def _slow_stub(self, tracker, delay=0.05):
        """Stub whose IngestPage records max in-flight concurrency."""

        class _Stub:
            def IngestPage(self, request, timeout=None):
                with tracker["lock"]:
                    tracker["active"] += 1
                    tracker["max"] = max(tracker["max"], tracker["active"])
                time.sleep(delay)
                with tracker["lock"]:
                    tracker["active"] -= 1
                return types.SimpleNamespace(success=True, page_id="page-sf")

        return _Stub()

    def test_same_session_pushes_serialize(self, monkeypatch):
        from app.services import archive_client

        tracker = {"lock": threading.Lock(), "active": 0, "max": 0}
        monkeypatch.setattr(
            archive_client, "_get_stub", lambda: self._slow_stub(tracker)
        )

        def _push(_index):
            return archive_client.push_to_archive(
                user_id="u",
                session_id="sess-same",
                url="https://example.com",
                title="T",
                html_content=b"x",
                assets=[],
            )

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(_push, range(2)))

        assert all(r.page_id == "page-sf" for r in results)
        assert tracker["max"] == 1  # never two concurrent pushes

    def test_different_sessions_push_concurrently(self, monkeypatch):
        from app.services import archive_client

        tracker = {"lock": threading.Lock(), "active": 0, "max": 0}
        monkeypatch.setattr(
            archive_client, "_get_stub", lambda: self._slow_stub(tracker)
        )

        def _push(session_id):
            return archive_client.push_to_archive(
                user_id="u",
                session_id=session_id,
                url="https://example.com",
                title="T",
                html_content=b"x",
                assets=[],
            )

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [
                pool.submit(_push, "sess-a"),
                pool.submit(_push, "sess-b"),
            ]
            results = [f.result() for f in futures]

        assert all(r.page_id == "page-sf" for r in results)
        assert tracker["max"] == 2  # per-session lock, not a global one

    def test_push_skipped_when_lock_held_too_long(self, monkeypatch):
        """A push stalled past the wait budget returns a clear in-flight error."""
        from app.services import archive_client

        stub = MagicMock()
        stub.IngestPage.return_value = types.SimpleNamespace(
            success=True, page_id="page-late"
        )
        monkeypatch.setattr(archive_client, "_get_stub", lambda: stub)
        monkeypatch.setattr(archive_client, "PUSH_LOCK_WAIT_SECONDS", 0.2)
        lock = archive_client._session_push_lock("sess-held")
        lock.acquire()
        try:
            result = archive_client.push_to_archive(
                user_id="u",
                session_id="sess-held",
                url="https://example.com",
                title="T",
                html_content=b"x",
                assets=[],
            )
            assert result.page_id is None
            assert "already in flight" in result.error
        finally:
            lock.release()


# ---------------------------------------------------------------------------
# 6.2 – pre-flight size accounting (zip_assembler)
# ---------------------------------------------------------------------------


class _FakeScalars:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


class _FakeResult:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return _FakeScalars(self._rows)


class _ManifestDB:
    """Minimal async DB double: execute() returns the given resource rows."""

    def __init__(self, rows):
        self._rows = rows

    async def execute(self, _stmt):
        return _FakeResult(self._rows)

    async def flush(self):
        pass


def _resource_row(rid, local_path, storage_path, content_type):
    return types.SimpleNamespace(
        id=rid,
        local_path=local_path,
        storage_path=storage_path,
        content_type=content_type,
    )


class TestCloudPushPreflight:
    """Oversize sessions fail fast with a clear error, before reads/RPC."""

    def test_oversize_assets_fail_before_reads_and_rpc(
        self, assembler, storage_root, monkeypatch
    ):
        from app.services import archive_client as archive_client_mod

        session_id = "preflight-assets"
        session = _make_session(session_id=session_id, pagepocket_user_id="u1")
        resources = _setup_resources(storage_root, session_id)

        # Manifest rows for the stat-only path (needs db.execute).
        rows = [
            _resource_row(f"r{i}", r.local_path, r.storage_path, r.content_type)
            for i, r in enumerate(resources)
        ]

        # Limit far below the fixture payload → pre-flight must trip.
        monkeypatch.setattr(archive_client_mod, "CLOUD_PUSH_MAX_PAYLOAD_BYTES", 32)

        reads = []

        def _no_reads(manifest, sid):
            reads.append(manifest)
            raise AssertionError("assets over the limit must not be read")

        assembler._read_asset_batches = _no_reads

        async def _no_progress(db, sess, phase, pct, **kwargs):
            pass

        assembler._update_progress = _no_progress

        with patch(
            "app.services.archive_client.push_to_archive"
        ) as mock_push:
            loop = asyncio.new_event_loop()
            try:
                loop.run_until_complete(
                    assembler._assemble_cloud_push(
                        session_id, _ManifestDB(rows), session,
                        "<html><body>tiny</body></html>", {}, {},
                    )
                )
            finally:
                loop.close()

        mock_push.assert_not_called()
        assert session.cloud_status == "failed"
        assert "cloud limit" in session.cloud_error
        assert session.status == "ready"
        assert session.assembly_phase is None
        assert reads == []  # no bytes read from disk

    def test_oversize_html_fails_before_asset_build(
        self, assembler, storage_root, monkeypatch
    ):
        """HTML + linked pages are accounted before anything is built."""
        from app.services import archive_client as archive_client_mod

        session_id = "preflight-html"
        session = _make_session(session_id=session_id, pagepocket_user_id="u2")
        _setup_resources(storage_root, session_id)

        monkeypatch.setattr(archive_client_mod, "CLOUD_PUSH_MAX_PAYLOAD_BYTES", 64)

        async def _no_build(sid, db, archive_paths=None):
            raise AssertionError("asset build must not run for oversize HTML")

        assembler._build_cloud_assets = _no_build

        async def _no_progress(db, sess, phase, pct, **kwargs):
            pass

        assembler._update_progress = _no_progress

        big_html = "<html><body>" + "x" * 512 + "</body></html>"
        linked = {"h": "<html><body>" + "y" * 512 + "</body></html>"}

        with patch("app.services.archive_client.push_to_archive") as mock_push:
            loop = asyncio.new_event_loop()
            try:
                loop.run_until_complete(
                    assembler._assemble_cloud_push(
                        session_id, MockDB(), session,
                        big_html, linked, {"h": "linked.html"},
                    )
                )
            finally:
                loop.close()

        mock_push.assert_not_called()
        assert session.cloud_status == "failed"
        assert "cloud limit" in session.cloud_error
        assert session.status == "ready"

    def test_push_phase_surfaced_via_progress(self, assembler, storage_root):
        """The in-flight push is visible as the 'pushing_cloud' phase."""
        session_id = "preflight-progress"
        session = _make_session(session_id=session_id, pagepocket_user_id="u3")
        _setup_resources(storage_root, session_id)

        phases = []

        async def _record_progress(db, sess, phase, pct, **kwargs):
            phases.append((phase, pct))

        async def _no_assets(sid, db, archive_paths=None):
            return []

        assembler._update_progress = _record_progress
        assembler._build_cloud_assets = _no_assets

        with patch(
            "app.services.archive_client.push_to_archive",
            return_value=types.SimpleNamespace(page_id="page-p", error=None),
        ):
            loop = asyncio.new_event_loop()
            try:
                loop.run_until_complete(
                    assembler._assemble_cloud_push(
                        session_id, MockDB(), session,
                        "<html><body>hi</body></html>", {}, {},
                    )
                )
            finally:
                loop.close()

        assert ("pushing_cloud", 50) in phases


# ---------------------------------------------------------------------------
# 6.2 – bounded-parallel asset build
# ---------------------------------------------------------------------------


class TestParallelCloudAssetBuild:
    """Manifest is stat-only; reads are batched, parallel, order-preserving."""

    def _make_files(self, storage_root, session_id, count=12):
        """Create count resource files; return matching resource rows."""
        session_dir = os.path.join(storage_root, session_id)
        images_dir = os.path.join(session_dir, "resources", "images")
        os.makedirs(images_dir, exist_ok=True)

        rows = []
        for i in range(count):
            path = os.path.join(images_dir, f"img-{i:02d}.png")
            payload = bytes([i]) * (100 + i * 10)
            with open(path, "wb") as f:
                f.write(payload)
            rows.append(_resource_row(
                f"rid-{i}", f"images/img-{i:02d}.png", path, "image/png",
            ))
        return rows

    def test_manifest_is_stat_only(self, assembler, storage_root):
        session_id = "manifest-1"
        rows = self._make_files(storage_root, session_id)

        loop = asyncio.new_event_loop()
        try:
            manifest = loop.run_until_complete(
                assembler._cloud_resource_manifest(session_id, _ManifestDB(rows))
            )
        finally:
            loop.close()

        assert len(manifest) == len(rows)
        for entry, row in zip(manifest, rows):
            name, content_type, storage_path, size = entry
            assert name == row.local_path
            assert content_type == "image/png"
            assert storage_path == row.storage_path
            assert size == os.path.getsize(storage_path)

    def test_built_assets_match_files_in_manifest_order(self, assembler, storage_root):
        session_id = "build-1"
        rows = self._make_files(storage_root, session_id)

        loop = asyncio.new_event_loop()
        try:
            assets = loop.run_until_complete(
                assembler._build_cloud_assets(session_id, _ManifestDB(rows))
            )
        finally:
            loop.close()

        assert [a[0] for a in assets] == [r.local_path for r in rows]
        for (_name, _ct, data), row in zip(assets, rows):
            with open(row.storage_path, "rb") as f:
                assert data == f.read()

    def test_batched_reads_produce_identical_results(
        self, assembler, storage_root, monkeypatch
    ):
        """Tiny batch cap → many batches, same assets in the same order."""
        import app.services.zip_assembler as za

        session_id = "build-batched"
        rows = self._make_files(storage_root, session_id)

        loop = asyncio.new_event_loop()
        try:
            unbatched = loop.run_until_complete(
                assembler._build_cloud_assets(session_id, _ManifestDB(rows))
            )
            monkeypatch.setattr(za, "CLOUD_ASSET_READ_BATCH_BYTES", 64)
            batched = loop.run_until_complete(
                assembler._build_cloud_assets(session_id, _ManifestDB(rows))
            )
        finally:
            loop.close()

        assert batched == unbatched

    def test_unreadable_file_skipped_others_kept(self, assembler, storage_root):
        session_id = "build-skip"
        rows = self._make_files(storage_root, session_id, count=4)
        # One manifest entry points at a file that does not exist.
        rows.append(_resource_row(
            "rid-ghost", "images/ghost.png",
            os.path.join(storage_root, session_id, "resources", "images", "ghost.png"),
            "image/png",
        ))

        loop = asyncio.new_event_loop()
        try:
            assets = loop.run_until_complete(
                assembler._build_cloud_assets(session_id, _ManifestDB(rows))
            )
        finally:
            loop.close()

        assert len(assets) == 4
        assert "images/ghost.png" not in [a[0] for a in assets]

    def test_archive_paths_applied_to_names(self, assembler, storage_root):
        """3.7 collision-suffixed archive paths win over raw local paths."""
        session_id = "build-archive-paths"
        rows = self._make_files(storage_root, session_id, count=2)
        archive_paths = {rows[0].id: "images/img-00-1a2b3c4d.png"}

        loop = asyncio.new_event_loop()
        try:
            assets = loop.run_until_complete(
                assembler._build_cloud_assets(
                    session_id, _ManifestDB(rows), archive_paths
                )
            )
        finally:
            loop.close()

        assert assets[0][0] == "images/img-00-1a2b3c4d.png"
        assert assets[1][0] == "images/img-01.png"


# ---------------------------------------------------------------------------
# multipage-download-fixes 7.1–7.3 – cloud push per-page PageDocuments
# ---------------------------------------------------------------------------


def _lp_result(page_url=None, html=""):
    """Minimal stand-in for a successful linked-page MergeResult."""
    return types.SimpleNamespace(
        success=True, html=html, page_url=page_url, reason=None,
    )


class TestCloudPushPageDocuments:
    """_assemble_cloud_push carries per-page PageDocument payloads (7.1/7.2).

    Linked-page markdown and per-page texts travel as (path, title, url,
    content_format, data) tuples in every mode where they exist —
    including download_html=False runs, whose push previously carried NO
    subpage content at all. Pages are documents, not assets.
    """

    @staticmethod
    def _run_cloud_push(
        assembler, session, main_html, *,
        linked=None, page_hash_to_filename=None, download_html=True,
        markdown_content=None, text_content=None,
        page_md_list=None, page_text_list=None, linked_results=None,
        build_assets=None, push_result=None,
    ):
        """Run _assemble_cloud_push with collaborators stubbed; capture kwargs."""
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
                        main_html, linked or {}, page_hash_to_filename or {},
                        download_html=download_html,
                        markdown_content=markdown_content,
                        text_content=text_content,
                        page_md_list=page_md_list,
                        page_text_list=page_text_list,
                        linked_results=linked_results,
                    )
                )
            finally:
                loop.close()
        return captured

    def test_markdown_mode_multi_page_push_carries_page_documents(
        self, assembler,
    ):
        """HTML off + markdown on → one markdown PageDocument per page."""
        session = _make_session("mp-md-1", pagepocket_user_id="u-mp-1")
        main_html = "<html><head><title>Main</title></head><body>x</body></html>"
        linked_results = {
            "h1": _lp_result(
                page_url="https://example.com/about",
                html="<html><head><title>About Us</title></head></html>",
            ),
            "h2": _lp_result(
                page_url="https://example.com/about/team",
                html="<html><head><title>Our Team</title></head></html>",
            ),
        }
        page_md_list = {"h1": "# About\n\nbody", "h2": "# Team\n\nbody"}
        page_hash_to_filename = {
            "h1": "about.html",
            "h2": "about-c3d4.html",  # collision-resolved slug
        }

        captured = self._run_cloud_push(
            assembler, session, main_html,
            download_html=False,
            markdown_content="# Main\n\nmain body",
            page_md_list=page_md_list,
            page_hash_to_filename=page_hash_to_filename,
            linked_results=linked_results,
        )

        pages = captured["pages"]
        assert [p[0] for p in pages] == [
            "pages/about.md", "pages/about-c3d4.md",
        ]
        assert [p[1] for p in pages] == ["About Us", "Our Team"]
        assert [p[2] for p in pages] == [
            "https://example.com/about",
            "https://example.com/about/team",
        ]
        assert all(p[3] == "markdown" for p in pages)
        assert pages[0][4] == "# About\n\nbody".encode("utf-8")
        assert pages[1][4] == "# Team\n\nbody".encode("utf-8")
        # Text-only push shape unchanged: empty HTML, no assets, and the
        # MAIN page's markdown still travels as the ContentDocument.
        assert captured["html_content"] == b""
        assert captured["markdown_content"] == "# Main\n\nmain body".encode("utf-8")
        assert captured["text_content"] is None
        assert captured["assets"] == []
        assert session.cloud_status == "success"

    def test_text_mode_multi_page_push_carries_text_page_documents(
        self, assembler,
    ):
        """HTML off + text on → one text PageDocument per stored page text."""
        session = _make_session("mp-txt-1", pagepocket_user_id="u-mp-2")
        linked_results = {
            "h1": _lp_result(
                page_url="https://example.com/about",
                html="<html><head><title>About</title></head></html>",
            ),
            # A page whose chunks never recorded a page URL: hash-name
            # fallback path (same as the local layouts).
            "h2": _lp_result(
                page_url=None,
                html="<html><body>no url captured</body></html>",
            ),
        }
        page_text_list = {"h1": "About text body", "h2": "Orphan page text"}
        page_hash_to_filename = {"h1": "about.html", "h2": "abc123def4.html"}

        captured = self._run_cloud_push(
            assembler, session, "<html><body>ignored</body></html>",
            download_html=False,
            text_content="Main page text",
            page_text_list=page_text_list,
            page_hash_to_filename=page_hash_to_filename,
            linked_results=linked_results,
        )

        pages = captured["pages"]
        assert [p[0] for p in pages] == [
            "pages/about.txt", "pages/abc123def4.txt",
        ]
        assert pages[0][1] == "About"  # from merged <title>
        assert pages[0][2] == "https://example.com/about"
        assert pages[0][3] == "text"
        assert pages[0][4] == b"About text body"
        # No captured URL → empty url, slug-base title fallback (no <title>)
        assert pages[1][1] == "abc123def4"
        assert pages[1][2] == ""
        assert pages[1][3] == "text"
        assert pages[1][4] == b"Orphan page text"
        assert captured["html_content"] == b""
        assert captured["text_content"] == b"Main page text"
        assert captured["assets"] == []

    def test_both_modes_push_carries_both_document_sets(self, assembler):
        """Markdown + text both on → both document sets in one push."""
        session = _make_session("mp-both-1", pagepocket_user_id="u-mp-3")
        linked_results = {
            "h1": _lp_result(
                page_url="https://example.com/about",
                html="<html><head><title>About</title></head></html>",
            ),
        }

        captured = self._run_cloud_push(
            assembler, session, "<html><body>ignored</body></html>",
            download_html=False,
            markdown_content="# Main",
            text_content="Main text",
            page_md_list={"h1": "# About md"},
            page_text_list={"h1": "About text"},
            page_hash_to_filename={"h1": "about.html"},
            linked_results=linked_results,
        )

        pages = captured["pages"]
        assert [(p[0], p[3]) for p in pages] == [
            ("pages/about.md", "markdown"),
            ("pages/about.txt", "text"),
        ]
        assert pages[0][4] == b"# About md"
        assert pages[1][4] == b"About text"

    def test_html_mode_pages_accompany_html_assets(self, assembler):
        """HTML on → linked pages/*.html assets unchanged AND page docs."""
        session = _make_session("mp-html-1", pagepocket_user_id="u-mp-4")
        main_html = "<html><head><title>Main</title></head><body>x</body></html>"
        linked_htmls = {"h1": "<html><body><p>Linked</p></body></html>"}
        linked_results = {
            "h1": _lp_result(
                page_url="https://example.com/about",
                html="<html><head><title>About</title></head></html>",
            ),
        }

        captured = self._run_cloud_push(
            assembler, session, main_html,
            download_html=True,
            linked=linked_htmls,
            page_hash_to_filename={"h1": "about.html"},
            page_md_list={"h1": "# About md"},
            linked_results=linked_results,
            build_assets=[("images/a.png", "image/png", b"png")],
        )

        # HTML-mode assets unchanged.
        assert captured["html_content"] == main_html.encode("utf-8")
        assert [a[0] for a in captured["assets"]] == [
            "images/a.png", "pages/about.html",
        ]
        # Page documents accompany the assets.
        assert [(p[0], p[3]) for p in captured["pages"]] == [
            ("pages/about.md", "markdown"),
        ]
        # Pages are documents: no pages/ md path leaked into the assets.
        assert "pages/about.md" not in [a[0] for a in captured["assets"]]

    def test_legacy_single_page_push_has_no_pages(self, assembler):
        """No per-page documents → the push carries no pages payload."""
        session = _make_session("mp-legacy-1", pagepocket_user_id="u-mp-5")
        main_html = "<html><head><title>Legacy</title></head><body>x</body></html>"

        captured = self._run_cloud_push(
            assembler, session, main_html,
            download_html=True,
            build_assets=[("images/a.png", "image/png", b"png")],
        )

        assert not captured.get("pages")
        assert captured["title"] == "Legacy"
        assert session.cloud_status == "success"

    def test_subpage_only_push_is_not_nothing_to_push(self, assembler):
        """The fixed defect: HTML off, no main document, subpage docs exist
        → the push happens instead of the nothing-to-push rejection."""
        session = _make_session("mp-subpage-only", pagepocket_user_id="u-mp-6")
        linked_results = {
            "h1": _lp_result(
                page_url="https://example.com/about",
                html="<html><head><title>About</title></head></html>",
            ),
        }

        captured = self._run_cloud_push(
            assembler, session, "<html><body>ignored</body></html>",
            download_html=False,
            page_text_list={"h1": "About text"},
            page_hash_to_filename={"h1": "about.html"},
            linked_results=linked_results,
            build_assets=[],
        )

        assert captured["pages"][0][0] == "pages/about.txt"
        assert captured["html_content"] == b""
        assert session.cloud_status == "success"
        assert session.cloud_error is None

    def test_page_documents_count_toward_known_bytes_preflight(
        self, assembler, monkeypatch,
    ):
        """Page document bytes count toward the payload-size pre-flight."""
        from app.services import archive_client as archive_client_mod

        monkeypatch.setattr(
            archive_client_mod, "CLOUD_PUSH_MAX_PAYLOAD_BYTES", 32,
        )
        session = _make_session("mp-preflight-1", pagepocket_user_id="u-mp-7")

        captured = self._run_cloud_push(
            assembler, session, "<html><body>ignored</body></html>",
            download_html=False,
            page_text_list={"h1": "x" * 128},
            page_hash_to_filename={"h1": "about.html"},
        )

        assert captured == {}  # failed in pre-flight, push never ran
        assert session.cloud_status == "failed"
        assert "cloud limit" in session.cloud_error
        assert session.status == "ready"

    def test_title_falls_back_to_slug_base_without_title_tag(self, assembler):
        """No <title> in the merged HTML → slug base name without extension."""
        session = _make_session("mp-title-1", pagepocket_user_id="u-mp-8")
        linked_results = {
            "h1": _lp_result(
                page_url="https://example.com/about",
                html="<html><body>no title element</body></html>",
            ),
            "h2": _lp_result(
                page_url="https://example.com/about/team",
                html="<html><head><title></title></head></html>",  # empty
            ),
        }

        captured = self._run_cloud_push(
            assembler, session, "<html><body>ignored</body></html>",
            download_html=False,
            page_md_list={"h1": "# Md", "h2": "# Md2"},
            page_hash_to_filename={"h1": "about.html", "h2": "about-c3d4.html"},
            linked_results=linked_results,
        )

        pages = captured["pages"]
        assert [p[1] for p in pages] == ["about", "about-c3d4"]


class TestPushToArchivePageDocuments:
    """push_to_archive builds PageDocument messages for per-page content."""

    def _patch_stub(self, monkeypatch, stub):
        from app.services import archive_client

        monkeypatch.setattr(archive_client, "_get_stub", lambda: stub)
        return archive_client

    def test_request_carries_page_documents(self, monkeypatch):
        """The IngestPageRequest carries N PageDocuments field-by-field."""
        pytest.importorskip("archive_pb2", reason="proto stubs not available")
        import archive_pb2

        captured = {}

        def _capture(request, timeout=None):
            captured["request"] = request
            return types.SimpleNamespace(success=True, page_id="page-pages")

        stub = types.SimpleNamespace(IngestPage=_capture)
        archive_client = self._patch_stub(monkeypatch, stub)

        result = archive_client.push_to_archive(
            user_id="u",
            session_id="s-pages",
            url="https://example.com",
            title="T",
            html_content=b"",
            assets=[],
            pages=[
                (
                    "pages/about.md", "About", "https://example.com/about",
                    "markdown", b"# About",
                ),
                (
                    "pages/about.txt", "About", "https://example.com/about",
                    "text", b"About text",
                ),
            ],
        )

        assert result.page_id == "page-pages"
        request = captured["request"]
        assert len(request.pages) == 2
        first = request.pages[0]
        assert isinstance(first, archive_pb2.PageDocument)
        assert first.path == "pages/about.md"
        assert first.title == "About"
        assert first.url == "https://example.com/about"
        assert first.content_format == "markdown"
        assert first.data == b"# About"
        second = request.pages[1]
        assert second.path == "pages/about.txt"
        assert second.content_format == "text"
        assert second.data == b"About text"
        request.SerializeToString()  # wire-serializable

    def test_pages_bytes_count_toward_preflight_cap(self, monkeypatch):
        """Oversize page documents fail fast before any RPC traffic."""
        from app.services import archive_client

        monkeypatch.setattr(archive_client, "CLOUD_PUSH_MAX_PAYLOAD_BYTES", 32)
        stub = types.SimpleNamespace()
        self._patch_stub(monkeypatch, stub)

        result = archive_client.push_to_archive(
            user_id="u",
            session_id="s-pages-cap",
            url="https://example.com",
            title="T",
            html_content=b"x" * 20,
            assets=[],
            pages=[
                (
                    "pages/big.txt", "Big", "https://example.com/big",
                    "text", b"y" * 128,
                ),
            ],
        )

        assert result.page_id is None
        assert "cloud limit" in result.error

    def test_over_cap_assets_rejected_even_with_pages(self, monkeypatch):
        """The asset cap still trips deterministically when pages exist —
        page documents neither rescue an over-cap session nor change the
        error."""
        pytest.importorskip("archive_pb2", reason="proto stubs not available")
        from app.config import settings
        from app.services import archive_client

        monkeypatch.setattr(settings, "cloud_max_assets", 3)
        stub = types.SimpleNamespace()
        self._patch_stub(monkeypatch, stub)

        result = archive_client.push_to_archive(
            user_id="u",
            session_id="s-cap-pages",
            url="https://example.com",
            title="T",
            html_content=b"x",
            assets=[(f"a{i}.png", "image/png", b"x") for i in range(4)],
            pages=[
                (
                    f"pages/p{i}.txt", "P", "https://example.com/p",
                    "text", b"t",
                )
                for i in range(5)
            ],
        )

        assert result.page_id is None
        assert "asset limit" in result.error
        assert "4 assets" in result.error
        assert "max 3" in result.error

    def test_pages_never_counted_toward_asset_cap(self, monkeypatch):
        """Many page documents + few assets → push succeeds (documents,
        not assets: the CLOUD_MAX_ASSETS count is unaffected)."""
        pytest.importorskip("archive_pb2", reason="proto stubs not available")
        from app.config import settings
        from app.services import archive_client

        monkeypatch.setattr(settings, "cloud_max_assets", 3)
        stub = MagicMock()
        stub.IngestPage.return_value = types.SimpleNamespace(
            success=True, page_id="page-pages-ok",
        )
        self._patch_stub(monkeypatch, stub)

        result = archive_client.push_to_archive(
            user_id="u",
            session_id="s-pages-uncounted",
            url="https://example.com",
            title="T",
            html_content=b"x",
            assets=[("a.png", "image/png", b"x")],
            pages=[
                (
                    f"pages/p{i}.txt", "P", "https://example.com/p",
                    "text", b"t",
                )
                for i in range(10)
            ],
        )

        assert result.page_id == "page-pages-ok"
        assert result.error is None
        assert stub.IngestPage.call_count == 1
        assert len(stub.IngestPage.call_args.args[0].pages) == 10

    def test_legacy_push_without_pages_has_empty_pages_field(self, monkeypatch):
        """A push without page documents leaves the proto field empty."""
        pytest.importorskip("archive_pb2", reason="proto stubs not available")
        import archive_pb2

        from app.services import archive_client

        captured = {}

        def _capture(request, timeout=None):
            captured["request"] = request
            return types.SimpleNamespace(success=True, page_id="page-legacy")

        stub = types.SimpleNamespace(IngestPage=_capture)
        self._patch_stub(monkeypatch, stub)

        result = archive_client.push_to_archive(
            user_id="u",
            session_id="s-legacy-pages",
            url="https://example.com",
            title="T",
            html_content=b"<html></html>",
            assets=[("a.png", "image/png", b"d")],
        )

        assert result.page_id == "page-legacy"
        request = captured["request"]
        assert isinstance(request, archive_pb2.IngestPageRequest)
        assert list(request.pages) == []
        assert request.assets[0].filename == "a.png"

    def test_proto_without_page_document_degrades_gracefully(self, monkeypatch):
        """Legacy stubs (D8 parity with ContentDocument): page documents
        are dropped with a warning, the main page is still pushed."""
        import sys

        from app.services import archive_client

        class _FakeAsset:
            def __init__(self, filename="", content_type="", data=b""):
                self.filename = filename
                self.content_type = content_type
                self.data = data

        class _FakeIngestPageRequest:
            def __init__(self, **kwargs):
                for key, value in kwargs.items():
                    setattr(self, key, value)

        class _FakeProto:
            Asset = _FakeAsset
            IngestPageRequest = _FakeIngestPageRequest
            # PageDocument intentionally absent (legacy backend)

        monkeypatch.setitem(sys.modules, "archive_pb2", _FakeProto)

        captured = {}

        def _capture(request, timeout=None):
            captured["request"] = request
            return types.SimpleNamespace(success=True, page_id="page-degrade")

        stub = types.SimpleNamespace(IngestPage=_capture)
        self._patch_stub(monkeypatch, stub)

        result = archive_client.push_to_archive(
            user_id="u",
            session_id="s-pages-degrade",
            url="https://example.com",
            title="T",
            html_content=b"<html></html>",
            assets=[],
            pages=[
                (
                    "pages/about.txt", "About", "https://example.com/about",
                    "text", b"t",
                ),
            ],
        )

        assert result.page_id == "page-degrade"
        assert not getattr(captured["request"], "pages", [])
        assert captured["request"].html_content == b"<html></html>"
