"""Unit tests for gateway configuration hygiene (task 4.6).

Covers the production fail-fast (JWT_SECRET unset / dev default) and the CORS
origin allow-list parsing (never '*'). Also smoke-tests that main.py imports,
wires the env allow-list, and reports the rate-limiter health signal.
"""

import importlib.util
import os
import sys
import unittest
from unittest import mock

import fastapi.middleware.cors as cors_middleware
from config import (
    DEV_JWT_SECRET_DEFAULT,
    ConfigError,
    allowed_origins,
    enforce_startup_config,
    gateway_workers,
    trusted_proxies,
    validate_prod_config,
)
from fastapi.testclient import TestClient
from middleware.rate_limit import RateLimitMiddleware, RedisRateLimiter


class TestProdSecretFailFast(unittest.TestCase):
    def test_dev_default_secret_refused_in_production(self):
        with self.assertRaises(ConfigError):
            validate_prod_config(environment="production", jwt_secret=DEV_JWT_SECRET_DEFAULT)

    def test_missing_secret_refused_in_production(self):
        with self.assertRaises(ConfigError):
            validate_prod_config(environment="production", jwt_secret=None)
        with self.assertRaises(ConfigError):
            validate_prod_config(environment="production", jwt_secret="   ")

    def test_real_secret_accepted_in_production(self):
        validate_prod_config(environment="production", jwt_secret="a-real-long-random-secret")

    def test_environment_matching_is_case_and_space_tolerant(self):
        validate_prod_config(environment=" PRODUCTION ", jwt_secret="real-secret")
        validate_prod_config(environment="Development", jwt_secret=DEV_JWT_SECRET_DEFAULT)
        validate_prod_config(environment="", jwt_secret=None)

    def test_enforce_startup_config_raises_systemexit_on_bad_prod_env(self):
        env = {"ENVIRONMENT": "production", "JWT_SECRET": DEV_JWT_SECRET_DEFAULT}
        with mock.patch.dict("os.environ", env), self.assertRaises(SystemExit):
            enforce_startup_config()

    def test_enforce_startup_config_passes_in_development(self):
        env = {"ENVIRONMENT": "development", "JWT_SECRET": DEV_JWT_SECRET_DEFAULT}
        with mock.patch.dict("os.environ", env):
            enforce_startup_config()  # must not raise


class TestCorsAllowList(unittest.TestCase):
    def test_default_origins_are_pinned_production_hosts(self):
        self.assertEqual(
            allowed_origins(None),
            ["https://pagepocket.app", "https://app.pagepocket.app"],
        )

    def test_env_override_parses_comma_list(self):
        origins = allowed_origins("https://a.example, https://b.example")
        self.assertEqual(origins, ["https://a.example", "https://b.example"])

    def test_chrome_extension_origin_passes_through(self):
        self.assertEqual(
            allowed_origins("chrome-extension://abcdefabcdef"),
            ["chrome-extension://abcdefabcdef"],
        )

    def test_wildcard_is_dropped(self):
        self.assertEqual(allowed_origins("*, https://pagepocket.app"), ["https://pagepocket.app"])
        self.assertNotIn("*", allowed_origins("*"))

    def test_empty_value_falls_back_to_defaults(self):
        self.assertEqual(allowed_origins(""), allowed_origins(None))
        self.assertEqual(allowed_origins("  "), allowed_origins(None))

    def test_never_returns_wildcard_for_any_input(self):
        for raw in ("*", " * , * ", ""):
            self.assertNotIn("*", allowed_origins(raw))


class TestTrustedProxies(unittest.TestCase):
    def test_unset_means_empty(self):
        self.assertEqual(trusted_proxies(None), ())
        self.assertEqual(trusted_proxies(""), ())

    def test_parses_comma_separated_ips_and_cidrs(self):
        self.assertEqual(
            trusted_proxies("10.0.0.1, 172.16.0.0/12"),
            ("10.0.0.1", "172.16.0.0/12"),
        )


class TestGatewayWorkers(unittest.TestCase):
    """Task 1.4 / spec "Multi-Worker Serving": GATEWAY_WORKERS, default 2."""

    def test_default_is_two(self):
        self.assertEqual(gateway_workers(None), 2)
        self.assertEqual(gateway_workers(""), 2)
        self.assertEqual(gateway_workers("  "), 2)

    def test_env_override_honored(self):
        self.assertEqual(gateway_workers("4"), 4)
        self.assertEqual(gateway_workers("1"), 1)

    def test_garbage_and_invalid_values_fall_back_to_default(self):
        self.assertEqual(gateway_workers("abc"), 2)
        self.assertEqual(gateway_workers("0"), 2)
        self.assertEqual(gateway_workers("-3"), 2)

    def test_main_boots_with_the_configured_worker_count(self):
        # The __main__ block must forward gateway_workers() to uvicorn.
        with open(os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "main.py"))) as fh:
            source = fh.read()
        self.assertIn("gateway_workers", source)
        self.assertIn("workers=workers", source)
        self.assertIn('"main:app"', source)  # import-string form for spawn


class TestMainAppWiring(unittest.TestCase):
    """Smoke: main.py builds in dev mode with env-driven CORS + health signal."""

    @classmethod
    def setUpClass(cls):
        # Load main.py by explicit path under a unique module name: a bare
        # `import main` can resolve to another service's main.py when other
        # test suites prepend their directories to sys.path.
        main_path = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "main.py"))
        spec = importlib.util.spec_from_file_location("api_gateway_main", main_path)
        module = importlib.util.module_from_spec(spec)
        sys.modules["api_gateway_main"] = module
        spec.loader.exec_module(module)
        cls.main = module

    def test_cors_origins_come_from_allow_list_never_wildcard(self):
        cors = next(
            m for m in self.main.app.user_middleware if m.cls is cors_middleware.CORSMiddleware
        )
        origins = cors.kwargs["allow_origins"]
        self.assertIn("https://pagepocket.app", origins)
        self.assertNotIn("*", origins)

    def test_health_reports_rate_limiter_signal(self):
        with TestClient(self.main.app) as client:
            r = client.get("/api/v1/health")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["status"], "ok")
        self.assertIn(body["rate_limiter"], ("ok", "degraded"))

    def test_rate_limit_middleware_registered_with_redis_limiter(self):
        rl = next(
            m for m in self.main.app.user_middleware if m.cls is RateLimitMiddleware
        )
        self.assertIsInstance(rl.kwargs["limiter"], RedisRateLimiter)


if __name__ == "__main__":
    unittest.main()
