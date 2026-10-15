"""Unit tests for the gRPC → HTTP error translation (tasks 4.2, 4.3).

Covers DEADLINE_EXCEEDED → 503 + Retry-After, size-induced RESOURCE_EXHAUSTED
→ 413, quota → 402 and rate → 429 staying distinct. The detail strings mirror
what gRPC emits for message-size failures and what the archive service's quota
checks emit (archive-service/quota.py).
"""

import unittest

import grpc
from fastapi import HTTPException
from routers import (
    DEADLINE_RETRY_AFTER_SECONDS,
    handle_grpc_error,
)


class _FakeRpcError(grpc.RpcError):
    """Mimics the shape of real grpc.RpcError (code()/details() accessors)."""

    def __init__(self, code, details):
        super().__init__(details)
        self._code = code
        self._details = details

    def code(self):
        return self._code

    def details(self):
        return self._details


def _rpc(code, details):
    return _FakeRpcError(code, details)


class TestDeadlineExceeded(unittest.TestCase):
    def test_deadline_exceeded_maps_to_503_with_retry_after(self):
        exc = _rpc(grpc.StatusCode.DEADLINE_EXCEEDED, "Deadline Exceeded")
        with self.assertRaises(HTTPException) as ctx:
            handle_grpc_error(exc)
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertIsNotNone(ctx.exception.headers)
        self.assertEqual(ctx.exception.headers.get("Retry-After"), str(DEADLINE_RETRY_AFTER_SECONDS))
        self.assertTrue(int(ctx.exception.headers["Retry-After"]) > 0)

    def test_hung_service_deadline_yields_503_not_500(self):
        # A hung stub eventually fails with DEADLINE_EXCEEDED at its timeout=;
        # the client must see 503 (retryable), never the generic 500.
        exc = _rpc(grpc.StatusCode.DEADLINE_EXCEEDED, "Deadline Exceeded")
        with self.assertRaises(HTTPException) as ctx:
            handle_grpc_error(exc)
        self.assertNotEqual(ctx.exception.status_code, 500)


class TestResourceExhausted(unittest.TestCase):
    def test_client_send_size_failure_maps_to_413(self):
        exc = _rpc(
            grpc.StatusCode.RESOURCE_EXHAUSTED,
            "Sent message larger than max (268435470 vs. 268435456)",
        )
        with self.assertRaises(HTTPException) as ctx:
            handle_grpc_error(exc)
        self.assertEqual(ctx.exception.status_code, 413)

    def test_server_receive_size_failure_maps_to_413(self):
        exc = _rpc(
            grpc.StatusCode.RESOURCE_EXHAUSTED,
            "Received message larger than max (104857600 vs. 268435456)",
        )
        with self.assertRaises(HTTPException) as ctx:
            handle_grpc_error(exc)
        self.assertEqual(ctx.exception.status_code, 413)

    def test_quota_page_limit_keeps_402(self):
        exc = _rpc(grpc.StatusCode.RESOURCE_EXHAUSTED, "Monthly page limit reached")
        with self.assertRaises(HTTPException) as ctx:
            handle_grpc_error(exc)
        self.assertEqual(ctx.exception.status_code, 402)

    def test_quota_storage_limit_keeps_402(self):
        exc = _rpc(grpc.StatusCode.RESOURCE_EXHAUSTED, "Storage limit reached")
        with self.assertRaises(HTTPException) as ctx:
            handle_grpc_error(exc)
        self.assertEqual(ctx.exception.status_code, 402)

    def test_rate_exhaustion_maps_to_429(self):
        exc = _rpc(grpc.StatusCode.RESOURCE_EXHAUSTED, "rate limit exceeded")
        with self.assertRaises(HTTPException) as ctx:
            handle_grpc_error(exc)
        self.assertEqual(ctx.exception.status_code, 429)

    def test_size_beats_quota_when_both_mentioned(self):
        # A size failure whose detail happens to contain other words must not
        # be mis-billed as a 402.
        exc = _rpc(
            grpc.StatusCode.RESOURCE_EXHAUSTED,
            "Received message larger than max (storage-friendly huge vs. small)",
        )
        with self.assertRaises(HTTPException) as ctx:
            handle_grpc_error(exc)
        self.assertEqual(ctx.exception.status_code, 413)

    def test_413_is_not_402_and_429_distinct(self):
        """The three RESOURCE_EXHAUSTED classes map to three distinct codes."""
        seen = set()
        for detail in (
            "Received message larger than max (5 vs. 4)",  # size
            "Monthly page limit reached",  # quota
            "rate limit exceeded",  # rate
        ):
            with self.assertRaises(HTTPException) as ctx:
                handle_grpc_error(_rpc(grpc.StatusCode.RESOURCE_EXHAUSTED, detail))
            seen.add(ctx.exception.status_code)
        self.assertEqual(seen, {413, 402, 429})


class TestStandardMapping(unittest.TestCase):
    def test_unauthenticated_maps_to_401(self):
        with self.assertRaises(HTTPException) as ctx:
            handle_grpc_error(_rpc(grpc.StatusCode.UNAUTHENTICATED, "invalid credentials"))
        self.assertEqual(ctx.exception.status_code, 401)

    def test_not_found_maps_to_404(self):
        with self.assertRaises(HTTPException) as ctx:
            handle_grpc_error(_rpc(grpc.StatusCode.NOT_FOUND, "Page not found"))
        self.assertEqual(ctx.exception.status_code, 404)

    def test_invalid_argument_maps_to_400(self):
        with self.assertRaises(HTTPException) as ctx:
            handle_grpc_error(_rpc(grpc.StatusCode.INVALID_ARGUMENT, "Invalid email"))
        self.assertEqual(ctx.exception.status_code, 400)

    def test_permission_denied_maps_to_403(self):
        with self.assertRaises(HTTPException) as ctx:
            handle_grpc_error(_rpc(grpc.StatusCode.PERMISSION_DENIED, "denied"))
        self.assertEqual(ctx.exception.status_code, 403)

    def test_already_exists_maps_to_409(self):
        with self.assertRaises(HTTPException) as ctx:
            handle_grpc_error(_rpc(grpc.StatusCode.ALREADY_EXISTS, "Email already registered"))
        self.assertEqual(ctx.exception.status_code, 409)

    def test_unknown_code_maps_to_500(self):
        with self.assertRaises(HTTPException) as ctx:
            handle_grpc_error(_rpc(grpc.StatusCode.INTERNAL, "boom"))
        self.assertEqual(ctx.exception.status_code, 500)

    def test_error_bodies_carry_api_version(self):
        with self.assertRaises(HTTPException) as ctx:
            handle_grpc_error(_rpc(grpc.StatusCode.NOT_FOUND, "nope"))
        self.assertEqual(ctx.exception.detail["api_version"], "v1")


if __name__ == "__main__":
    unittest.main()
