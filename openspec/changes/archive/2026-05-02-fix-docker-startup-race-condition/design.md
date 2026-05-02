## Context

The project runs a FastAPI (uvicorn) server alongside MySQL 8.0 in Docker Compose. On fresh starts — especially with an empty MySQL volume — the app container sometimes crashes because `depends_on: db: condition: service_healthy` is satisfied before MySQL has finished its internal user/permission setup. The current healthcheck (`mysqladmin ping`) confirms the process is alive but not that it's fully ready for client connections.

## Goals / Non-Goals

**Goals:**
- Eliminate the startup race condition without changing application code
- Make cold starts (empty volume) as reliable as warm restarts
- Keep the fix contained to `docker-compose.yml`

**Non-Goals:**
- Adding application-level connection retry logic (unnecessary for this problem)
- Changing the MySQL image or configuration
- Adding new services or sidecars

## Decisions

### 1. Add `start_period` and increase `retries` on db healthcheck
`start_period: 30s` tells Docker to treat the container as "starting" for 30 seconds, ignoring healthcheck failures during that window. Combined with `retries: 10`, this gives MySQL up to ~2 minutes total before Docker marks it unhealthy. This is safer than the current 5 retries with no start period.

**Alternative considered:** A custom healthcheck script that tests actual connectivity. Rejected — `mysqladmin ping` is sufficient; the problem is timing, not the check itself.

### 2. Shell wait-loop in app command
Replace the bare `uvicorn` CMD with `sh -c "while ! nc -z db 3306; do sleep 1; done; uvicorn ..."`. This is a defense-in-depth measure: even if the healthcheck passes early, the app won't attempt a connection until the port is actually open.

**Alternative considered:** Using `wait-for-it` or a Python-based wait script. Rejected — `nc -z` is available in the `python:3.11-slim` base image (via `netcat-openbsd`) and requires no extra dependencies. If `nc` is not available, the fallback is `sh -c "until python -c 'import socket; socket.create_connection((\"db\", 3306), timeout=1)'; do sleep 1; done; uvicorn ..."` which uses only the Python already in the image.

**Decision:** Use the Python-based wait to avoid depending on `nc` being present in the slim image, since `python:3.11-slim` does not include netcat by default.

### 3. Replace `restart: unless-stopped` with a delayed restart policy on app
Switch from the generic `restart: unless-stopped` to a `deploy.restart_policy` with `delay: 5s` and `max_attempts: 3`. This prevents the container from hammering the database on repeated failures. Note: `deploy.restart_policy` only works with `docker compose up`, not standalone `docker run`. Since this project uses Compose, that's acceptable.

## Risks / Trade-offs

- **No netcat in slim image** → Using Python socket check instead, which is guaranteed available.
- **`deploy.restart_policy` vs `restart`** → `deploy` policies are Compose-file only and may be ignored by `docker run`. Acceptable since this project is Compose-only.
- **Wait loop is not bounded** → The loop runs indefinitely until the port opens. If the database never starts, the app container hangs. Mitigated by the existing healthcheck retries on the db service — if db goes unhealthy, Compose will report the issue.
