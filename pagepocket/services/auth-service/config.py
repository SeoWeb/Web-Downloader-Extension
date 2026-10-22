"""Auth service configuration: Google sign-in credentials + prod fail-fast.

Kept free of gRPC imports so the checks are unit-testable in isolation —
same pattern as the api-gateway's config module (easier-auth D7): the Google
OAuth client credentials are REQUIRED in production and optional (warn)
elsewhere, where GoogleAuth rejects sign-in attempts with the generic
unauthenticated error and password login is unaffected.
"""

import logging
import os

logger = logging.getLogger(__name__)

ENVIRONMENT = "ENVIRONMENT"
GOOGLE_CLIENT_ID = "GOOGLE_CLIENT_ID"
GOOGLE_CLIENT_SECRET = "GOOGLE_CLIENT_SECRET"


class ConfigError(RuntimeError):
    """Raised when the configured environment is unsafe to boot."""


def get_environment() -> str:
    return os.environ.get(ENVIRONMENT, "development").strip().lower()


def is_production() -> bool:
    return get_environment() == "production"


def validate_prod_config(
    *,
    environment: str,
    google_client_id: str | None,
    google_client_secret: str | None,
) -> None:
    """Refuse unsafe production configurations.

    Raises ConfigError when running with ENVIRONMENT=production while the
    Google OAuth client credentials are unset or blank — GoogleAuth could
    never succeed and the endpoint would be a dead 401 surface. Non-production
    environments pass unvalidated (dev keeps working without any Google
    credentials; GoogleAuth just rejects sign-ins and logs a warning).
    """
    env = (environment or "").strip().lower()
    if env != "production":
        return

    for name, value in (
        (GOOGLE_CLIENT_ID, google_client_id),
        (GOOGLE_CLIENT_SECRET, google_client_secret),
    ):
        if not value or not value.strip():
            raise ConfigError(
                f"{name} must be set when ENVIRONMENT=production — refusing to boot "
                "without the Google sign-in credentials"
            )


def google_credentials() -> tuple[str, str]:
    """Read the Google OAuth client credentials from the environment.

    Returns blank strings when unset — callers treat that as
    "Google sign-in not configured" and fail closed.
    """
    return (
        (os.environ.get(GOOGLE_CLIENT_ID) or "").strip(),
        (os.environ.get(GOOGLE_CLIENT_SECRET) or "").strip(),
    )


def warn_if_google_signin_disabled() -> None:
    """Dev-only convenience alarm: GoogleAuth is dead weight until configured."""
    if not is_production() and not all(google_credentials()):
        logger.warning(
            "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET not set — GoogleAuth rejects "
            "sign-in attempts until configured (password login is unaffected)"
        )


def enforce_startup_config() -> None:
    """Validate the current process environment, failing fast (SystemExit)."""
    try:
        validate_prod_config(
            environment=os.environ.get(ENVIRONMENT, "development"),
            google_client_id=os.environ.get(GOOGLE_CLIENT_ID),
            google_client_secret=os.environ.get(GOOGLE_CLIENT_SECRET),
        )
    except ConfigError as exc:
        raise SystemExit(f"auth-service configuration error: {exc}") from exc
