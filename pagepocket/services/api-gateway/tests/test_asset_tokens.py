"""Fix E tests: signed asset tokens on the archive file route.

Layers covered:
- asset_tokens.verify_asset_token in isolation (shape, MAC, page binding,
  expiry, disabled feature) and strip_asset_token_segment.
- config parsing for ASSET_TOKEN_SECRET / ASSET_TOKEN_TTL_SECONDS.
- The real middleware + router wiring through main.py (TestClient, mocked
  archive gRPC stub): token-valid, expired, page mismatch, tampered MAC,
  no-credential 401 (unchanged), Bearer-wins, assets/ fallback with the
  token segment present, and the feature-disabled case.
"""

import asyncio
import base64
import hashlib
import hmac
import importlib.util
import json
import os
import sys
import time
import unittest
from unittest import mock

import archive_pb2
import grpc
from fastapi.testclient import TestClient

TEST_SECRET = "asset-token-test-secret"

TTL = 604800


def _mint(page_id="p1", user_id="u1", secret=TEST_SECRET, *, exp=None, now=None, ttl=TTL):
    """Mint a token in the EXACT wire format (mirrors the BFF contract)."""
    if exp is None:
        current = int(time.time()) if now is None else now
        exp = (current // ttl + 2) * ttl
    payload = json.dumps({"p": page_id, "u": user_id, "e": exp}, separators=(",", ":")).encode()
    payload_b64 = base64.urlsafe_b64encode(payload).rstrip(b"=").decode("ascii")
    mac = hmac.new(secret.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256).digest()
    mac_b64 = base64.urlsafe_b64encode(mac).rstrip(b"=").decode("ascii")
    return payload_b64 + "." + mac_b64


def _token_url(token, page_id="p1", rest="index.html"):
    return f"/api/v1/archive/pages/{page_id}/f/at/{token}/{rest}"


class _FakeRpcError(grpc.RpcError):
    def __init__(self, code, details="fake"):
        self._code = code
        self._details = details

    def code(self):
        return self._code

    def details(self):
        return self._details


class TestVerifyAssetToken(unittest.TestCase):
    """verify_asset_token in isolation (no HTTP, no middleware)."""

    def test_valid_token_returns_embedded_user(self):
        token = _mint(page_id="p1", user_id="u1")
        self.assertEqual(
            verify(token, "p1", now=1_700_000_000),
            "u1",
        )

    def test_empty_secret_disables_feature(self):
        token = _mint(secret=TEST_SECRET)
        self.assertIsNone(verify(token, "p1", secret=""))
        self.assertIsNone(verify(token, "p1", secret="   "))

    def test_wrong_secret_fails_mac(self):
        token = _mint(secret=TEST_SECRET)
        self.assertIsNone(verify(token, "p1", secret="another-secret"))

    def test_page_binding_enforced(self):
        token = _mint(page_id="p1")
        self.assertIsNone(verify(token, "p2"))

    def test_expired_token_rejected(self):
        token = _mint(exp=1_700_000_000)
        self.assertIsNone(verify(token, "p1", now=1_700_000_000))
        self.assertEqual(verify(token, "p1", now=1_699_999_999), "u1")

    def test_malformed_tokens_rejected(self):
        for bad in ("", "nodot", ".mac", "payload.", "..", "a.b.c"):
            self.assertIsNone(verify(bad, "p1"), bad)

    def test_undecodable_base64_rejected(self):
        # ":" and "*" are outside the b64url alphabet → decode must fail.
        self.assertIsNone(verify("a:a*a.a:a*a", "p1"))

    def test_non_json_payload_rejected(self):
        payload_b64 = base64.urlsafe_b64encode(b"\xff\xfe-not-json").rstrip(b"=").decode()
        mac = hmac.new(TEST_SECRET.encode(), payload_b64.encode(), hashlib.sha256).digest()
        mac_b64 = base64.urlsafe_b64encode(mac).rstrip(b"=").decode()
        self.assertIsNone(verify(payload_b64 + "." + mac_b64, "p1"))

    def test_non_dict_payload_rejected(self):
        payload_b64 = base64.urlsafe_b64encode(b'["p1","u1",1]').rstrip(b"=").decode()
        mac = hmac.new(TEST_SECRET.encode(), payload_b64.encode(), hashlib.sha256).digest()
        mac_b64 = base64.urlsafe_b64encode(mac).rstrip(b"=").decode()
        self.assertIsNone(verify(payload_b64 + "." + mac_b64, "p1"))

    def test_missing_or_empty_user_rejected(self):
        self.assertIsNone(verify(_mint(user_id=""), "p1"))
        # u absent entirely: hand-build the payload.
        payload = json.dumps({"p": "p1", "e": 2**31}, separators=(",", ":")).encode()
        payload_b64 = base64.urlsafe_b64encode(payload).rstrip(b"=").decode()
        mac = hmac.new(TEST_SECRET.encode(), payload_b64.encode(), hashlib.sha256).digest()
        self.assertIsNone(verify(payload_b64 + "." + base64.urlsafe_b64encode(mac).rstrip(b"=").decode(), "p1"))

    def test_non_integer_expiry_rejected(self):
        # Floats and bools are not epoch seconds — fail closed.
        for bad_exp in (1_700_000_000.0, True):
            payload = json.dumps({"p": "p1", "u": "u1", "e": bad_exp}, separators=(",", ":")).encode()
            payload_b64 = base64.urlsafe_b64encode(payload).rstrip(b"=").decode()
            mac = hmac.new(TEST_SECRET.encode(), payload_b64.encode(), hashlib.sha256).digest()
            token = payload_b64 + "." + base64.urlsafe_b64encode(mac).rstrip(b"=").decode()
            self.assertIsNone(verify(token, "p1", now=0), repr(bad_exp))

    def test_tampered_mac_rejected(self):
        token = _mint()
        flipped = "A" if token[-1] != "A" else "B"
        self.assertIsNone(verify(token[:-1] + flipped, "p1"))

    def test_tampered_payload_rejected_without_remac(self):
        token = _mint(user_id="u1")
        payload_b64, _, mac_b64 = token.partition(".")
        forged = base64.urlsafe_b64encode(
            json.dumps({"p": "p1", "u": "attacker", "e": 2**31}, separators=(",", ":")).encode()
        ).rstrip(b"=").decode()
        self.assertIsNone(verify(forged + "." + mac_b64, "p1"))


def verify(token, page_id, *, secret=TEST_SECRET, now=1_000):
    from asset_tokens import verify_asset_token

    return verify_asset_token(token, page_id=page_id, secret=secret, now=now)


class TestStripAssetTokenSegment(unittest.TestCase):
    def test_strips_leading_token_segment_once(self):
        from asset_tokens import strip_asset_token_segment

        self.assertEqual(strip_asset_token_segment("at/TOK.en/index.html"), "index.html")
        self.assertEqual(strip_asset_token_segment("at/TOK.en/assets/a/b.css"), "assets/a/b.css")
        # Only ONE segment is stripped.
        self.assertEqual(strip_asset_token_segment("at/A.b/at/C.d/x"), "at/C.d/x")

    def test_non_matching_paths_untouched(self):
        from asset_tokens import strip_asset_token_segment

        for path in (
            "index.html",
            "assets/style.css",
            "at/tok",  # no trailing segment
            "at/index.html",  # single segment, no second slash
            "at/nodot/file.css",  # token half lacks the dot
            "at/a.b.c/file.css",  # dots inside the token charset
            "assets/at/x.y/z",  # segment not leading
        ):
            self.assertEqual(strip_asset_token_segment(path), path, path)


class TestAssetTokenConfig(unittest.TestCase):
    def test_secret_defaults_to_empty_feature_disabled(self):
        from config import asset_token_secret

        self.assertEqual(asset_token_secret(None), "")
        self.assertEqual(asset_token_secret(""), "")
        self.assertEqual(asset_token_secret("  "), "")
        self.assertEqual(asset_token_secret(" s3cret "), "s3cret")

    def test_ttl_defaults_and_garbage_fall_back(self):
        from config import DEFAULT_ASSET_TOKEN_TTL_SECONDS, asset_token_ttl_seconds

        self.assertEqual(DEFAULT_ASSET_TOKEN_TTL_SECONDS, 604800)
        for raw in (None, "", "  ", "abc", "0", "-5"):
            self.assertEqual(asset_token_ttl_seconds(raw), 604800, raw)
        self.assertEqual(asset_token_ttl_seconds("3600"), 3600)
        self.assertEqual(asset_token_ttl_seconds(" 86400 "), 86400)


class TestExpiryBucketing(unittest.TestCase):
    """The shared bucketing contract: e = (floor(now/TTL) + 2) * TTL."""

    def test_tokens_deterministic_within_bucket_and_valid_through_next(self):
        ttl = 10
        a = _mint(now=123, ttl=ttl)
        b = _mint(now=129, ttl=ttl)  # same bucket (floor 12) → identical URL
        self.assertEqual(a, b)
        # e = (12 + 2) * 10 = 140: valid through second 139, gone at 140.
        self.assertEqual(verify(a, "p1", now=139), "u1")
        self.assertIsNone(verify(a, "p1", now=140))


class TestArchiveFileTokenFlow(unittest.TestCase):
    """Full-stack wiring: real main.py middleware + archive route, mocked gRPC."""

    @classmethod
    def setUpClass(cls):
        main_path = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "main.py"))
        spec = importlib.util.spec_from_file_location("api_gateway_main_asset_tokens", main_path)
        module = importlib.util.module_from_spec(spec)
        sys.modules["api_gateway_main_asset_tokens"] = module
        spec.loader.exec_module(module)
        cls.main = module

    def setUp(self):
        self.stub = mock.MagicMock()
        p = mock.patch.object(self.main.archive_router, "archive_stub", return_value=self.stub)
        p.start()
        self.addCleanup(p.stop)
        env = mock.patch.dict(os.environ, {"ASSET_TOKEN_SECRET": TEST_SECRET})
        env.start()
        self.addCleanup(env.stop)

    def _get(self, url, **kwargs):
        with TestClient(self.main.app) as client:
            return client.get(url, **kwargs)

    def _serve_ok(self, data=b"file-bytes", content_type="text/html"):
        self.stub.GetArchiveFile.return_value = archive_pb2.ArchiveFileResponse(
            data=data, content_type=content_type,
        )

    def test_valid_token_reaches_route_with_embedded_user(self):
        self._serve_ok()
        url = _token_url(_mint(page_id="p1", user_id="u1"))
        r = self._get(url)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.content, b"file-bytes")
        call = self.stub.GetArchiveFile.call_args.args[0]
        self.assertEqual(call.user_id, "u1")  # from the token, not a header
        self.assertEqual(call.page_id, "p1")
        self.assertEqual(call.file_path, "index.html")  # token segment stripped

    def test_expired_token_401(self):
        url = _token_url(_mint(exp=int(time.time()) - 100))
        r = self._get(url)
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json(), {"detail": "Invalid token", "api_version": "v1"})
        self.stub.GetArchiveFile.assert_not_called()

    def test_payload_page_mismatch_401(self):
        url = _token_url(_mint(page_id="other-page"))
        r = self._get(url)
        self.assertEqual(r.status_code, 401)
        self.stub.GetArchiveFile.assert_not_called()

    def test_tampered_mac_401(self):
        token = _mint()
        flipped = "A" if token[-1] != "A" else "B"
        r = self._get(_token_url(token[:-1] + flipped))
        self.assertEqual(r.status_code, 401)
        self.stub.GetArchiveFile.assert_not_called()

    def test_no_bearer_and_no_token_401_unchanged(self):
        # Plain file path without the token segment: today's behavior.
        r = self._get("/api/v1/archive/pages/p1/f/index.html")
        self.assertEqual(r.status_code, 401)
        self.stub.GetArchiveFile.assert_not_called()

    def test_non_bearer_authorization_header_401_despite_valid_token(self):
        # Any Authorization header present → the token branch never runs.
        url = _token_url(_mint())
        r = self._get(url, headers={"Authorization": "Basic dXNlcjpwYXNz"})
        self.assertEqual(r.status_code, 401)
        self.stub.GetArchiveFile.assert_not_called()

    def test_bearer_and_token_both_present_bearer_wins(self):
        from jwt_utils import issue_access_token

        self._serve_ok()
        bearer, _ = issue_access_token("jwt-user", "u@example.com", "free")
        # Token embeds a DIFFERENT user — the JWT claim must win.
        url = _token_url(_mint(user_id="tok-user"))
        r = self._get(url, headers={"Authorization": f"Bearer {bearer}"})
        self.assertEqual(r.status_code, 200)
        call = self.stub.GetArchiveFile.call_args.args[0]
        self.assertEqual(call.user_id, "jwt-user")

    def test_invalid_bearer_401_even_with_valid_token(self):
        from jwt_utils import issue_access_token

        url = _token_url(_mint())
        r = self._get(url, headers={"Authorization": "Bearer not-a-jwt"})
        self.assertEqual(r.status_code, 401)
        self.stub.GetArchiveFile.assert_not_called()

    def test_assets_fallback_still_works_with_token_segment(self):
        # Primary path misses → retry under assets/ with the REAL path
        # (never `assets/at/{token}/…`).
        self.stub.GetArchiveFile.side_effect = [
            _FakeRpcError(grpc.StatusCode.NOT_FOUND),
            archive_pb2.ArchiveFileResponse(data=b"x", content_type="text/html"),
        ]
        url = _token_url(_mint(), rest="index.html")
        r = self._get(url)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.content, b"x")
        self.assertEqual(self.stub.GetArchiveFile.call_count, 2)
        second = self.stub.GetArchiveFile.call_args_list[1].args[0]
        self.assertEqual(second.file_path, "assets/index.html")

    def test_feature_disabled_empty_secret_401(self):
        with mock.patch.dict(os.environ, {"ASSET_TOKEN_SECRET": ""}):
            url = _token_url(_mint())  # well-formed, correct secret
            r = self._get(url)
        self.assertEqual(r.status_code, 401)
        self.stub.GetArchiveFile.assert_not_called()

    def test_token_shape_route_outside_file_route_not_accepted(self):
        # The `at/{token}/` contract lives ONLY under /f/ — other routes
        # must never accept path credentials.
        self._serve_ok()
        url = f"/api/v1/archive/pages/p1/at/{_mint()}/index.html"
        r = self._get(url)
        self.assertEqual(r.status_code, 401)
        self.stub.GetArchiveFile.assert_not_called()


if __name__ == "__main__":
    unittest.main()
