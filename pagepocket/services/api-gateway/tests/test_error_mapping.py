"""Unit tests for the gRPC → HTTP error translation (tasks 4.2, 4.3, 1.7, 1.15).

Covers DEADLINE_EXCEEDED and UNAVAILABLE → 503 + Retry-After, size-induced
RESOURCE_EXHAUSTED → 413, quota → 402 and rate → 429 staying distinct — via
the structured `exhausted:<kind>` prefix (D9) and via the legacy prose
fallback. The detail strings mirror what gRPC emits for message-size failures
and what the archive service's quota checks emit (archive-service/quota.py).
"""

import unittest

import grpc
import quota_markers as shared_quota_markers
from fastapi import HTTPException
from routers import (
    DEADLINE_RETRY_AFTER_SECONDS,
    UNAVAILABLE_RETRY_AFTER_SECONDS,
    handle_grpc_error,
    parse_exhausted_kind,  # the shared-module function, re-exported by use
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


class TestUnavailable(unittest.TestCase):
    """Task 1.7 / spec "Transient Upstream Outage Semantics"."""

    def test_unavailable_maps_to_503_with_retry_after(self):
        exc = _rpc(grpc.StatusCode.UNAVAILABLE, "failed to connect to all addresses")
        with self.assertRaises(HTTPException) as ctx:
            handle_grpc_error(exc)
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertIsNotNone(ctx.exception.headers)
        self.assertEqual(ctx.exception.headers.get("Retry-After"), str(UNAVAILABLE_RETRY_AFTER_SECONDS))

    def test_unavailable_retry_after_is_positive(self):
        exc = _rpc(grpc.StatusCode.UNAVAILABLE, "io error")
        with self.assertRaises(HTTPException) as ctx:
            handle_grpc_error(exc)
        self.assertTrue(int(ctx.exception.headers["Retry-After"]) > 0)

    def test_search_service_down_yields_503_not_500(self):
        # Spec scenario "Search service down": an unreachable upstream is a
        # retryable 503, never a bare 500.
        exc = _rpc(grpc.StatusCode.UNAVAILABLE, "failed to connect to all addresses")
        with self.assertRaises(HTTPException) as ctx:
            handle_grpc_error(exc)
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertNotEqual(ctx.exception.status_code, 500)


class TestParseExhaustedKind(unittest.TestCase):
    """The shared marker parser (pagepocket/shared/quota_markers.py)."""

    def test_gateway_imports_the_shared_module(self):
        # Shared constants (spec "Shared constants"): the gateway must use the
        # one shared source, not duplicated literals.
        self.assertIs(parse_exhausted_kind, shared_quota_markers.parse_exhausted_kind)

    def test_prefix_parsed_to_kind(self):
        self.assertEqual(parse_exhausted_kind("exhausted:quota|Monthly page limit reached"), "quota")
        self.assertEqual(parse_exhausted_kind("exhausted:size|payload too large"), "size")
        self.assertEqual(parse_exhausted_kind("exhausted:rate|slow down"), "rate")

    def test_prefix_without_message(self):
        self.assertEqual(parse_exhausted_kind("exhausted:size"), "size")

    def test_no_prefix_returns_none(self):
        self.assertIsNone(parse_exhausted_kind("Storage limit reached"))
        self.assertIsNone(parse_exhausted_kind(""))
        self.assertIsNone(parse_exhausted_kind("exhaust:quota"))

    def test_unknown_kind_returns_none(self):
        self.assertIsNone(parse_exhausted_kind("exhausted:mystery|what"))


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


class TestStructuredExhaustedPrefix(unittest.TestCase):
    """Task 1.15 / spec "Structured Quota Error Mapping": the machine-readable
    `exhausted:<kind>` prefix decides the status on its own."""

    def test_structured_quota_prefix_maps_to_402(self):
        exc = _rpc(grpc.StatusCode.RESOURCE_EXHAUSTED, "exhausted:quota|Monthly page limit reached")
        with self.assertRaises(HTTPException) as ctx:
            handle_grpc_error(exc)
        self.assertEqual(ctx.exception.status_code, 402)

    def test_structured_size_prefix_maps_to_413(self):
        exc = _rpc(grpc.StatusCode.RESOURCE_EXHAUSTED, "exhausted:size|page exceeds storage cap")
        with self.assertRaises(HTTPException) as ctx:
            handle_grpc_error(exc)
        self.assertEqual(ctx.exception.status_code, 413)

    def test_structured_rate_prefix_maps_to_429(self):
        exc = _rpc(grpc.StatusCode.RESOURCE_EXHAUSTED, "exhausted:rate|too many requests")
        with self.assertRaises(HTTPException) as ctx:
            handle_grpc_error(exc)
        self.assertEqual(ctx.exception.status_code, 429)

    def test_prefix_wins_regardless_of_prose(self):
        # Spec "Structured prefix wins": decided by the prefix ALONE — the
        # human message must not be able to steer the mapping.
        exc = _rpc(grpc.StatusCode.RESOURCE_EXHAUSTED, "exhausted:size|quota and rate mentioned in prose")
        with self.assertRaises(HTTPException) as ctx:
            handle_grpc_error(exc)
        self.assertEqual(ctx.exception.status_code, 413)

    def test_legacy_fallback_still_maps(self):
        # Spec "Legacy fallback still works": prose-only details keep their
        # mapping (monolith compatibility).
        with self.assertRaises(HTTPException) as ctx:
            handle_grpc_error(_rpc(grpc.StatusCode.RESOURCE_EXHAUSTED, "Storage limit reached"))
        self.assertEqual(ctx.exception.status_code, 402)

    def test_legacy_fallback_logs_a_warning(self):
        with self.assertLogs("routers", level="WARNING") as logs, \
                self.assertRaises(HTTPException):
            handle_grpc_error(_rpc(grpc.StatusCode.RESOURCE_EXHAUSTED, "Monthly page limit reached"))
        self.assertTrue(any("legacy" in line.lower() for line in logs.output), logs.output)

    def test_structured_prefix_does_not_trigger_legacy_fallback_log(self):
        with self.assertNoLogs("routers", level="WARNING"), \
                self.assertRaises(HTTPException):
            handle_grpc_error(_rpc(grpc.StatusCode.RESOURCE_EXHAUSTED, "exhausted:quota|Monthly page limit reached"))


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
