"""Storage-usage route tests (storage-usage-display 2.2).

GET /api/v1/archive/storage must be middleware-protected (401 before the
handler runs) and, authenticated, proxy ArchiveService.GetStorageUsage with
the JWT's user_id + plan and shape the payload for the web contract.
"""

import asyncio
import os
import sys
import types
import unittest
from unittest.mock import MagicMock, patch

import archive_pb2
from fastapi.testclient import TestClient
from routers import archive as archive_routes


def _run(coro):
    return asyncio.run(coro)


def _fake_request(user_id="u1", plan="free"):
    """Stand-in for a Request after the auth middleware ran."""
    return types.SimpleNamespace(state=types.SimpleNamespace(user_id=user_id, plan=plan))


def _load_main_module():
    """Load main.py by explicit path (same pattern as test_config_hygiene)."""
    import importlib.util

    main_path = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "main.py"))
    spec = importlib.util.spec_from_file_location("api_gateway_main_storage", main_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["api_gateway_main_storage"] = module
    spec.loader.exec_module(module)
    return module


def _stub_response(**overrides):
    fields = {
        "total_bytes": 268435456,          # 256 MB used
        "pages_this_month": 12,
        "quota_reset_at": "2026-11-01T00:00:00",
        "storage_limit_bytes": 10737418240,  # 10 GB (pro)
        "page_limit_monthly": 99999,
        "plan": "pro",
    }
    fields.update(overrides)
    return archive_pb2.GetStorageUsageResponse(**fields)


class TestStorageUsageMiddleware(unittest.TestCase):
    """Middleware-level: unauthenticated callers never reach the handler."""

    def setUp(self):
        self.stub = MagicMock()
        p = patch.object(archive_routes, "archive_stub", return_value=self.stub)
        p.start()
        self.addCleanup(p.stop)
        self.main = _load_main_module()

    def test_unauthenticated_returns_401_without_reaching_handler(self):
        r = TestClient(self.main.app).get("/api/v1/archive/storage")
        self.assertEqual(r.status_code, 401)
        self.stub.GetStorageUsage.assert_not_called()

    def test_authenticated_reaches_rpc_and_returns_payload(self):
        from jwt_utils import issue_access_token

        self.stub.GetStorageUsage.return_value = _stub_response()
        token, _ = issue_access_token("u-jwt", "u-jwt@example.com", "pro")

        with TestClient(self.main.app) as client:
            r = client.get(
                "/api/v1/archive/storage",
                headers={"Authorization": f"Bearer {token}"},
            )

        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {
            "used_bytes": 268435456,
            "storage_limit_bytes": 10737418240,
            "plan": "pro",
            "pages_this_month": 12,
            "page_limit_monthly": 99999,
            "quota_reset_at": "2026-11-01T00:00:00",
        })
        # D3: identity + plan come from the verified JWT, never the client.
        sent = self.stub.GetStorageUsage.call_args.args[0]
        self.assertEqual(sent.user_id, "u-jwt")
        self.assertEqual(sent.plan, "pro")
        self.assertEqual(self.stub.GetStorageUsage.call_args.kwargs.get("timeout"), 30)


class TestStorageUsageRouteShaping(unittest.TestCase):
    """Handler-level: the proto response is shaped to the REST contract."""

    def setUp(self):
        self.stub = MagicMock()
        p = patch.object(archive_routes, "archive_stub", return_value=self.stub)
        p.start()
        self.addCleanup(p.stop)

    def test_missing_quota_row_maps_empty_reset_at_to_null(self):
        """D2: a fresh user's zeros + no reset date — "" becomes null, and
        the limits still reflect the JWT plan."""
        self.stub.GetStorageUsage.return_value = _stub_response(
            total_bytes=0,
            pages_this_month=0,
            quota_reset_at="",
            storage_limit_bytes=524288000,  # 500 MB (free)
            page_limit_monthly=50,
            plan="free",
        )
        resp = _run(archive_routes.get_storage_usage(_fake_request(user_id="u2", plan="free")))
        self.assertEqual(resp, {
            "used_bytes": 0,
            "storage_limit_bytes": 524288000,
            "plan": "free",
            "pages_this_month": 0,
            "page_limit_monthly": 50,
            "quota_reset_at": None,
        })
        sent = self.stub.GetStorageUsage.call_args.args[0]
        self.assertEqual(sent.user_id, "u2")
        self.assertEqual(sent.plan, "free")


if __name__ == "__main__":
    unittest.main()
