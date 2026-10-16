"""Gateway configuration: env parsing and production fail-fast checks.

Kept free of FastAPI imports so the checks are unit-testable in isolation.
"""

import logging
import os

logger = logging.getLogger(__name__)

ENVIRONMENT = "ENVIRONMENT"
JWT_SECRET = "JWT_SECRET"
CORS_ALLOW_ORIGINS = "CORS_ALLOW_ORIGINS"
TRUSTED_PROXIES = "TRUSTED_PROXIES"
REDIS_URL = "REDIS_URL"
GATEWAY_WORKERS = "GATEWAY_WORKERS"

# uvicorn worker processes (D1). >1 is safe: rate limiting and session state
# are Redis-backed, not in-process memory.
DEFAULT_GATEWAY_WORKERS = 2

# The development default baked into docker-compose.yml — must never reach
# production.
DEV_JWT_SECRET_DEFAULT = "dev-secret-change-me"

# Pinned by default; chrome-extension:// origins of published extensions can
# be appended via CORS_ALLOW_ORIGINS (comma-separated).
DEFAULT_ALLOWED_ORIGINS = ("https://pagepocket.app", "https://app.pagepocket.app")


class ConfigError(RuntimeError):
    """Raised when the configured environment is unsafe to boot."""


def get_environment() -> str:
    return os.environ.get(ENVIRONMENT, "development").strip().lower()


def is_production() -> bool:
    return get_environment() == "production"


def validate_prod_config(*, environment: str, jwt_secret: str | None) -> None:
    """Refuse unsafe production configurations.

    Raises ConfigError when running with ENVIRONMENT=production while JWT_SECRET
    is unset or still the well-known development default. Non-production
    environments pass unvalidated (dev must keep working with compose defaults).
    """
    env = (environment or "").strip().lower()
    if env != "production":
        return

    if not jwt_secret or not jwt_secret.strip():
        raise ConfigError(
            "JWT_SECRET must be set when ENVIRONMENT=production — refusing to boot "
            "with a missing signing secret"
        )
    if jwt_secret.strip() == DEV_JWT_SECRET_DEFAULT:
        raise ConfigError(
            "JWT_SECRET is still the well-known development default; refusing to boot "
            "with ENVIRONMENT=production. Generate a real secret before deploying."
        )


def enforce_startup_config() -> None:
    """Validate the current process environment, failing fast (SystemExit)."""
    try:
        validate_prod_config(
            environment=os.environ.get(ENVIRONMENT, "development"),
            jwt_secret=os.environ.get(JWT_SECRET),
        )
    except ConfigError as exc:
        raise SystemExit(f"api-gateway configuration error: {exc}") from exc


def allowed_origins(raw: str | None = None) -> list[str]:
    """Parse the CORS origin allow-list. Never returns ['*'].

    Reads CORS_ALLOW_ORIGINS (comma-separated). A wildcard entry is dropped
    with a warning — the spec forbids reflecting any origin in any environment.
    """
    source = os.environ.get(CORS_ALLOW_ORIGINS) if raw is None else raw
    if source is None or not source.strip():
        return list(DEFAULT_ALLOWED_ORIGINS)

    origins: list[str] = []
    for entry in source.split(","):
        entry = entry.strip()
        if not entry:
            continue
        if entry == "*":
            logger.warning("CORS_ALLOW_ORIGINS contains '*' — dropping it (wildcard origins are not permitted)")
            continue
        origins.append(entry)

    return origins or list(DEFAULT_ALLOWED_ORIGINS)


def gateway_workers(raw: str | None = None) -> int:
    """Parse GATEWAY_WORKERS (uvicorn worker processes). Defaults to 2.

    Non-integer or <1 values fall back to the default; an operator can always
    pin a single worker with GATEWAY_WORKERS=1.
    """
    source = os.environ.get(GATEWAY_WORKERS) if raw is None else raw
    if not source or not source.strip():
        return DEFAULT_GATEWAY_WORKERS
    try:
        value = int(source)
    except ValueError:
        return DEFAULT_GATEWAY_WORKERS
    return value if value >= 1 else DEFAULT_GATEWAY_WORKERS


def trusted_proxies(raw: str | None = None) -> tuple[str, ...]:
    """Parse TRUSTED_PROXIES (comma-separated IPs or CIDRs).

    Empty by default: without an explicit trust list, X-Forwarded-For is never
    honored for rate-limit identity.
    """
    source = os.environ.get(TRUSTED_PROXIES) if raw is None else raw
    if not source:
        return ()
    entries = tuple(entry.strip() for entry in source.split(",") if entry.strip())
    return entries
