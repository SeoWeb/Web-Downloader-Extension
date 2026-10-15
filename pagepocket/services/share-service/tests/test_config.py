"""Share service config fail-fast tests (7.6) — BASE_URL required in production."""

import importlib.util
import os
import unittest
import unittest.mock

_SERVICE_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))

# Load under a private alias so combined multi-suite runs never clash on the
# generic module name "config" (only this service ships one outside the gateway).
_SPEC = importlib.util.spec_from_file_location(
    "_ppsvc_share_service_config", os.path.join(_SERVICE_DIR, "config.py")
)
config = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(config)


class TestValidateProdConfig(unittest.TestCase):
    def test_production_without_base_url_raises(self):
        with self.assertRaises(config.ConfigError):
            config.validate_prod_config(environment="production", base_url=None)

    def test_production_with_blank_base_url_raises(self):
        with self.assertRaises(config.ConfigError):
            config.validate_prod_config(environment="production", base_url="   ")

    def test_production_with_localhost_default_raises(self):
        with self.assertRaises(config.ConfigError):
            config.validate_prod_config(
                environment="production", base_url="http://localhost:8000"
            )

    def test_production_with_trailing_slash_localhost_default_raises(self):
        with self.assertRaises(config.ConfigError):
            config.validate_prod_config(
                environment="production", base_url="http://localhost:8000/"
            )

    def test_production_with_real_public_url_passes(self):
        config.validate_prod_config(
            environment="production", base_url="https://pagepocket.app"
        )

    def test_development_keeps_localhost_default(self):
        """Dev must keep working without BASE_URL (compose default applies)."""
        config.validate_prod_config(environment="development", base_url=None)
        config.validate_prod_config(environment="development", base_url="http://localhost:8000")

    def test_unknown_environment_passes_unvalidated(self):
        config.validate_prod_config(environment="staging", base_url=None)


class TestEnforceStartupConfig(unittest.TestCase):
    def test_production_without_base_url_exits(self):
        with unittest.mock.patch.dict(
            os.environ,
            {"ENVIRONMENT": "production", "BASE_URL": ""},
            clear=False,
        ):
            os.environ.pop("BASE_URL", None)
            with self.assertRaises(SystemExit):
                config.enforce_startup_config()

    def test_development_boots_without_base_url(self):
        env = {"ENVIRONMENT": "development"}
        with unittest.mock.patch.dict(os.environ, env, clear=False):
            os.environ.pop("BASE_URL", None)
            config.enforce_startup_config()  # must not raise


if __name__ == "__main__":
    unittest.main()
