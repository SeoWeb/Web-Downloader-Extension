# Production Operations Runbook — PagePocket + extension monolith

Host: `185.213.25.5` (Contabo), checkout: `/var/www/Web-Downloader-Extension`
(branch `pagepocket` = production trunk). Everything below is runnable from
this repo — **prod is only ever mutated by running these scripts / the deploy
workflow, never ad-hoc.**

## 1. Routing contract (spike, 2026-10-15 — authoritative topology)

| Public name | Path | Backend |
|---|---|---|
| `server.pagepocket.app` | Cloudflare (proxied) → nginx :443 (`/etc/nginx/sites-enabled/server.pagepocket.app`) → `127.0.0.1:8000` | monolith (`server-app-1`) |
| `pagepocket.app` | Cloudflare → nginx :443 → `127.0.0.1:3000` | Next.js frontend (plain `next start`, **no pm2**) |
| `app.pagepocket.app` | falls through to the same frontend via nginx's implicit default-server block (works by accident — one explicit `server_name` block would make it intentional) | Next.js frontend |
| (none) | gateway `127.0.0.1:8090` — **no public hostname**; nginx does not front it today | pagepocket api-gateway |

Header provenance:
- `X-Forwarded-For` / `X-Forwarded-Proto` / `X-Real-IP` / `Host` are set by **nginx**.
- `CF-Connecting-IP` is set by the **Cloudflare edge** (real client IP — this is
  what the gateway rate limiter keys on).
- Reaching :8000/:8090 directly (not through the proxy) means **every
  forwarding header is client-supplied and spoofable** — that is the rationale
  for 5.11's loopback-only port bindings (below).

Ports that USED to be open to the internet (external probe, spike finding c):
`33060` (monolith MySQL, root credential committed!), `8000`, `8090`. After
the 5.11 compose changes all three are loopback-only/unpublished; the
first deploy that lands them closes the exposure.

Health endpoints (both **GET only** — the monolith returns 405 for HEAD):
- monolith `GET http://127.0.0.1:8000/api/v1/health` → `{"status":"ok","mysql":"ok",...}`
- gateway `GET http://127.0.0.1:8090/api/v1/health` → `{"status":"ok","api_version":"v1","rate_limiter":"ok"}`

## 2. Environment files the host must have BEFORE the first hardened deploy

`pagepocket/.env` (0600):

| Variable | Required? | Notes |
|---|---|---|
| `REDIS_PASSWORD` | **REQUIRED** — prod compose refuses to render without it (5.10) | generate: `openssl rand -hex 24`; or run `scripts/prod/roll-redis-password.sh` |
| `JWT_SECRET` | REQUIRED in practice | gateway refuses to boot in prod with unset/dev-default (4.6); already differs from the default per the spike |
| `MYSQL_ROOT_PASSWORD` | REQUIRED by 5.12 | rotated off the committed default by `scripts/prod/rotate-credentials.sh` |
| `CORS_ALLOW_ORIGINS` | optional | default `https://pagepocket.app,https://app.pagepocket.app`; append published `chrome-extension://` origins |
| `TRUSTED_PROXIES` | optional | default `172.16.0.0/12` (compose bridge gateway — nginx reaches the gateway through docker-proxy); tighten to the actual bridge IP after checking `docker network inspect pagepocket_default` |
| `MAX_UPLOAD_BYTES` | optional | default `268435456` (256 MB, matching the gRPC limit) |
| `R2_*`, `BASE_URL` | as before | unchanged |

`server/.env` (0600) — new interpolated keys (5.12):

| Variable | Required? | Notes |
|---|---|---|
| `MYSQL_ROOT_PASSWORD` | REQUIRED by 5.12 | legacy default `root_password` remains only as a dev fallback |
| `MYSQL_USER` / `MYSQL_PASSWORD` | REQUIRED by 5.12 | feed `MYSQL_CONNECTION_STRING` + the db container |

The monolith's MySQL credential is no longer only a committed literal:
`server/docker-compose.yml` interpolates `${MYSQL_*}` from `server/.env`.

## 3. First hardening deploy — ordered sequence

Each step is run/reviewed by the operator in order. Do NOT skip ahead: 5.13
and the compose changes interlock (prod compose requires `REDIS_PASSWORD`).

1. **Ship this change to `origin/pagepocket` and let CI go green.**
   `ci.yml` now runs on both branches (5.7), executes the 17 gateway
   integration tests against a real compose stack (5.1) and the monolith
   pytest suite (5.2). `deploy.yml` blocks on a green CI run for the exact
   SHA (5.8) — a red CI run now blocks deploys by construction.
