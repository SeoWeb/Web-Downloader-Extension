"""Gateway configuration: env parsing and production fail-fast checks.

Kept free of FastAPI imports so the checks are unit-testable in isolation.
Also hosts the trusted-proxy drift alarm (D4): derive the actual default-route
gateway and warn (never crash) when TRUSTED_PROXIES does not cover it.
"""

import ipaddress
import logging
import os
import socket
import struct

logger = logging.getLogger(__name__)

ENVIRONMENT = "ENVIRONMENT"
JWT_SECRET = "JWT_SECRET"
GOOGLE_CLIENT_ID = "GOOGLE_CLIENT_ID"
GOOGLE_CLIENT_SECRET = "GOOGLE_CLIENT_SECRET"
ASSET_TOKEN_SECRET = "ASSET_TOKEN_SECRET"
ASSET_TOKEN_TTL_SECONDS = "ASSET_TOKEN_TTL_SECONDS"
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

# Fix E: signed asset tokens on the archive file route. The expiry is
# bucketed with this TTL (e = (floor(now / TTL) + 2) * TTL) so minted URLs
# are stable within a bucket and stay valid through the end of the NEXT
# bucket — cache-friendly, and the minting BFF must be configured with the
# same value or tokens die early / outlive their intended bucket.
DEFAULT_ASSET_TOKEN_TTL_SECONDS = 604800  # 7 days

# D4: remediation hint carried by the drift log line — the command that names
# the bridge's REAL gateway IP, so TRUSTED_PROXIES can be aligned with it.
TRUSTED_PROXY_DRIFT_HINT = (
    "docker network inspect pagepocket_default --format "
    "'{{(index .IPAM.Config 0).Gateway}}'"
)


class ConfigError(RuntimeError):
    """Raised when the configured environment is unsafe to boot."""


def get_environment() -> str:
    return os.environ.get(ENVIRONMENT, "development").strip().lower()


def is_production() -> bool:
    return get_environment() == "production"


def validate_prod_config(
    *,
    environment: str,
    jwt_secret: str | None,
    google_client_id: str | None = None,
    google_client_secret: str | None = None,
) -> None:
    """Refuse unsafe production configurations.

    Raises ConfigError when running with ENVIRONMENT=production while JWT_SECRET
    is unset or still the well-known development default, or while the Google
    OAuth client credentials (easier-auth D7 — AuthService exchanges the code
    server-side and the gateway's own fail-fast keeps the deploy honest even
    though the secret never passes through the gateway) are unset or blank.
    Non-production environments pass unvalidated (dev must keep working with
    compose defaults).
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

    for name, value in (
        (GOOGLE_CLIENT_ID, google_client_id),
        (GOOGLE_CLIENT_SECRET, google_client_secret),
    ):
        if not value or not value.strip():
            raise ConfigError(
                f"{name} must be set when ENVIRONMENT=production — refusing to boot "
                "without the Google sign-in credentials"
            )


def enforce_startup_config() -> None:
    """Validate the current process environment, failing fast (SystemExit)."""
    try:
        validate_prod_config(
            environment=os.environ.get(ENVIRONMENT, "development"),
            jwt_secret=os.environ.get(JWT_SECRET),
            google_client_id=os.environ.get(GOOGLE_CLIENT_ID),
            google_client_secret=os.environ.get(GOOGLE_CLIENT_SECRET),
        )
    except ConfigError as exc:
        raise SystemExit(f"api-gateway configuration error: {exc}") from exc


def asset_token_secret(raw: str | None = None) -> str:
    """Parse ASSET_TOKEN_SECRET — the HMAC key for archive file-route tokens.

    Empty by default, which DISABLES the feature: token-authenticated
    attempts fail closed (the middleware falls through to the normal 401)
    and the route behaves exactly as before. Deliberately independent of
    JWT_SECRET — separate rotation, separate blast radius.
    """
    source = os.environ.get(ASSET_TOKEN_SECRET) if raw is None else raw
    return (source or "").strip()


def asset_token_ttl_seconds(raw: str | None = None) -> int:
    """Parse ASSET_TOKEN_TTL_SECONDS (expiry bucket size). Default 604800.

    Non-integer or <1 values fall back to the default. Validation itself
    only uses the absolute expiry `e` inside the token payload — the TTL
    exists so the gateway documents/shares the bucketing the minting BFF
    applies when computing `e`.
    """
    source = os.environ.get(ASSET_TOKEN_TTL_SECONDS) if raw is None else raw
    if not source or not source.strip():
        return DEFAULT_ASSET_TOKEN_TTL_SECONDS
    try:
        value = int(source)
    except ValueError:
        return DEFAULT_ASSET_TOKEN_TTL_SECONDS
    return value if value >= 1 else DEFAULT_ASSET_TOKEN_TTL_SECONDS


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


def derive_default_gateway(route_table: str | None = None) -> str | None:
    """Derive the container's actual default-route gateway IP (D4).

    Parses a /proc/net/route table, finds the interface owning the default
    route (Destination column 00000000) and decodes its little-endian hex
    gateway column (e.g. 0100A8C0 -> 192.168.0.1). ``route_table`` is
    injectable so tests never touch the real file; by default /proc/net/route
    is read. Returns None when the table is unreadable, malformed, or has no
    usable default route — unknown topology means "skip the check", never an
    alarm.
    """
    if route_table is None:
        try:
            with open("/proc/net/route", encoding="ascii") as fh:
                route_table = fh.read()
        except OSError:
            return None

    for line in route_table.splitlines():
        # Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT
        columns = line.split()
        if len(columns) < 3 or columns[1] != "00000000":
            continue
        gateway_hex = columns[2]
        if gateway_hex == "00000000":  # default route without a gateway
            continue
        try:
            # Little-endian hex: 0100A8C0 -> bytes C0 A8 00 01 -> 192.168.0.1
            return socket.inet_ntoa(struct.pack("<I", int(gateway_hex, 16)))
        except (ValueError, struct.error):
            continue
    return None


def _addr_is_covered(addr: str, entries: tuple[str, ...]) -> bool:
    """Whether ``addr`` matches a TRUSTED_PROXIES entry (IP or containing CIDR).

    Same matching semantics as the limiter's ``_addr_is_trusted`` — the drift
    check must agree with what the limiter actually trusts. Unparseable
    entries cover nothing.
    """
    try:
        addr_ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    for entry in entries:
        try:
            if "/" in entry:
                if addr_ip in ipaddress.ip_network(entry, strict=False):
                    return True
            elif addr_ip == ipaddress.ip_address(entry):
                return True
        except ValueError:
            continue
    return False


def check_trusted_proxy_drift(route_table: str | None = None) -> str:
    """Compare the derived default-route gateway with TRUSTED_PROXIES (D4).

    Returns "ok" | "drift" and NEVER raises. On drift it logs one structured
    error line (derived IP, configured entries, remediation hint) and returns
    — the caller must keep booting: the alarm warns, it never blocks startup
    (same fail-open philosophy as the rate limiter). Unknown topology
    (unreadable route table, no default route) skips silently with "ok".
    """
    entries = trusted_proxies()
    derived = derive_default_gateway(route_table)
    if derived is None or _addr_is_covered(derived, entries):
        return "ok"

    logger.error(
        "TRUSTED_PROXIES drift: derived default-route gateway %s matches none of "
        "the configured entries %s — XFF is distrusted, so every client shares "
        "one rate-limit bucket. Remediation: %s (then set TRUSTED_PROXIES)",
        derived,
        list(entries) if entries else "(empty)",
        TRUSTED_PROXY_DRIFT_HINT,
    )
    return "drift"
