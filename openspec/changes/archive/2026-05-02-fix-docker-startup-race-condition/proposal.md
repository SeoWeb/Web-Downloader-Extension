## Why

The app container crashes on first startup because it attempts database migrations before MySQL has fully initialized its network layer, even though the Docker healthcheck reports "healthy." This causes an immediate restart loop that wastes time and can leave the service unstable on slower machines or fresh volumes.

## What Changes

- Add a `start_period` to the MySQL healthcheck so Docker ignores early failures during initial boot.
- Increase healthcheck `retries` to give MySQL more time to fully initialize on cold starts.
- Add a shell wait-loop in the app service command that polls the database port before launching the server process.
- Add a restart delay to the app service to prevent rapid crash-retry hammering if the database is still unavailable.

## Capabilities

### New Capabilities

- `startup-resilience`: Ensures the application container waits for the database to be fully ready before starting, and recovers gracefully from transient connection failures during boot.

### Modified Capabilities

_(None — no spec-level behavior changes, only orchestration-level resilience.)_

## Impact

- `server/docker-compose.yml` — healthcheck tuning, app command change, restart policy
- No application code changes
- No API or dependency changes
- Databases created from a fresh volume will boot more reliably; existing deployments are unaffected