2. **Pre-seed secrets** (one-time, on the host):
   `REDIS_PASSWORD` in `pagepocket/.env` — e.g.
   `printf 'REDIS_PASSWORD=%s\n' "$(openssl rand -hex 24)" >> pagepocket/.env && chmod 600 pagepocket/.env`.
   (Or skip this and let step 4 do it — but then the FIRST deploy's
   `up -d` recreates redis+services in one go; the coordinated script is the
   gentler path, so pre-seed first.)
3. **Deploy backend** (lands 5.11 loopback ports + :33060 removal + 5.10
   Redis auth + gateway healthcheck + AUTO_CREATE=false + the archive
   maintenance sidecar): `git push origin pagepocket` → `deploy.yml`
   `deploy-backend`. Order inside the job: build → infra up → **per-service
   `alembic upgrade head`** → recreate services → gateway recreate+restart →
   `GET /api/v1/health` poll (30×2s; the job FAILS on timeout).
   Spike finding (e): all five prod DBs are already at alembic head, so the
   first migration pass is a no-op — nothing to stamp.
   Verify the exposure closure: external probe of 33060/8000/8090 must now
   REFUSE connections.
4. **Rotate MySQL credentials**: `scripts/prod/rotate-credentials.sh --yes`
   (5.12 — monolith root + app user, pagepocket root; rewrites both env
   files 0600, recreates affected containers `--no-deps`, verifies both
   health endpoints). Run `--dry-run` first.
5. **Roll the Redis password** (if not pre-seeded in step 2, or to rotate):
   `scripts/prod/roll-redis-password.sh --yes` (5.13 — coordinated
   redis-first rolling restart; the limiter fails open during the seconds of
   the window, by design).
6. **Install the nightly backup cron** (5.4 — line below is NOT installed
   automatically; install it as the operator):
   ```
   15 3 * * * /var/www/Web-Downloader-Extension/scripts/prod/backup-mysql.sh >> /var/backups/mysql/cron.log 2>&1
   ```
   Freshness probe for alerting: `scripts/prod/backup-mysql.sh --check-fresh`
   (exit non-zero when the last successful backup is > 26 h old).
7. **Configure the off-host copy** (5.4/D7 — REQUIRED for the backup spec):
   `rclone config` a remote (R2 `s3:` type, B2, or `ssh:` to a second
   machine) and — recommended — a **`crypt` remote wrapping it**, so objects
   are encrypted client-side and the crypt keys live in the rclone config of
   wherever you run restores from (not in the DB). Then:
   `printf 'BACKUP_RCLONE_REMOTE=<crypt-remote:bucket/path>\n' >> /etc/environment`
   or export it in the cron line. Without it, backup-mysql.sh logs a loud
   WARNING and keeps local-only copies (which the spec does not accept
   long-term).
8. **Restore drill** (5.5): `scripts/prod/restore-drill.sh --db auth_db --yes`
   (default is a dry-run plan; `--yes` restores the newest backup into
   `auth_db_drill_<ts>`, compares exact row counts per table + alembic_version
   against the source, then drops the scratch DB). Record the run below.
9. **CI-gated deploys from here on.** Nothing deploys the monolith
   automatically (it ran untouched for ~4 months, spike finding f) — a
   monolith rebuild ships many accumulated commits at once and stays a
   deliberate, operator-driven act (see §7).

### Restore-drill log (spec: recorded evidence)

| Date | Backup used | DB | Result |
|---|---|---|---|
| _(pending — execute step 8 and record here)_ | | | |

## 4. Regular deploy flow (backend)

`git push origin pagepocket` → CI (same SHA) must be green → `deploy.yml`:

1. `git fetch origin && git reset --hard origin/pagepocket` on the host
2. `docker compose -f docker-compose.yml -f docker-compose.prod.yml build <services>`
3. `up -d --no-deps mysql redis` (idempotent)
4. per service: `docker compose run --rm --no-deps <svc> python -m alembic -c /app/alembic.ini upgrade head`
   — **Alembic is the single authoritative schema mechanism** (5.6);
   `AUTO_CREATE=false` in prod means implicit `create_all` can never shape prod.
5. recreate services + `archive-maintenance`
6. `up -d --no-deps api-gateway` + `restart api-gateway`
   (**gotcha:** stale gRPC channels to recreated services — the restart
   re-dials; do not skip it)
7. poll `GET http://127.0.0.1:8090/api/v1/health` 30×2s — non-200 fails the job

## 5. Archive maintenance sidecar (5.9)

Implemented as a compose service (`archive-maintenance`, reusing the
archive-service image) rather than host cron — it deploys with the stack,
survives reboots (`restart: always` in prod), and the host offers no
crontab automation path (spike: root crontab blocked behind sudo password,
no user crontab). It calls, over mTLS, on the internal network only:

- `RetryPendingIndexing(limit=100)` every 5 min — pages whose search index
  failed at ingest (durable pending rows from wave-1 3.8)
- `SweepOrphanR2Objects(grace=7d)` daily — R2 prefixes with no `pages` row
  older than 7 days (reconciliation net for wave-1 2.9)

