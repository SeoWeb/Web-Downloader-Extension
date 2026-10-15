"""API Gateway route unit tests — no live stack required.

Covers the plan-authority regression (2.1), the share router's mandatory
ownership passthrough (2.3/2.4) and the per-call gRPC deadlines (D11 subset).
The gRPC stubs are mocked; request.state simulates what the auth middleware
populates from the verified JWT.
"""

import asyncio
import types
import unittest
from unittest.mock import MagicMock, patch

import archive_pb2
import grpc
import share_pb2
from fastapi import HTTPException
from routers import archive as archive_routes
from routers import share as share_routes


class _FakeRpcError(grpc.RpcError):
    def __init__(self, code, details="fake"):
        self._code = code
        self._details = details

    def code(self):
        return self._code

    def details(self):
        return self._details


def _fake_request(user_id="u1", plan="free"):
    """Stand-in for a Request after the auth middleware ran."""
    return types.SimpleNamespace(state=types.SimpleNamespace(user_id=user_id, plan=plan))


def _fake_upload(data: bytes, filename="index.html", content_type="text/html"):
    async def read():
        return data
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
        self.share_stub.ValidateToken.return_value = share_pb2.ValidateShareResponse(
            valid=True, page_id="p1", owner_user_id="owner-u1",
        )
        self.archive_stub.GetPageContent.return_value = (
            archive_pb2.PageContentResponse(
                signed_url="https://r2/signed", expires_at=123,
            )
        )

        resp = _run(share_routes.validate_share_link("tok"))
        self.assertEqual(resp["url"], "https://r2/signed")

        sent = self.archive_stub.GetPageContent.call_args.args[0]
        self.assertEqual(sent.user_id, "owner-u1")  # owner, not ""

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
        stub.GetPageContent.return_value = archive_pb2.PageContentResponse(signed_url="u")
        stub.DeletePage.return_value = archive_pb2.StatusResponse(success=True)
        stub.GetArchiveFile.return_value = archive_pb2.ArchiveFileResponse(data=b"x")
        return stub

    def test_archive_metadata_calls_use_default_deadline(self):
        stub = self._archive_stub()
        with patch.object(archive_routes, "archive_stub", return_value=stub):
            _run(archive_routes.list_pages(_fake_request()))
            _run(archive_routes.view_page(_fake_request(), "p1"))
            _run(archive_routes.delete_page(_fake_request(), "p1"))
            _run(archive_routes.get_page_file(_fake_request(), "p1", "index.html"))

        for call in (*stub.ListPages.call_args_list,
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


if __name__ == "__main__":
    unittest.main()
