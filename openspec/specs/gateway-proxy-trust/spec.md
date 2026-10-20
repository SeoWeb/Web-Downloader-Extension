# Gateway Proxy Trust Specification

## Purpose

Startup trust verification on the API gateway: which proxy IPs are trusted for client-IP forwarding, how drift between the derived container gateway and the configured `TRUSTED_PROXIES` is detected, alarmed, and exposed — always failing open.

## Requirements

### Requirement: Startup trusted-proxy drift alarm

At startup the API gateway SHALL derive the container's actual default-route gateway IP (parsing `/proc/net/route` for the interface owning the default route — container-side, no extra dependencies) and compare it against the configured `TRUSTED_PROXIES` list. When the derived gateway IP is NOT covered by the configuration, the gateway SHALL log a loud structured error — naming both the derived and configured values plus an explicit remediation hint (e.g. the `docker network inspect` gateway one-liner) — and SHALL continue booting: the drift alarm SHALL never crash or block startup, matching the rate limiter's fail-open philosophy. The current verdict SHALL be exposed in `GET /api/v1/health` as `"trusted_proxies": "ok" | "drift"` next to the `rate_limiter` state.

#### Scenario: Drift detected — loud warning, no crash

- **WHEN** the gateway starts and the derived default-route gateway IP (e.g. `172.19.0.1`) is matched by no `TRUSTED_PROXIES` entry (e.g. only `172.18.0.1` is configured — the 2026-10-16 incident shape)
- **THEN** an error-level structured log names the derived IP, the configured entries, and the remediation hint
- **AND** the gateway completes startup and serves traffic normally (warn, never crash)

#### Scenario: Covered configuration is silent and healthy

- **WHEN** the gateway starts and the derived gateway IP matches a configured `TRUSTED_PROXIES` entry
- **THEN** no alarm is logged and `GET /api/v1/health` reports `"trusted_proxies": "ok"`

#### Scenario: Health exposes the verdict

- **WHEN** `GET /api/v1/health` is called after startup
- **THEN** the response includes `"trusted_proxies": "ok" | "drift"` alongside the existing `rate_limiter` field

#### Scenario: Unknown topology fails open

- **WHEN** `/proc/net/route` is unreadable or contains no default route (e.g. non-container development)
- **THEN** the drift check is skipped silently, no alarm is raised, and startup proceeds
- **AND** the health verdict reports `"ok"` (alarm systems prefer no false alarm over blocking boot)