Script: `scripts/prod/archive-maintenance/loop.py` (bind-mounted read-only).
Logs: `docker logs pagepocket-archive-maintenance-1`. Env knobs (compose):
`RETRY_INTERVAL_SECONDS`, `RETRY_LIMIT`, `SWEEP_INTERVAL_SECONDS`,
`SWEEP_GRACE_SECONDS`, `SWEEP_MAX_PREFIXES`.
mTLS identity: the **api-gateway client cert** (the only CA-signed client
identity on the host; archive-service verifies CA signatures, not CNs). A
dedicated maintenance cert can replace it at the next coordinated cert
rotation.

## 6. Certificates (spike finding b — read before touching certs)

- **Host PKI is authoritative.** Live certs (repo `pagepocket/certs/` is a
  STALE copy) expire **Jun 7 2036**; two different CAs exist between the
  repo set and the host set — never "sync" the repo set to prod.
- The only cert on a sub-year horizon on the host: `extension-client.pem`
  (May 2027) — legacy naming; the monolith actually mounts
  `extension-server-key.pem`/`extension-server.pem`.
- `make certs` (7.3-fixed) generates the canonical `extension-server-*`
  names **for local dev only**. Regenerated local certs must NEVER be copied
  to prod — that would break every service's mTLS identity at once. Real
  rotation (7.4, only if ever needed before 2036) happens ON the host, in a
  coordinated sequence: CA → service certs → api-gateway → monolith client
  cert, recreating the stack once.

## 7. Rollback notes

- **Backend services:** `git reset --hard <previous-commit>` on the host,
  then re-run the deploy sequence (build → alembic → up → gateway restart →
  health gate). Images are content-addressed by build; the previous commit
  rebuilds the previous behavior. If only the gateway is unhealthy:
  `docker compose ... up -d --no-deps --force-recreate api-gateway` after
  reverting the offending commit.
- **Alembic:** deploys only ever run `upgrade head`; a rollback that needs a
  downgrade must be deliberate (`alembic downgrade -1` per service) — never
  automatic.
- **Frontend:** each deploy keeps exactly one rollback copy:
  `rm -rf .next.bak-* && cp -al .next ".next.bak-$(date +%s)"`. Rollback =
  `rm -rf .next && mv .next.bak-<ts> .next` + restart (`nohup npm run start >
  next.log 2>&1 &`, or pm2 if it ever returns).
- **Redis password:** `pagepocket/.env.bak-<ts>` + re-run
  `roll-redis-password.sh --password "<old>"`.
- **MySQL credentials:** `server/.env.bak-<ts>` / `pagepocket/.env.bak-<ts>`
  + ALTER USER back + recreate (see the summary output of
  `rotate-credentials.sh`).

## 8. Ops actions requiring user confirmation (from the spike — checklist)

- [ ] Close 33060 / 8000 / 8090 to the internet (lands via 5.11 compose
      changes on the first deploy) **and** rotate the monolith MySQL root
      credential (5.12) — highest-priority pair
- [ ] Rotate pagepocket `MYSQL_ROOT_PASSWORD` off the committed default (5.12)
- [ ] Set a Redis password (5.10/5.13) — coordinated env change + restart
- [ ] Install the nightly backup cron (5.4) and pick the off-host target
      (R2 / B2 / remote ssh — see §3 step 7)
- [ ] Execute one restore drill into a scratch DB and record it in §3
- [ ] Cert expiry work is NOT needed (valid to 2036); the `make certs` rename
      (7.3) only affects local dev naming — no coordinated prod cert change
      required for this change
- [ ] First monolith redeploy (~4 months of accumulated commits) — schedule
      and smoke-test deliberately; nothing deploys it automatically
- [ ] Deploy-gate runs `git reset --hard origin/pagepocket` on the host —
      confirmed safe (tree clean apart from untracked `pagepocket/frontend/
      .next.bak-*` and `next.log`)

## 9. Script inventory (`scripts/prod/`)

| Script | Purpose |
|---|---|
| `backup-mysql.sh` | nightly per-DB `--single-transaction` dumps (5 pagepocket DBs + monolith) → `/var/backups/mysql`, log + freshness marker, 14-day pruning, optional rclone off-host copy |
| `restore-drill.sh` | restore a backup into `<db>_drill_<ts>`, verify row counts vs source, drop scratch (dry-run by default) |
| `rotate-credentials.sh` | generate + install MySQL credentials in host env files, ALTER USER in both containers, scoped recreates, health verification (dry-run by default) |
| `roll-redis-password.sh` | set `REDIS_PASSWORD`, coordinated redis-first rolling restart, AUTH + health verification (dry-run by default) |
| `archive-maintenance/loop.py` | the 5.9 sidecar loop (RetryPendingIndexing / SweepOrphanR2Objects over mTLS) |
