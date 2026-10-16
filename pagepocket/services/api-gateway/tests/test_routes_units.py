"""API Gateway route unit tests — no live stack required.

Covers the plan-authority regression (2.1), the share router's mandatory
ownership passthrough (2.3/2.4) and the per-call gRPC deadlines (D11 subset).
The gRPC stubs are mocked; request.state simulates what the auth middleware
populates from the verified JWT.
"""

import asyncio
import io
import os
import types
import unittest
from unittest.mock import MagicMock, patch

import archive_pb2
import common_pb2
import grpc
import share_pb2
from fastapi import HTTPException
from routers import archive as archive_routes
from routers import auth as auth_routes
from routers import share as share_routes


class _FakeRpcError(grpc.RpcError):
    def __init__(self, code, details="fake"):
        self._code = code
        self._details = details

    def code(self):
        return self._code

    def details(self):
        return self._details


def _fake_request(user_id="u1", plan="free", headers=None):
    """Stand-in for a Request after the auth middleware ran."""
    all_headers = {"content-length": "1024"}  # ingest requires a declared length
    all_headers.update(headers or {})
    return types.SimpleNamespace(
        state=types.SimpleNamespace(user_id=user_id, plan=plan),
        headers=all_headers,
    )


def _fake_upload(data: bytes, filename="index.html", content_type="text/html"):
    """UploadFile stand-in: async read(size) over an in-memory buffer."""
    buf = io.BytesIO(data)

    async def read(size=-1):
        return buf.read(size)

    return types.SimpleNamespace(read=read, filename=filename, content_type=content_type)


def _run(coro):
    return asyncio.run(coro)


class TestIngestPlanAuthority(unittest.TestCase):
    """2.1: the client `plan` form field can never override the JWT claim."""

    def setUp(self):
        self.stub = MagicMock()
        p = patch.object(archive_routes, "archive_stub", return_value=self.stub)
        p.start()
        self.addCleanup(p.stop)

    def _ingest(self, state_plan="free", form_plan="pro"):
        self.stub.IngestPage.return_value = archive_pb2.IngestPageResponse(
            success=True, page_id="p1",
        )
        request = _fake_request(user_id="u1", plan=state_plan)
        return _run(archive_routes.ingest_page(
            request,
            url="https://example.com",
            title="T",
            html_content=_fake_upload(b"<html></html>"),
            extension_job_id="job-1",
            plan=form_plan,  # what an old extension (or attacker) sends
            assets=[],
        )), self.stub.IngestPage.call_args

    def test_free_jwt_with_pro_form_field_sends_free(self):
        """The regression: plan=pro from a free-plan JWT must not escalate."""
        _resp, call = self._ingest(state_plan="free", form_plan="pro")
        sent_request = call.args[0]
        self.assertEqual(sent_request.plan, "free")
        self.assertEqual(sent_request.user_id, "u1")

    def test_pro_jwt_with_free_form_field_sends_pro(self):
        _resp, call = self._ingest(state_plan="pro", form_plan="free")
        self.assertEqual(call.args[0].plan, "pro")

    def test_empty_form_field_uses_jwt_claim(self):
        _resp, call = self._ingest(state_plan="team", form_plan="")
        self.assertEqual(call.args[0].plan, "team")

    def test_ingest_call_has_expanded_deadline(self):
        """Ingest/push-class calls get the larger timeout budget."""
        _resp, call = self._ingest()
        self.assertEqual(call.kwargs.get("timeout"), 120)

    def test_quota_error_maps_to_402_not_403(self):
        self.stub.IngestPage.side_effect = _FakeRpcError(
            grpc.StatusCode.RESOURCE_EXHAUSTED, "Monthly page limit reached",
        )
        request = _fake_request(user_id="u1", plan="free")
        with self.assertRaises(HTTPException) as cm:
            _run(archive_routes.ingest_page(
                request, url="https://example.com", title="T",
                html_content=_fake_upload(b"<html></html>"),
                extension_job_id="job-1", plan="pro", assets=[],
            ))
        self.assertEqual(cm.exception.status_code, 402)


