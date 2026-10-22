"""Task 1.12 + 1.14 tests, against the real main.py wiring.

- Middleware ordering: CORS must be the OUTERMOST layer (registered last), so
  401 auth rejections and 429 rate-limit rejections carry
  Access-Control-Allow-Origin and browsers can read them (incl. Retry-After).
- Malformed/missing JSON bodies produce 400 with an api_version-stamped body —
  never an unhandled 500 or the default 422.
"""

import importlib.util
import os
import sys
import unittest
from unittest import mock

import fastapi.middleware.cors as cors_middleware
from fastapi.testclient import TestClient
from middleware import AuthMiddleware
from middleware.rate_limit import RateLimitMiddleware

ORIGIN = "https://pagepocket.app"  # in DEFAULT_ALLOWED_ORIGINS


def _load_main():
    """Load main.py by explicit path (same pattern as test_config_hygiene)."""
    main_path = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "main.py"))
    spec = importlib.util.spec_from_file_location("api_gateway_main_middleware_order", main_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["api_gateway_main_middleware_order"] = module
    spec.loader.exec_module(module)
    return module


class TestMiddlewareOrdering(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.main = _load_main()

    def test_cors_is_registered_outermost(self):
        """add_middleware prepends, so CORS must be the LAST entry."""
        classes = [m.cls for m in self.main.app.user_middleware]
        self.assertIn(cors_middleware.CORSMiddleware, classes)
        self.assertIn(AuthMiddleware, classes)
        self.assertIn(RateLimitMiddleware, classes)
        # add_middleware prepends: user_middleware[0] is the OUTERMOST layer.
        # Order must be CORS, auth, rate limiting — the limiter needs
        # request.state.user_id, which only exists inside the auth layer.
        self.assertEqual(classes[0], cors_middleware.CORSMiddleware)
        self.assertLess(classes.index(AuthMiddleware), classes.index(RateLimitMiddleware))

    def test_401_response_carries_cors_headers(self):
        with TestClient(self.main.app) as client:
            r = client.get("/api/v1/archive/pages", headers={"Origin": ORIGIN})
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.headers.get("access-control-allow-origin"), ORIGIN)

    def test_get_page_by_id_unauthenticated_returns_401(self):
        """Task 3.10 route: no bearer token → the auth middleware 401s before
        the route (and any gRPC call) is ever reached."""
        with TestClient(self.main.app) as client:
            r = client.get("/api/v1/archive/pages/p1")
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json(), {"detail": "Invalid token", "api_version": "v1"})

    def test_429_response_carries_cors_headers(self):
        # Failing-open happens on Redis outage; here we force the limit to be
        # exceeded to see a real 429 through the full middleware stack.
        with mock.patch.object(self.main.limiter, "check", return_value=False), \
                TestClient(self.main.app) as client:
            r = client.get("/api/v1/auth/login", headers={"Origin": ORIGIN})
        self.assertEqual(r.status_code, 429)
        self.assertEqual(r.headers.get("access-control-allow-origin"), ORIGIN)
        self.assertIn("Retry-After", r.headers)

    def test_preflight_still_allowed(self):
        with TestClient(self.main.app) as client:
            r = client.options(
                "/api/v1/archive/pages",
                headers={
                    "Origin": ORIGIN,
                    "Access-Control-Request-Method": "GET",
                },
            )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers.get("access-control-allow-origin"), ORIGIN)


class TestMalformedBodyHandling(unittest.TestCase):
    """Task 1.14 / spec "Malformed Request Body Handling"."""

    @classmethod
    def setUpClass(cls):
        cls.main = _load_main()

    def _client(self):
        return TestClient(self.main.app, raise_server_exceptions=False)

    def test_malformed_json_returns_400_not_500(self):
        with self._client() as client:
            r = client.post(
                "/api/v1/auth/login",
                content=b"{not json",
                headers={"Content-Type": "application/json"},
            )
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json().get("api_version"), "v1")

    def test_missing_json_body_returns_400(self):
        with self._client() as client:
            r = client.post("/api/v1/auth/login")
        self.assertEqual(r.status_code, 400)

    def test_missing_required_field_returns_400_with_field_detail(self):
        with self._client() as client:
            r = client.post("/api/v1/auth/login", json={"email": "a@b.c"})
        self.assertEqual(r.status_code, 400)
        body = r.json()
        # FastAPI wraps HTTPException.detail → {"detail": {"detail": ..., "api_version": ...}}
        self.assertEqual(body["detail"].get("api_version"), "v1")
        self.assertIn("password", body["detail"].get("detail", ""))

    def test_share_missing_page_id_returns_400(self):
        with self._client() as client:
            # No valid token → the auth middleware would 401 first; use a
            # bearer token the middleware accepts (signed with the test secret).
            from jwt_utils import issue_access_token

            token, _ = issue_access_token("u1", "u1@example.com", "free")
            r = client.post(
                "/api/v1/share",
                json={"is_public": True},
                headers={"Authorization": f"Bearer {token}"},
            )
        self.assertEqual(r.status_code, 400)
        self.assertIn("page_id", r.json()["detail"].get("detail", ""))

    def test_400_responses_still_carry_cors_headers(self):
        with self._client() as client:
            r = client.post(
                "/api/v1/auth/login",
                content=b"{not json",
                headers={"Content-Type": "application/json", "Origin": ORIGIN},
            )
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.headers.get("access-control-allow-origin"), ORIGIN)


class TestPublicGoogleAuthRoute(unittest.TestCase):
    """easier-auth spec "Public Google auth route bypasses auth": a POST to
    /api/v1/auth/google without Authorization must NOT 401 in the auth
    middleware — it reaches the route (which 400s on the missing body
    fields, gRPC never called), unlike any protected sibling path."""

    @classmethod
    def setUpClass(cls):
        cls.main = _load_main()

    def test_google_route_reachable_without_authorization(self):
        with TestClient(self.main.app) as client:
            r = client.post("/api/v1/auth/google", json={})
        self.assertEqual(r.status_code, 400)  # route-level missing field — NOT 401
        self.assertIn("code", r.json()["detail"].get("detail", ""))

    def test_google_route_in_public_paths_set(self):
        from middleware import PUBLIC_PATHS

        self.assertIn("/api/v1/auth/google", PUBLIC_PATHS)

    def test_protected_sibling_still_requires_token(self):
        with TestClient(self.main.app) as client:
            r = client.post("/api/v1/auth/logout")
        self.assertEqual(r.status_code, 401)


if __name__ == "__main__":
    unittest.main()
