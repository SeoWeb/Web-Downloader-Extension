## 1. Database Healthcheck Hardening

- [x] 1.1 Add `start_period: 30s` and increase `retries: 10` to the db service healthcheck in `docker-compose.yml`
- [x] 1.2 Verify the healthcheck still passes quickly on warm restarts with existing data

## 2. Application Startup Wait-Loop

- [x] 2.1 Replace the app service `command` (or add one overriding the Dockerfile CMD) with a Python-based wait loop that checks TCP connectivity to `db:3306` before launching uvicorn
- [x] 2.2 Confirm the wait loop exits immediately when the database is already ready (no unnecessary delay)

## 3. Restart Policy

- [x] 3.1 Replace `restart: unless-stopped` on the app service with a `deploy.restart_policy` block: `condition: on-failure`, `delay: 5s`, `max_attempts: 3`
- [x] 3.2 Keep `restart: unless-stopped` on the db service (no change needed)

## 4. Validation

- [x] 4.1 Destroy existing volumes and run `docker compose up` to verify a clean cold start with no crash loops
- [x] 4.2 Run `docker compose down && docker compose up` to verify warm restarts still work correctly
