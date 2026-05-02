## Why

The server is exposed to automated bot probing, has no memory constraints in Docker, lacks proactive disk-space monitoring, and has no request-level security filtering beyond basic rate limiting. Users report "Internal Server Error" and apparent container restarts — symptoms consistent with resource exhaustion (OOM kills, disk-full, or connection pool saturation) rather than application bugs. These issues need hardening before the server can be reliably deployed in production.

## What Changes

- Add middleware to filter/short-circuit known bot scan patterns (e.g. `/owa/`, `/wp-admin/`, `.env` requests) before they reach application logic
- Configure Docker memory limits (`mem_limit`) and OOM kill protection in `docker-compose.yml` to prevent one runaway assembly from crashing the container
- Add disk-space checks to the cleanup service — proactively trigger aggressive cleanup when storage usage exceeds a configurable threshold
- Add a request-level security headers middleware (no `Server` header leak, basic hardening)
- Add connection pool monitoring/logging to detect pool exhaustion before it causes hangs

## Capabilities

### New Capabilities
- `server-request-filtering`: Middleware that short-circuits known bot/malicious request patterns and adds security response headers
- `server-resource-guards`: Docker memory limits, disk-space-aware cleanup triggers, and connection pool health monitoring

### Modified Capabilities
- `server-session-storage`: Add disk-usage-aware cleanup trigger when storage approaches capacity (in addition to existing time-based cleanup)

## Impact

- **Docker/Infrastructure**: `docker-compose.yml` changes — adds `mem_limit`, `memswap_limit` to the app service
- **Middleware**: New ASGI middleware added to the FastAPI app in `main.py` for request filtering and security headers
- **Cleanup Service**: `app/services/cleanup.py` gains disk-space threshold logic
- **Database**: `app/db/database.py` gains pool status logging/metrics
- **Config**: `app/config.py` gains settings for filtered paths, disk threshold, and memory limits
- **No API breaking changes** — all changes are additive (filtering returns 404/403 earlier, cleanup runs more aggressively under pressure)
