"""API Gateway integration tests — requires the full docker-compose stack running.

Tests hit http://localhost:8090 (api-gateway) and exercise every route
end-to-end through the gateway → gRPC services → MySQL pipeline.

Set PAGEPOCKET_GATEWAY_URL to override the base URL (default: http://localhost:8090).
Skips automatically if the gateway is unreachable.
"""

import os
import time
import unittest

import httpx

BASE_URL = os.environ.get("PAGEPOCKET_GATEWAY_URL", "http://localhost:8090")

_gateway_available = False
try:
    r = httpx.get(f"{BASE_URL}/api/v1/health", timeout=3)
    _gateway_available = r.status_code == 200
except Exception:
    pass

# Unique-ish email to avoid collisions across runs
_TS = int(time.time())
_TEST_EMAIL = f"inttest_{_TS}@test.com"
_TEST_PASSWORD = "testpassword123"
_TEST_NAME = "Integration Test"


@unittest.skipUnless(_gateway_available, f"Gateway not reachable at {BASE_URL}")
class TestGatewayIntegration(unittest.TestCase):
    """Integration tests hitting each gateway route against the live stack."""

    @classmethod
    def setUpClass(cls):
        cls.client = httpx.Client(base_url=BASE_URL, timeout=10)
        cls.access_token = None
        cls.refresh_token = None
        cls.user_id = None

        # Register a test user
        r = cls.client.post("/api/v1/auth/register", json={
            "email": _TEST_EMAIL,
            "password": _TEST_PASSWORD,
            "name": _TEST_NAME,
        })
        if r.status_code == 409:
            # Already exists from a prior run; log in instead
            r = cls.client.post("/api/v1/auth/login", json={
                "email": _TEST_EMAIL,
                "password": _TEST_PASSWORD,
            })
        assert r.status_code in (200, 201), f"Register/login failed: {r.text}"
        data = r.json()
        cls.access_token = data["access_token"]
        cls.refresh_token = data["refresh_token"]
        cls.user_id = data["user"]["id"]

    @classmethod
    def tearDownClass(cls):
        cls.client.close()

    def _headers(self):
        return {"Authorization": f"Bearer {self.access_token}"}

    # -- Health --

    def test_health_no_auth(self):
        r = self.client.get("/api/v1/health")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["status"], "ok")

    # -- Auth routes --

    def test_login(self):
        r = self.client.post("/api/v1/auth/login", json={
            "email": _TEST_EMAIL,
            "password": _TEST_PASSWORD,
        })
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertTrue(data["access_token"])
        self.assertTrue(data["refresh_token"])

    def test_login_wrong_password(self):
        r = self.client.post("/api/v1/auth/login", json={
            "email": _TEST_EMAIL,
            "password": "wrongpassword",
        })
        self.assertEqual(r.status_code, 401)

    def test_refresh(self):
        r = self.client.post("/api/v1/auth/refresh", json={
            "refresh_token": self.__class__.refresh_token,
        })
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.__class__.access_token = data["access_token"]
        self.__class__.refresh_token = data["refresh_token"]

    def test_unauthorized_without_token(self):
        r = self.client.get("/api/v1/archive/pages")
        self.assertEqual(r.status_code, 401)

    # -- Archive routes --

    def test_list_pages(self):
        r = self.client.get("/api/v1/archive/pages", headers=self._headers())
        self.assertIn(r.status_code, (200, 402))
        if r.status_code == 200:
            data = r.json()
            self.assertIn("pages", data)
            self.assertIn("total", data)

    def test_delete_nonexistent_page(self):
        # Delete returns 200 regardless — success reflects whether a row was actually removed
        r = self.client.delete("/api/v1/archive/pages/nonexistent-id", headers=self._headers())
        self.assertEqual(r.status_code, 200)

    def test_view_nonexistent_page(self):
        r = self.client.get("/api/v1/archive/pages/nonexistent-id/view", headers=self._headers())
        self.assertEqual(r.status_code, 404)

    # -- Library routes --

    def test_create_and_list_collections(self):
        r = self.client.post("/api/v1/library/collections", json={
            "name": "Integration Test Collection",
        }, headers=self._headers())
        self.assertEqual(r.status_code, 200)
        coll = r.json()
        self.assertTrue(coll["id"])
        self.assertEqual(coll["name"], "Integration Test Collection")

        # List
        r = self.client.get("/api/v1/library/collections", headers=self._headers())
        self.assertEqual(r.status_code, 200)
        colls = r.json()["collections"]
        self.assertTrue(any(c["id"] == coll["id"] for c in colls))

        # Get
        r = self.client.get(f"/api/v1/library/collections/{coll['id']}", headers=self._headers())
        self.assertEqual(r.status_code, 200)

        # Update
        r = self.client.patch(f"/api/v1/library/collections/{coll['id']}", json={
            "name": "Updated Name",
        }, headers=self._headers())
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["name"], "Updated Name")

        # Delete
        r = self.client.delete(f"/api/v1/library/collections/{coll['id']}", headers=self._headers())
        self.assertEqual(r.status_code, 200)

    # -- Search route --

    def test_search_empty_query(self):
        r = self.client.get("/api/v1/search?q=", headers=self._headers())
        self.assertEqual(r.status_code, 400)

    # -- Share route --

    def test_share_public_nonexistent_token(self):
        r = self.client.get("/api/v1/share/public/nonexistent-token")
        self.assertEqual(r.status_code, 404)

    def test_share_file_proxy_nonexistent_token(self):
        """Share file proxy returns 404 for invalid tokens."""
        r = self.client.get("/api/v1/share/public/nonexistent-token/f/index.html")
        self.assertEqual(r.status_code, 404)

    def test_share_file_proxy_nonexistent_file(self):
        """Share file proxy returns 404 for valid token but missing file."""
        # First create a page to share
        import io
        html_file = ("index.html", io.BytesIO(b"<html><body>Share Test</body></html>"), "text/html")
        r = self.client.post(
            "/api/v1/archive/pages/ingest",
            headers=self._headers(),
            data={"url": "https://example.com/share-test"},
            files=[("html_content", html_file)],
        )
        if r.status_code != 200:
            return  # Skip if ingest fails (quota etc.)
        page_id = r.json()["page_id"]

        # Create share link
        r = self.client.post(
            "/api/v1/share",
            json={"page_id": page_id, "is_public": True},
            headers=self._headers(),
        )
        self.assertEqual(r.status_code, 200)
        token = r.json()["token"]

        # Request a file that doesn't exist
        r = self.client.get(f"/api/v1/share/public/{token}/f/nonexistent-asset.png")
        self.assertEqual(r.status_code, 404)

    def test_share_requires_auth(self):
        r = self.client.post("/api/v1/share", json={"page_id": "fake"})
        self.assertEqual(r.status_code, 401)

    # -- Ingest route --

    def test_ingest_page_with_assets(self):
        import io

        html_file = ("index.html", io.BytesIO(b"<html><head><title>Test Page</title></head><body>Hello</body></html>"), "text/html")
        css_file = ("style.css", io.BytesIO(b"body { color: red; }"), "text/css")

        r = self.client.post(
            "/api/v1/archive/pages/ingest",
            headers=self._headers(),
            data={
                "url": "https://example.com/test",
                "title": "Test Page",
                "extension_job_id": "int-test-123",
            },
            files=[
                ("html_content", html_file),
                ("assets", css_file),
            ],
        )
        self.assertIn(r.status_code, (200, 402))
        if r.status_code == 200:
            data = r.json()
            self.assertTrue(data["success"])
            self.assertTrue(data["page_id"])
            self.assertEqual(data["api_version"], "v1")

    def test_ingest_page_without_assets(self):
        import io

        html_file = ("index.html", io.BytesIO(b"<html><body>Minimal</body></html>"), "text/html")

        r = self.client.post(
            "/api/v1/archive/pages/ingest",
            headers=self._headers(),
            data={"url": "https://example.com/minimal"},
            files=[("html_content", html_file)],
        )
        self.assertIn(r.status_code, (200, 402))
        if r.status_code == 200:
            data = r.json()
            self.assertTrue(data["success"])
            self.assertTrue(data["page_id"])
            self.assertEqual(data["api_version"], "v1")

    def test_ingest_page_requires_auth(self):
        import io

        html_file = ("index.html", io.BytesIO(b"<html></html>"), "text/html")
        r = self.client.post(
            "/api/v1/archive/pages/ingest",
            data={"url": "https://example.com"},
            files=[("html_content", html_file)],
        )
        self.assertEqual(r.status_code, 401)


if __name__ == "__main__":
    unittest.main()
