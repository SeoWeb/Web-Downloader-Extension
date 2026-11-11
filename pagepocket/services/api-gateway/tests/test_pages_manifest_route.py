"""Multipage downloads (tasks 8.1 + share parity, D7): the page-detail
route passes the per-page document manifest through from GetPage, and the
public share validation carries it alongside content_formats.

Covers the pagepocket-api-gateway spec scenario "Detail response includes
pages list": entries arrive with path/title/url/content_format verbatim
(no gateway-side synthesis), a legacy page yields an empty list (tolerant
absence), and the share validation's best-effort degradation (archive
failure → empty values, never an error) holds for the manifest too.
"""

import asyncio
import types
import unittest
from unittest.mock import MagicMock, patch

import archive_pb2
import grpc
import share_pb2
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


def _request(user_id="u1"):
    return types.SimpleNamespace(
        state=types.SimpleNamespace(user_id=user_id, plan="free"),
        headers={},
    )


_PAGES = [
    archive_pb2.PageSummary(
        path="about.md",
        title="About",
        url="https://example.com/about",
        content_format="markdown",
    ),
    archive_pb2.PageSummary(
        path="docs/notes.txt",
        title="Notes",
        url="https://example.com/docs/notes",
        content_format="text",
    ),
]


class TestPageDetailPagesManifest(unittest.TestCase):
    """`GET /pages/{id}` passes the pages manifest through (8.1/D7)."""

    def _get_page(self, stub):
        with patch.object(archive_routes, "archive_stub", return_value=stub):
            return asyncio.run(archive_routes.get_page(_request(), "p1"))

    def test_detail_carries_pages_manifest(self):
        stub = MagicMock()
        stub.GetPage.return_value = archive_pb2.PageResponse(
            id="p1", user_id="u1", url="https://example.com", title="T",
            content_formats=["html", "markdown"],
            pages=_PAGES,
        )
        resp = self._get_page(stub)
        self.assertEqual(resp["pages"], [
            {
                "path": "about.md",
                "title": "About",
                "url": "https://example.com/about",
                "content_format": "markdown",
            },
            {
                "path": "docs/notes.txt",
                "title": "Notes",
                "url": "https://example.com/docs/notes",
                "content_format": "text",
            },
        ])
        # Existing fields untouched alongside the new one.
        self.assertEqual(resp["content_formats"], ["html", "markdown"])

    def test_detail_legacy_page_has_empty_pages(self):
        """A legacy page (no manifest) yields an empty list — the tolerant
        absence the frontend schema degrades on."""
        stub = MagicMock()
        stub.GetPage.return_value = archive_pb2.PageResponse(id="p1", user_id="u1")
        resp = self._get_page(stub)
        self.assertEqual(resp["pages"], [])

    def test_detail_passes_entries_through_verbatim(self):
        """No gateway-side synthesis: empty title/url/format strings stored
        upstream surface exactly as stored (the viewer owns fallbacks)."""
        stub = MagicMock()
        stub.GetPage.return_value = archive_pb2.PageResponse(
            id="p1", user_id="u1",
            pages=[archive_pb2.PageSummary(path="hash-fallback.txt")],
        )
        resp = self._get_page(stub)
        self.assertEqual(resp["pages"], [{
            "path": "hash-fallback.txt", "title": "", "url": "",
            "content_format": "",
        }])


class TestShareValidationPagesManifest(unittest.TestCase):
    """Public share validation carries pages alongside content_formats
    (share-viewer parity), with the same best-effort degradation."""

    def setUp(self):
        self.share_stub = MagicMock()
        self.archive_stub = MagicMock()
        p1 = patch.object(share_routes, "share_stub", return_value=self.share_stub)
        p2 = patch.object(share_routes, "archive_stub", return_value=self.archive_stub)
        p1.start()
        p2.start()
        self.addCleanup(p1.stop)
        self.addCleanup(p2.stop)
        self.share_stub.ValidateToken.return_value = share_pb2.ValidateShareResponse(
            valid=True, page_id="p1", owner_user_id="owner-u1",
        )

    def _validate(self):
        return asyncio.run(share_routes.validate_share_link("tok"))

    def test_validation_carries_formats_and_pages(self):
        self.archive_stub.GetPage.return_value = archive_pb2.PageResponse(
            id="p1", user_id="owner-u1",
            content_formats=["html", "markdown"],
            pages=_PAGES,
        )
        resp = self._validate()
        self.assertEqual(resp["content_formats"], ["html", "markdown"])
        self.assertEqual(
            [(p["path"], p["content_format"]) for p in resp["pages"]],
            [("about.md", "markdown"), ("docs/notes.txt", "text")],
        )
        # Owner-scoped upstream read (public route has no caller JWT).
        self.assertEqual(
            self.archive_stub.GetPage.call_args.args[0].user_id, "owner-u1",
        )

    def test_validation_legacy_page_empty_pages(self):
        self.archive_stub.GetPage.return_value = archive_pb2.PageResponse(
            id="p1", user_id="owner-u1", content_formats=["html"],
        )
        resp = self._validate()
        self.assertEqual(resp["pages"], [])

    def test_validation_degrades_to_empty_on_archive_failure(self):
        """An archive outage never fails the validation response — same
        degradation contract as content_formats."""
        self.archive_stub.GetPage.side_effect = _FakeRpcError(
            grpc.StatusCode.UNAVAILABLE, "archive down",
        )
        resp = self._validate()
        self.assertEqual(resp["content_formats"], [])
        self.assertEqual(resp["pages"], [])


if __name__ == "__main__":
    unittest.main()