class TestShareRouterOwnership(unittest.TestCase):
    """2.2/2.3/2.4: owner resolved at ValidateToken flows downstream."""

    def setUp(self):
        self.share_stub = MagicMock()
        self.archive_stub = MagicMock()
        p1 = patch.object(share_routes, "share_stub", return_value=self.share_stub)
        p2 = patch.object(share_routes, "archive_stub", return_value=self.archive_stub)
        p1.start()
        p2.start()
        self.addCleanup(p1.stop)
        self.addCleanup(p2.stop)

    # -- CreateShareLink pre-check (2.4, gateway side) --

    def test_create_share_link_checks_page_ownership_first(self):
        request = _fake_request(user_id="u1")
        order = []
        self.archive_stub.GetPage.side_effect = lambda *a, **k: order.append("getpage")
        self.share_stub.CreateShareLink.side_effect = (
            lambda *a, **k: order.append("create") or share_pb2.ShareLinkResponse(token="t")
        )

        resp = _run(share_routes.create_share_link(request, {"page_id": "p1"}))
        self.assertEqual(resp["token"], "t")
        self.assertEqual(order, ["getpage", "create"])
        sent = self.archive_stub.GetPage.call_args.args[0]
        self.assertEqual(sent.user_id, "u1")  # caller identity, never empty
        self.assertEqual(sent.page_id, "p1")

    def test_create_share_link_foreign_page_returns_404(self):
        self.archive_stub.GetPage.side_effect = _FakeRpcError(grpc.StatusCode.NOT_FOUND)
        request = _fake_request(user_id="u1")
        with self.assertRaises(HTTPException) as cm:
            _run(share_routes.create_share_link(request, {"page_id": "foreign"}))
        self.assertEqual(cm.exception.status_code, 404)
        self.share_stub.CreateShareLink.assert_not_called()

    # -- Public viewer route uses the resolved owner (2.3) --

    def test_validate_share_link_passes_owner_user_id(self):
        """D4: the public route returns page-reference metadata only — no
        presigned `url`, and no GetPageContent round trip at all."""
        self.share_stub.ValidateToken.return_value = share_pb2.ValidateShareResponse(
            valid=True, page_id="p1", owner_user_id="owner-u1",
        )

        resp = _run(share_routes.validate_share_link("tok"))
        self.assertEqual(resp, {"page_id": "p1"})
        self.assertNotIn("url", resp)
        self.assertNotIn("signed_url", resp)
        self.archive_stub.GetPageContent.assert_not_called()

    def test_validate_share_link_response_carries_no_presigned_fields(self):
        self.share_stub.ValidateToken.return_value = share_pb2.ValidateShareResponse(
            valid=True, page_id="p1", owner_user_id="owner-u1",
        )
        # Even a stub response still carrying legacy fields must not leak them:
        # the gateway response shaping is what defines the REST contract.
        self.archive_stub.GetPageContent.return_value = archive_pb2.PageContentResponse(
            expires_at=123,
        )
        resp = _run(share_routes.validate_share_link("tok"))
        self.assertFalse({"url", "signed_url"} & resp.keys())

    def test_validate_share_link_invalid_token_404_without_archive_call(self):
        self.share_stub.ValidateToken.return_value = share_pb2.ValidateShareResponse(valid=False)
        with self.assertRaises(HTTPException) as cm:
            _run(share_routes.validate_share_link("bad"))
        self.assertEqual(cm.exception.status_code, 404)
        self.archive_stub.GetPageContent.assert_not_called()

    # -- Public file route uses the resolved owner (2.3) --

    def test_share_file_passes_owner_user_id(self):
        self.share_stub.ValidateToken.return_value = share_pb2.ValidateShareResponse(
            valid=True, page_id="p1", owner_user_id="owner-u1",
        )
        self.archive_stub.GetArchiveFile.return_value = archive_pb2.ArchiveFileResponse(
            data=b"<html>hi</html>", content_type="text/html; charset=utf-8",
        )

        resp = _run(share_routes.get_share_file("tok", "index.html"))
        self.assertEqual(resp.body, b"<html>hi</html>")
        self.assertEqual(resp.headers["x-content-type-options"], "nosniff")

        sent = self.archive_stub.GetArchiveFile.call_args.args[0]
        self.assertEqual(sent.user_id, "owner-u1")

    def test_share_file_retries_with_assets_prefix_for_owner(self):
        self.share_stub.ValidateToken.return_value = share_pb2.ValidateShareResponse(
            valid=True, page_id="p1", owner_user_id="owner-u1",
        )
        self.archive_stub.GetArchiveFile.side_effect = [
            _FakeRpcError(grpc.StatusCode.NOT_FOUND),
            archive_pb2.ArchiveFileResponse(data=b"png", content_type="image/png"),
        ]

        resp = _run(share_routes.get_share_file("tok", "logo.png"))
        self.assertEqual(resp.body, b"png")
        second = self.archive_stub.GetArchiveFile.call_args_list[1].args[0]
        self.assertEqual(second.file_path, "assets/logo.png")
        self.assertEqual(second.user_id, "owner-u1")


