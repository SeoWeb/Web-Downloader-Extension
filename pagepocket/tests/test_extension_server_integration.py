"""Extension server integration test (task 14.8).

Simulates what the extension server does: push a page to ArchiveService.IngestPage
via gRPC, then verify it appears via GetPage.

Requires the archive-service to be reachable (default: localhost:50052).
Set ARCHIVE_SERVICE_ADDR to override.

Also set ARCHIVE_SERVICE_ADDR for the main extension server test if needed.
"""

import os
import sys
import time
import uuid
import unittest

# Add proto_generated to path
_proto_dir = os.path.normpath(os.path.join(
    os.path.dirname(__file__), "..", "shared", "proto_generated"
))
if _proto_dir not in sys.path:
    sys.path.insert(0, _proto_dir)

import grpc
import archive_pb2
import archive_pb2_grpc

ARCHIVE_ADDR = os.environ.get("ARCHIVE_SERVICE_ADDR", "localhost:50052")

_archive_available = False
try:
    _ch = grpc.insecure_channel(ARCHIVE_ADDR)
    grpc.channel_ready_future(_ch).result(timeout=3)
    _archive_available = True
except Exception:
    pass


@unittest.skipUnless(_archive_available, f"Archive service not reachable at {ARCHIVE_ADDR}")
class TestExtensionServerIntegration(unittest.TestCase):
    """Simulate extension server pushing to archive service."""

    @classmethod
    def setUpClass(cls):
        cls.channel = grpc.insecure_channel(ARCHIVE_ADDR)
        cls.stub = archive_pb2_grpc.ArchiveServiceStub(cls.channel)

    @classmethod
    def tearDownClass(cls):
        cls.channel.close()

    def test_ingest_and_get_page(self):
        """Finalize a session → push to IngestPage → verify via GetPage."""
        user_id = str(uuid.uuid4())
        session_id = str(uuid.uuid4())

        html = b"""<html><head><title>Test Page</title></head>
        <body><h1>Hello World</h1><p>This is a test page from extension server integration test.</p></body></html>"""

        # Push to archive (simulates extension server behavior)
        resp = self.stub.IngestPage(archive_pb2.IngestPageRequest(
            user_id=user_id,
            url="https://example.com/test-page",
            title="Test Page",
            html_content=html,
            assets=[],
            extension_job_id=session_id,
        ), timeout=30)

        self.assertTrue(resp.success, f"IngestPage failed: {resp.message}")
        page_id = resp.page_id
        self.assertTrue(page_id)

        # Verify via GetPage
        get_resp = self.stub.GetPage(archive_pb2.GetPageRequest(
            page_id=page_id,
            user_id=user_id,
        ), timeout=10)
        self.assertEqual(get_resp.id, page_id)
        self.assertEqual(get_resp.url, "https://example.com/test-page")
        self.assertEqual(get_resp.title, "Test Page")

    def test_ingest_idempotent(self):
        """Push twice with same extension_job_id → same page_id."""
        user_id = str(uuid.uuid4())
        job_id = str(uuid.uuid4())

        resp1 = self.stub.IngestPage(archive_pb2.IngestPageRequest(
            user_id=user_id,
            url="https://example.com/idempotent",
            title="Idempotent Test",
            html_content=b"<html><body>Test</body></html>",
            assets=[],
            extension_job_id=job_id,
        ), timeout=30)

        resp2 = self.stub.IngestPage(archive_pb2.IngestPageRequest(
            user_id=user_id,
            url="https://example.com/idempotent",
            title="Idempotent Test",
            html_content=b"<html><body>Test</body></html>",
            assets=[],
            extension_job_id=job_id,
        ), timeout=30)

        self.assertTrue(resp1.success)
        self.assertTrue(resp2.success)
        self.assertEqual(resp1.page_id, resp2.page_id)

        # Clean up
        self.stub.DeletePage(archive_pb2.DeletePageRequest(
            page_id=resp1.page_id, user_id=user_id,
        ), timeout=10)


if __name__ == "__main__":
    unittest.main()
