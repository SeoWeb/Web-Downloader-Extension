"""Share service configuration: production fail-fast checks (7.6).

Mirrors ``services/api-gateway/config.py`` hygiene. Kept free of gRPC/service
imports so the checks are unit-testable in isolation.
"""

import os

ENVIRONMENT = "ENVIRONMENT"
BASE_URL = "BASE_URL"

# The development default baked into servicer.py — a share link pointing at
# localhost is always wrong in production, so it must never boot that way.
DEV_BASE_URL_DEFAULT = "http://localhost:8000"


class ConfigError(RuntimeError):
    """Raised when the configured environment is unsafe to boot."""


def get_environment() -> str:
    return os.environ.get(ENVIRONMENT, "development").strip().lower()


def is_production() -> bool:
    return get_environment() == "production"


def validate_prod_config(*, environment: str, base_url: str | None) -> None:
    """Refuse unsafe production configurations.

    Raises ConfigError when running with ENVIRONMENT=production while BASE_URL
    is unset or still the localhost development default — short URLs would be
    generated pointing at localhost. Non-production environments pass
    unvalidated (dev must keep working with compose defaults).
    """
    env = (environment or "").strip().lower()
    if env != "production":
        return

    if not base_url or not base_url.strip():
        raise ConfigError(
            "BASE_URL must be set when ENVIRONMENT=production — refusing to boot "
            "without a public base URL for share short links"
        )
    if base_url.strip().rstrip("/") == DEV_BASE_URL_DEFAULT:
        raise ConfigError(
            "BASE_URL is still the localhost development default; refusing to boot "
            "with ENVIRONMENT=production. Set the public site URL before deploying."
        )


def enforce_startup_config() -> None:
    """Validate the current process environment, failing fast (SystemExit)."""
    try:
        validate_prod_config(
            environment=os.environ.get(ENVIRONMENT, "development"),
            base_url=os.environ.get(BASE_URL),
        )
    except ConfigError as exc:
        raise SystemExit(f"share-service configuration error: {exc}") from exc