class TestGatewayCallDeadlines(unittest.TestCase):
    """D11 subset (this task group's routers): explicit timeouts everywhere."""

    def _archive_stub(self):
        stub = MagicMock()
        stub.ListPages.return_value = archive_pb2.ListPagesResponse(total=0)
        stub.GetPage.return_value = archive_pb2.PageResponse()
        stub.GetPageContent.return_value = archive_pb2.PageContentResponse()
        stub.DeletePage.return_value = common_pb2.StatusResponse(success=True)
        stub.GetArchiveFile.return_value = archive_pb2.ArchiveFileResponse(data=b"x")
        return stub

    def test_archive_metadata_calls_use_default_deadline(self):
        stub = self._archive_stub()
        with patch.object(archive_routes, "archive_stub", return_value=stub):
            _run(archive_routes.list_pages(_fake_request()))
            _run(archive_routes.get_page(_fake_request(), "p1"))
            _run(archive_routes.view_page(_fake_request(), "p1"))
            _run(archive_routes.delete_page(_fake_request(), "p1"))
            _run(archive_routes.get_page_file(_fake_request(), "p1", "index.html"))

        for call in (*stub.ListPages.call_args_list,
                     *stub.GetPage.call_args_list,
                     *stub.GetPageContent.call_args_list,
                     *stub.DeletePage.call_args_list,
                     *stub.GetArchiveFile.call_args_list):
            self.assertEqual(call.kwargs.get("timeout"), 30)

    def test_share_validate_token_has_deadline(self):
        stub = MagicMock()
        stub.ValidateToken.return_value = share_pb2.ValidateShareResponse(valid=False)
        with patch.object(share_routes, "share_stub", return_value=stub), \
                self.assertRaises(HTTPException):
            _run(share_routes.validate_share_link("tok"))
        self.assertEqual(stub.ValidateToken.call_args.kwargs.get("timeout"), 30)

    def test_share_file_validate_has_deadline(self):
        stub = MagicMock()
        stub.ValidateToken.return_value = share_pb2.ValidateShareResponse(valid=False)
        with patch.object(share_routes, "share_stub", return_value=stub), \
                self.assertRaises(HTTPException):
            _run(share_routes.get_share_file("tok", "index.html"))
        self.assertEqual(stub.ValidateToken.call_args.kwargs.get("timeout"), 30)


class TestViewPageResponseShaping(unittest.TestCase):
    """Task 1.16 / spec "View page (no presigned URL)"."""

    def test_view_page_response_has_no_presigned_fields(self):
        stub = MagicMock()
        stub.GetPageContent.return_value = archive_pb2.PageContentResponse(
            expires_at=1700000000,
        )
        with patch.object(archive_routes, "archive_stub", return_value=stub):
            resp = _run(archive_routes.view_page(_fake_request(), "p1"))
        self.assertFalse({"url", "signed_url"} & resp.keys(), resp)
        self.assertEqual(resp["page_id"], "p1")
        self.assertEqual(resp["expires_at"], 1700000000)
        # The route still resolves ownership downstream via the caller identity.
        sent = stub.GetPageContent.call_args.args[0]
        self.assertEqual(sent.user_id, "u1")
        self.assertEqual(sent.page_id, "p1")

    def test_view_page_zero_expiry_is_null(self):
        stub = MagicMock()
        stub.GetPageContent.return_value = archive_pb2.PageContentResponse()
        with patch.object(archive_routes, "archive_stub", return_value=stub):
            resp = _run(archive_routes.view_page(_fake_request(), "p1"))
        self.assertIsNone(resp["expires_at"])


