"""Unit tests for the trusted-proxy drift alarm (D4 / tasks 4.1-4.4).

Covers the /proc/net/route parser (little-endian gateway hex, injectable
table), the drift verdict vs config.trusted_proxies(), and the fail-open
posture: drift logs ONE structured error and keeps booting; unknown topology
skips silently with verdict "ok". The route table is always injected — tests
never touch the real file.
"""

import os
import unittest
from unittest import mock

from config import (
    TRUSTED_PROXY_DRIFT_HINT,
    check_trusted_proxy_drift,
    derive_default_gateway,
)
from fastapi.testclient import TestClient
from routers.health import build_health_router


def _route_table(gateway_hex: str, iface: str = "eth0") -> str:
    """A realistic one-interface /proc/net/route with the given gateway hex."""
    header = "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT"
    return (
        f"{header}\n"
        f"{iface}\t00000000\t{gateway_hex}\t0003\t0\t0\t0\t00000000\t0\t0\t0"
    )


class _LimiterStub:
    """Stand-in for RedisRateLimiter: build_health_router only reads .healthy."""

    def __init__(self, healthy: bool = True):
        self.healthy = healthy


class TestDeriveDefaultGateway(unittest.TestCase):
    def test_decodes_little_endian_gateway_hex(self):
        # 0100A8C0 -> bytes C0 A8 00 01 -> 192.168.0.1 (design example).
        self.assertEqual(derive_default_gateway(_route_table("0100A8C0")), "192.168.0.1")

    def test_incident_gateway_derivation(self):
        # The 2026-10-16 incident shape: bridge gateway was 172.19.0.1.
        self.assertEqual(derive_default_gateway(_route_table("010013AC")), "172.19.0.1")

    def test_no_default_route_returns_none(self):
        table = (
            "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\n"
            "eth0\t0013AC00\t00000000\t0001\t0\t0\t0\t0013AC00\t0\t0\t0"
        )
        self.assertIsNone(derive_default_gateway(table))

    def test_gatewayless_default_route_is_not_usable(self):
        # A default route with gateway 00000000 names no gateway — skip it
        # (returning None, not a meaningless "0.0.0.0").
        self.assertIsNone(derive_default_gateway(_route_table("00000000")))

    def test_unparseable_table_returns_none(self):
        self.assertIsNone(derive_default_gateway("not a route table"))
        self.assertIsNone(derive_default_gateway(""))
        self.assertIsNone(derive_default_gateway("eth0 00000000 zzzz 0003"))


class TestTrustedProxyDriftCheck(unittest.TestCase):
    def test_covered_config_is_silent_and_ok(self):
        env = {"TRUSTED_PROXIES": "172.19.0.1,172.17.0.1"}
        with mock.patch.dict("os.environ", env), self.assertNoLogs("config", level="ERROR"):
            self.assertEqual(check_trusted_proxy_drift(_route_table("010013AC")), "ok")

    def test_cidr_entry_covers_derived_ip(self):
        # Same matching semantics as the limiter: a containing CIDR covers.
        env = {"TRUSTED_PROXIES": "172.16.0.0/12"}
        with mock.patch.dict("os.environ", env), self.assertNoLogs("config", level="ERROR"):
            self.assertEqual(check_trusted_proxy_drift(_route_table("010013AC")), "ok")

    def test_incident_drift_logs_one_structured_error_and_continues(self):
        # Derived 172.19.0.1 vs configured 172.18.0.1 — the real incident.
        env = {"TRUSTED_PROXIES": "172.18.0.1"}
        with mock.patch.dict("os.environ", env), self.assertLogs("config", level="ERROR") as captured:
            verdict = check_trusted_proxy_drift(_route_table("010013AC"))  # must not raise
        self.assertEqual(verdict, "drift")  # returns normally: startup proceeds
        self.assertEqual(len(captured.records), 1)  # ONE structured line
        message = captured.records[0].getMessage()
        self.assertIn("172.19.0.1", message)  # the derived IP
        self.assertIn("172.18.0.1", message)  # the configured entries
        self.assertIn("docker network inspect pagepocket_default", message)  # remediation
        self.assertIn("{{(index .IPAM.Config 0).Gateway}}", message)
        self.assertIn(TRUSTED_PROXY_DRIFT_HINT, message)

    def test_empty_trust_list_with_real_gateway_is_drift(self):
        # Covered means SOME configured entry matches; an empty list covers
        # nothing, so a real gateway with no TRUSTED_PROXIES is drift too.
        with mock.patch.dict("os.environ", {}, clear=True), self.assertLogs(
            "config", level="ERROR"
        ):
            self.assertEqual(check_trusted_proxy_drift(_route_table("010013AC")), "drift")

    def test_unparseable_route_table_skips_silently(self):
        with mock.patch.dict("os.environ", {"TRUSTED_PROXIES": "172.18.0.1"}), self.assertNoLogs(
            "config", level="ERROR"
        ):
            self.assertEqual(check_trusted_proxy_drift("not a route table"), "ok")

    def test_no_default_route_skips_silently(self):
        table = "Iface\tDestination\tGateway\tFlags\neth0\t0013AC00\t00000000\t0001"
        with mock.patch.dict("os.environ", {"TRUSTED_PROXIES": "172.18.0.1"}), self.assertNoLogs(
            "config", level="ERROR"
        ):
            self.assertEqual(check_trusted_proxy_drift(table), "ok")


class TestHealthVerdict(unittest.TestCase):
    def _get_health(self, verdict=None, limiter_healthy=True):
        from fastapi import FastAPI

        app = FastAPI()
        if verdict is None:
            app.include_router(build_health_router(_LimiterStub(limiter_healthy)))
        else:
            app.include_router(build_health_router(_LimiterStub(limiter_healthy), verdict))
        with TestClient(app) as client:
            return client.get("/api/v1/health").json()

    def test_response_keeps_existing_fields_and_defaults_to_ok(self):
        body = self._get_health()
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["api_version"], "v1")
        self.assertEqual(body["rate_limiter"], "ok")
        self.assertEqual(body["trusted_proxies"], "ok")

    def test_drift_verdict_is_threaded_through(self):
        body = self._get_health("drift", limiter_healthy=False)
        self.assertEqual(body["trusted_proxies"], "drift")
        self.assertEqual(body["rate_limiter"], "degraded")  # existing field intact


class TestMainWiring(unittest.TestCase):
    """main.py must run the check at startup and hand the verdict to /health."""

    def test_main_invokes_check_and_threads_verdict(self):
        with open(os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "main.py"))) as fh:
            source = fh.read()
        self.assertIn("check_trusted_proxy_drift", source)
        self.assertIn("trusted_proxy_verdict = check_trusted_proxy_drift()", source)
        self.assertIn("build_health_router(limiter, trusted_proxy_verdict)", source)


if __name__ == "__main__":
    unittest.main()