class TestGetPageRoute(unittest.TestCase):
    """By-id metadata fetch (page-viewer spec / task 3.10): GET /pages/{id}
    dispatches to the ownership-enforced ArchiveService.GetPage — the viewer
    never scans a page-size-limited list."""

    def setUp(self):
        self.stub = MagicMock()
        p = patch.object(archive_routes, "archive_stub", return_value=self.stub)
        p.start()
        self.addCleanup(p.stop)

    def test_owned_page_returns_list_pages_item_shape(self):
        """The gateway shapes the proto PageResponse to the exact item shape
        list_pages emits (what PageResponseSchema validates)."""
        self.stub.GetPage.return_value = archive_pb2.PageResponse(
            id="p1", user_id="u1", url="https://example.com",
            title="Example", preview_text="preview", size_bytes=1234,
            extension_job_id="job-1", archived_at="2026-01-01T00:00:00",
        )
        resp = _run(archive_routes.get_page(_fake_request(user_id="u1"), "p1"))
        self.assertEqual(resp, {
            "id": "p1",
            "user_id": "u1",
            "url": "https://example.com",
            "title": "Example",
            "preview_text": "preview",
            "size_bytes": 1234,
            "archived_at": "2026-01-01T00:00:00",
        })
        # Caller identity, never empty; explicit deadline (D11).
        sent = self.stub.GetPage.call_args.args[0]
        self.assertEqual(sent.page_id, "p1")
        self.assertEqual(sent.user_id, "u1")
        self.assertEqual(self.stub.GetPage.call_args.kwargs.get("timeout"), 30)

    def test_cross_user_or_missing_page_returns_404(self):
        """GetPage returns NOT_FOUND for cross-user AND nonexistent ids —
        surfaced unchanged (no existence leak), api_version-stamped."""
        self.stub.GetPage.side_effect = _FakeRpcError(
            grpc.StatusCode.NOT_FOUND, "Page not found",
        )
        with self.assertRaises(HTTPException) as cm:
            _run(archive_routes.get_page(_fake_request(user_id="u1"), "foreign-p"))
        self.assertEqual(cm.exception.status_code, 404)
        self.assertEqual(cm.exception.detail.get("api_version"), "v1")

    def test_response_carries_no_presigned_fields(self):
        """D4 regression guard: metadata only — never any url-bearing blob
        beyond the page's own source url, and no signed_url field at all."""
        self.stub.GetPage.return_value = archive_pb2.PageResponse(id="p1", user_id="u1")
        resp = _run(archive_routes.get_page(_fake_request(), "p1"))
        self.assertNotIn("signed_url", resp)
        self.assertNotIn("r2_key", resp)


class TestArchiveRouteErrorTranslation(unittest.TestCase):
    """gRPC failures on the archive metadata routes map through the shared
    handler: a nonexistent/cross-user page is a 404 (never an unhandled 500)
    and an unreachable archive is a 503 + Retry-After (D1/D8). Wave-1's D4
    rewrite dropped these handlers; the integration gate caught the 500."""

    def _patched(self, stub):
        p = patch.object(archive_routes, "archive_stub", return_value=stub)
        p.start()
        self.addCleanup(p.stop)

    def test_view_page_not_found_is_404(self):
        stub = MagicMock()
        stub.GetPageContent.side_effect = _FakeRpcError(
            grpc.StatusCode.NOT_FOUND, "Page not found",
        )
        self._patched(stub)
        with self.assertRaises(HTTPException) as cm:
            _run(archive_routes.view_page(_fake_request(), "missing-p"))
        self.assertEqual(cm.exception.status_code, 404)
        self.assertEqual(cm.exception.detail.get("api_version"), "v1")

    def test_list_pages_unavailable_is_503(self):
        stub = MagicMock()
        stub.ListPages.side_effect = _FakeRpcError(
            grpc.StatusCode.UNAVAILABLE, "archive down",
        )
        self._patched(stub)
        with self.assertRaises(HTTPException) as cm:
            _run(archive_routes.list_pages(_fake_request()))
        self.assertEqual(cm.exception.status_code, 503)
        self.assertIn("Retry-After", cm.exception.headers or {})

    def test_delete_page_not_found_is_404(self):
        stub = MagicMock()
        stub.DeletePage.side_effect = _FakeRpcError(
            grpc.StatusCode.NOT_FOUND, "Page not found",
        )
        self._patched(stub)
        with self.assertRaises(HTTPException) as cm:
            _run(archive_routes.delete_page(_fake_request(), "missing-p"))
        self.assertEqual(cm.exception.status_code, 404)


class TestExtensionJobIdValidation(unittest.TestCase):
    """Task 1.6 / spec "Ingest Parameter Validation"."""

    def setUp(self):
        self.stub = MagicMock()
        self.stub.IngestPage.return_value = archive_pb2.IngestPageResponse(success=True, page_id="p1")
        p = patch.object(archive_routes, "archive_stub", return_value=self.stub)
        p.start()
        self.addCleanup(p.stop)

    def _ingest(self, extension_job_id):
        return _run(archive_routes.ingest_page(
            _fake_request(),
            url="https://example.com",
            title="T",
            html_content=_fake_upload(b"<html></html>"),
            extension_job_id=extension_job_id,
            plan="",
            assets=[],
        ))

    def test_oversized_job_id_rejected_without_upstream_call(self):
        with self.assertRaises(HTTPException) as cm:
            self._ingest("j" * 37)
        self.assertEqual(cm.exception.status_code, 400)
        self.stub.IngestPage.assert_not_called()

    def test_illegal_charset_rejected(self):
        for bad in ("job id", "job/id", "job;id", "jöb", "job#1"):
            with self.assertRaises(HTTPException) as cm:
                self._ingest(bad)
            self.assertEqual(cm.exception.status_code, 400, bad)
        self.stub.IngestPage.assert_not_called()

    def test_valid_job_id_shapes_pass_through(self):
        for ok in ("", "job-1", "a" * 36, "Job._-9"):
            self._ingest(ok)
        self.assertEqual(self.stub.IngestPage.call_count, 4)
        self.assertEqual(self.stub.IngestPage.call_args.args[0].extension_job_id, "Job._-9")

    def test_rejection_detail_carries_api_version(self):
        with self.assertRaises(HTTPException) as cm:
            self._ingest("j" * 37)
        self.assertEqual(cm.exception.detail.get("api_version"), "v1")


class TestMissingBodyFieldsReturn400(unittest.TestCase):
    """Task 1.14: unguarded `body[...]` indexing must never 500."""

    def setUp(self):
        self.stub = MagicMock()
        p = patch.object(auth_routes, "auth_stub", return_value=self.stub)
        p.start()
        self.addCleanup(p.stop)

    def test_register_without_email_returns_400(self):
        with self.assertRaises(HTTPException) as cm:
            _run(auth_routes.register({"password": "pw", "name": "n"}))
        self.assertEqual(cm.exception.status_code, 400)
        self.assertIn("email", cm.exception.detail["detail"])
        self.stub.Register.assert_not_called()

    def test_register_with_empty_body_returns_400(self):
        with self.assertRaises(HTTPException) as cm:
            _run(auth_routes.register({}))
        self.assertEqual(cm.exception.status_code, 400)

    def test_login_without_password_returns_400(self):
        with self.assertRaises(HTTPException) as cm:
            _run(auth_routes.login({"email": "a@b.c"}))
        self.assertEqual(cm.exception.status_code, 400)
        self.stub.Login.assert_not_called()

    def test_refresh_without_token_returns_400(self):
        with self.assertRaises(HTTPException) as cm:
            _run(auth_routes.refresh({}))
        self.assertEqual(cm.exception.status_code, 400)
        self.stub.Refresh.assert_not_called()

    def test_create_share_without_page_id_returns_400(self):
        with patch.object(share_routes, "share_stub", return_value=MagicMock()), \
                patch.object(share_routes, "archive_stub", return_value=MagicMock()), \
                self.assertRaises(HTTPException) as cm:
            _run(share_routes.create_share_link(_fake_request(), {"is_public": True}))
        self.assertEqual(cm.exception.status_code, 400)
        self.assertIn("page_id", cm.exception.detail["detail"])


class TestLogoutEndpoint(unittest.TestCase):
    """Task 1.13: the typed-Request handler reaches AuthService.Logout."""

    def setUp(self):
        self.stub = MagicMock()
        p = patch.object(auth_routes, "auth_stub", return_value=self.stub)
        p.start()
        self.addCleanup(p.stop)

    def test_logout_handler_reaches_the_rpc(self):
        request = _fake_request(user_id="u1")
        resp = _run(auth_routes.logout(request))
        self.assertEqual(resp, {"success": True})
        sent = self.stub.Logout.call_args.args[0]
        self.assertEqual(sent.user_id, "u1")
        self.assertEqual(self.stub.Logout.call_args.kwargs.get("timeout"), 30)

    def test_logout_with_no_session_is_401_via_middleware(self):
        """Regression: the endpoint must 401 (middleware) — never 422 from the
        old untyped `request` query-param binding."""
        main = _load_main_module()
        with patch.object(auth_routes, "auth_stub", return_value=self.stub):
            from fastapi.testclient import TestClient

            with TestClient(main.app) as client:
                r = client.post("/api/v1/auth/logout")
        self.assertEqual(r.status_code, 401)
        self.stub.Logout.assert_not_called()

    def test_logout_with_valid_session_reaches_rpc_and_returns_200(self):
        from jwt_utils import issue_access_token

        token, _ = issue_access_token("u1", "u1@example.com", "free")
        main = _load_main_module()
        with patch.object(auth_routes, "auth_stub", return_value=self.stub):
            from fastapi.testclient import TestClient

            with TestClient(main.app) as client:
                r = client.post("/api/v1/auth/logout", headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"success": True})
        self.assertEqual(self.stub.Logout.call_args.args[0].user_id, "u1")


def _load_main_module():
    """Load main.py by explicit path (same pattern as test_config_hygiene)."""
    import importlib.util
    import sys

    main_path = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "main.py"))
    spec = importlib.util.spec_from_file_location("api_gateway_main_routes", main_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["api_gateway_main_routes"] = module
    spec.loader.exec_module(module)
    return module


if __name__ == "__main__":
    unittest.main()
