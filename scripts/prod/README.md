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
| `TRUSTED_PROXIES` | optional (NARROWED default in compose) | default `172.18.0.1,172.17.0.1` — only the docker bridge gateway IPs a host→`127.0.0.1:8090` connection can be source-NATed to (nginx AND the host-side Next.js server both traverse docker-proxy). Verify the actual value on the host (see §TRUSTED_PROXIES rollout) and set it here |
| `BASE_URL` | **REQUIRED** (share arming, 4.8) | prod overlay refuses to render without it; the share-service fail-fast now actually runs (`ENVIRONMENT=production` is armed). Expected: `https://pagepocket.app` — confirm the public short-link host before the deploy |
| `DB_PASSWORD_AUTH` / `DB_PASSWORD_ARCHIVE` / `DB_PASSWORD_LIBRARY` / `DB_PASSWORD_SEARCH` / `DB_PASSWORD_SHARE` | **REQUIRED** (D12/2.16) | prod overlay refuses to render without them; the scoped users `pagepocket_<svc>` are created/rotated by `scripts/prod/rotate-db-users.sh`, which generates + writes these. Run it BEFORE the first deploy carrying the overlay (the render fails fast otherwise) |
| `MAX_UPLOAD_BYTES` | optional | default `268435456` (256 MB, matching the gRPC limit) |
| `MAX_INGEST_ASSETS` | optional | default `200` — per-ingest asset-count cap (D2) |
| `GATEWAY_WORKERS` | optional | default `2` — uvicorn workers for the gateway (D1); Redis-backed limiter makes multi-worker safe |
| `R2_*` | as before | unchanged |

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
3b. **Rebuild the monolith** (user-ordered 2026-10-16 — IN scope for deploy
   day; the only consumer of the monolith today is the operator's own
   extension build, so no legacy-behavior contract applies): from
   `/var/www/Web-Downloader-Extension/server` with the pagepocket stack
   already up (step 3 created the `pagepocket-monolith` network):
   ```
   docker compose -f docker-compose.yml build app
   docker compose -f docker-compose.yml run --rm app alembic upgrade head
   docker compose -f docker-compose.yml up -d
   ```
   The new compose attaches the confinement network (`pagepocket-monolith`)
   and the mTLS env is compose-provided — no new server/.env keys needed.
   **Alembic on the legacy DB:** if `upgrade head` fails because tables
   predate alembic_version, inspect first (`alembic current`, table list),
   `alembic stamp head` ONLY if the schema matches current models, then
   re-run upgrade (no-op). Verify: `GET http://127.0.0.1:8000/api/v1/health`,
   `POST /api/v1/cloud/link` without a key → 401, and one binding round-trip
   from the operator's extension. This step SUBSUMES step 11's switch —
   step 11's reachability verification is still required.
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
8. **Rotate the per-service DB users + cut services over** (D12/2.16 — run
   BEFORE the first deploy carrying the prod overlay, whose render FAILS
   without `DB_PASSWORD_*` in pagepocket/.env):
   `scripts/prod/rotate-db-users.sh --dry-run` → `--yes`. It generates the
   `DB_PASSWORD_*` values into pagepocket/.env, creates the
   `pagepocket_<svc>` users scoped to their own schemas, recreates the
   services (scoped DB_URLs) and verifies gateway health. See
   §DB-user rotation. (Never executed by the repo — deploy-gated.)
9. **Arm the share-service prod config** (4.8): set `BASE_URL` in
   `pagepocket/.env` (e.g. `https://pagepocket.app`) — the prod overlay
   hard-requires it. After the deploy that carries the overlay, verify a
   created short link points at the public host (NOT `http://localhost:8090`):
   `docker compose -f docker-compose.yml -f docker-compose.prod.yml exec share-service printenv BASE_URL` + create a share link via the UI and open it.
10. **Restore drill** (5.5, fixed by D13/4.1): `scripts/prod/restore-drill.sh --db auth_db --yes`
   (default is a dry-run plan; `--yes` explicitly CREATEs the scratch DB —
   dumps carry no CREATE DATABASE/USE anymore — restores into it, compares
   exact row counts per table + alembic_version against the source, then
   runs the **canary**: a marker row inserted into
   `<scratch>.__restore_drill_canary` that is asserted to be ABSENT from
   the source DB (proof the restore targeted scratch only), and drops the
   scratch DB). Record the run INCLUDING the canary line below.
11. **Monolith network confinement — verification** (D12/2.17): if step 3b
   rebuilt the monolith on the new compose, the switch already happened —
   run §Monolith network confinement's reachability checks (archive/auth
   connect, search/library/share FAIL, monolith + frontend healthy) and
   record the output.
12. **CI-gated deploys from here on.** Nothing deploys the monolith
   automatically — after step 3b it runs current code; subsequent monolith
   rebuilds stay deliberate, operator-driven acts (see §10).

### Restore-drill log (spec: recorded evidence)

| Date | Backup used | DB | Result | Canary evidence |
|---|---|---|---|---|
| _(pending — execute step 10 and record here)_ | | | | |

## 4. Regular deploy flow (backend)

`git push origin pagepocket` → CI (same SHA) must be green → `deploy.yml`:

1. `git fetch origin` on the host, then **SHA pinning (D13/4.2)**: the job
   aborts unless `git rev-parse origin/pagepocket` equals the gated
   `DEPLOY_SHA` (a newer commit landing mid-queue is NOT shipped — re-run
   the deploy for the newer SHA), then `git reset --hard "$DEPLOY_SHA"`.
   The host tree is therefore always EXACTLY the commit CI gated.
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

Frontend deploys are CI-gated too (D13/4.3): `deploy-frontend` needs the
same always-on `ci-gate` job, so a frontend-only push can no longer ship
with red or missing CI.

## 5. TRUSTED_PROXIES rollout (D3/1.9 — deploy-gated, coordinate first)

The compose default (both files) narrowed from the whole RFC1918 bridge
(`172.16.0.0/12`) to the two usual docker bridge **gateway** addresses:
`172.18.0.1,172.17.0.1`. Rationale: nginx (host) and the Next.js server
(host, plain `next start`) both reach the gateway via `127.0.0.1:8090`, so
the gateway's immediate peer is always the docker-proxy's source-NAT
address — the bridge gateway IP — never the proxy itself and never any
container.

Apply + verify:

```bash
# 1. What is the REAL gateway address of the prod network?
docker network inspect pagepocket_default --format '{{(index .IPAM.Config 0).Gateway}}'
# 2. If it differs from the default, set it in pagepocket/.env (comma-sep):
#      TRUSTED_PROXIES=<gateway-ip>
#    then recreate the gateway:
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps --force-recreate api-gateway
# 3. Verify limiter bucketing: two requests with the SAME
#    X-Forwarded-For behind a trusted proxy must share a bucket; requests
#    arriving directly on :8090 (peer = bridge gateway, now untrusted-
#    -header-wise) must key on the peer, not a spoofable header.
```

**Rollout caution:** if the configured value does NOT include the real
bridge gateway, every request appears to come from an untrusted peer and
the client identity degenerates to the gateway IP — all clients share one
rate-limit bucket (over-throttling, fail-closed direction). If it is too
broad, in-network peers can spoof `X-Forwarded-For` again. Verify with a
couple of authenticated 401/429 probes immediately after the change, and
coordinate the change with the nginx operator.

## 6. DB-user rotation (D12/2.16 — deploy-gated)

`scripts/prod/rotate-db-users.sh [--dry-run|--yes]`:

1. reads `DB_PASSWORD_*` from `pagepocket/.env`, generating any missing
   value (`openssl rand -hex 24`) and writing it back (0600, `.bak-<ts>`)
2. inside the pagepocket mysql container (credentials via short-lived 0600
   defaults file — never argv):
   `CREATE USER IF NOT EXISTS 'pagepocket_<svc>'@'%'` → `ALTER USER` (rotate)
   → `GRANT ALL PRIVILEGES ON <schema>.*` → `FLUSH PRIVILEGES`
3. prints `SHOW GRANTS` per user as evidence (each user must show usage +
   ALL on its own schema ONLY)
4. recreates the 5 services (`--no-deps --force-recreate`) + gateway
   restart so the overlay's scoped `DB_URL`s go live
5. verifies gateway `GET /api/v1/health` + no unhealthy containers

Cross-schema access then FAILS at the database level (grants are the
boundary, not convention). Fresh datadirs are seeded by the mysql
container's `init-users.sh` from the same env values — no drift.

## 7. Monolith network confinement (D12/2.17 — deploy-gated)

The monolith attaches to `pagepocket-monolith` — the network that carries
ONLY archive-service and auth-service — instead of `pagepocket_default`
(`server/docker-compose.yml`). Docker's embedded DNS does not resolve
search-/library-/share-service on that network, so they are unreachable
from the monolith; no iptables involved. Applying the switch to the
RUNNING monolith is an operator action:

```bash
# 0. precondition: the pagepocket stack is up (creates pagepocket-monolith)
docker network inspect pagepocket-monolith >/dev/null && echo "network exists"

# 1. switch the monolith (recreate with the new networks config)
cd /var/www/Web-Downloader-Extension/server
docker compose up -d --no-deps --force-recreate app

# 2. verify ALLOWED services resolve and connect
docker exec server-app-1 python -c "import socket;socket.create_connection(('archive-service',50052),timeout=3);print('archive OK')"
docker exec server-app-1 python -c "import socket;socket.create_connection(('auth-service',50051),timeout=3);print('auth OK')"

# 3. verify FOREIGN services are unreachable (all three must FAIL)
docker exec server-app-1 python -c "import socket;socket.getaddrinfo('search-service',50054)" && echo "LEAK: search resolvable" || echo "search blocked OK"
docker exec server-app-1 python -c "import socket;socket.getaddrinfo('library-service',50053)" && echo "LEAK: library resolvable" || echo "library blocked OK"
docker exec server-app-1 python -c "import socket;socket.getaddrinfo('share-service',50055)" && echo "LEAK: share resolvable" || echo "share blocked OK"

# 4. regression check: monolith + its own db + frontend still healthy
curl -s http://127.0.0.1:8000/api/v1/health | grep '"mysql":"ok"'
```

Rollback: `cd server && git checkout <previous-commit> -- docker-compose.yml
&& docker compose up -d --no-deps --force-recreate app` (or revert the
commit and recreate) — the monolith rejoins `pagepocket_default`.

## 8. Archive maintenance sidecar (5.9)

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

## 9. Certificates (spike finding b — read before touching certs)

- **Host PKI is authoritative.** Live certs (repo `pagepocket/certs/` is a
  STALE copy) expire **Jun 7 2036**; two different CAs exist between the
  repo set and the host set — never "sync" the repo set to prod.
- The only cert on a sub-year horizon on the host: `extension-client.pem`
  (May 2027) — legacy naming; the monolith actually mounts
  `extension-server-key.pem`/`extension-server.pem`.
- **Rootless containers (4.9) read these files as uid 999 (`app`)**: the
  host copies must be readable beyond root (e.g. `chmod 0644` on `*.pem`)
  or the services come up unable to load their identity — see §10.
- `make certs` (7.3-fixed) generates the canonical `extension-server-*`
  names **for local dev only**. Regenerated local certs must NEVER be copied
  to prod — that would break every service's mTLS identity at once. Real
  rotation (7.4, only if ever needed before 2036) happens ON the host, in a
  coordinated sequence: CA → service certs → api-gateway → monolith client
  cert, recreating the stack once.

## 10. Rollback notes

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
- **DB users (D12/2.16):** `pagepocket/.env.bak-<ts>` holds the pre-run
  `DB_PASSWORD_*`; restore it, re-run `rotate-db-users.sh --yes` (re-grants
  + rotates back to those values), and the services come up as before.
- **Rootless containers (4.9):** service images run as user `app` (uid 999).
  If a recreated service cannot read its mTLS material, the mounted
  `pagepocket/certs/*.pem` are too restrictive on the host — make them
  group/other-readable (`chmod 0644 pagepocket/certs/*.pem`; the directory
  is loopback-mounted only) and recreate. Rolling back to root containers =
  rebuild from a pre-4.9 commit.

## 11. Ops actions requiring user confirmation (from the spike — checklist)

- [ ] Close 33060 / 8000 / 8090 to the internet (lands via 5.11 compose
      changes on the first deploy) **and** rotate the monolith MySQL root
      credential (5.12) — highest-priority pair
- [ ] Rotate pagepocket `MYSQL_ROOT_PASSWORD` off the committed default (5.12)
- [ ] Set a Redis password (5.10/5.13) — coordinated env change + restart
- [ ] Install the nightly backup cron (5.4) and pick the off-host target
      (R2 / B2 / remote ssh — see §3 step 7)
- [ ] Execute one restore drill into a scratch DB and record it in §3
      (post-D13/4.1 the drill also proves the canary: marker row present in
      the scratch DB and ABSENT from the source DB — record that line too)
- [ ] Rotate the per-service DB users + cut services over to scoped
      credentials (§6 / D12/2.16) — run BEFORE the first deploy carrying
      the new prod overlay (its render hard-fails without `DB_PASSWORD_*`)
- [ ] Arm share-service `ENVIRONMENT=production` + public `BASE_URL`
      (lands via the overlay; verify a short link uses the public host)
- [ ] Apply the monolith network confinement + run the reachability
      verification (§7 / D12/2.17)
- [ ] Roll out the narrowed `TRUSTED_PROXIES` after verifying the host's
      real bridge gateway address (§5 / D3/1.9)
- [ ] Make the mounted mTLS material readable by the rootless service
      containers (`chmod 0644 pagepocket/certs/*.pem` on the host — §10)
- [ ] Cert expiry work is NOT needed (valid to 2036); the `make certs` rename
      (7.3) only affects local dev naming — no coordinated prod cert change
      required for this change
- [ ] First monolith redeploy (~4 months of accumulated commits) — schedule
      and smoke-test deliberately; nothing deploys it automatically
- [ ] Deploy-gate runs `git reset --hard origin/pagepocket` on the host —
      confirmed safe (tree clean apart from untracked `pagepocket/frontend/
      .next.bak-*` and `next.log`)

## 12. Script inventory (`scripts/prod/`)

| Script | Purpose |
|---|---|
| `backup-mysql.sh` | nightly per-DB `--single-transaction` dumps (5 pagepocket DBs + monolith) → `/var/backups/mysql`, log + freshness marker, 14-day pruning, optional rclone off-host copy. Dumps carry NO `CREATE DATABASE`/`USE` (D13/4.1) — restores must target an explicitly created scratch DB |
| `restore-drill.sh` | restore a backup into `<db>_drill_<ts>` (explicitly CREATEd), verify row counts vs source, run the scratch-only canary (marker row asserted ABSENT from the source DB), drop scratch (dry-run by default) |
| `rotate-credentials.sh` | generate + install MySQL credentials in host env files, ALTER USER in both containers, scoped recreates, health verification (dry-run by default) |
| `rotate-db-users.sh` | create/rotate the per-service least-privilege users (`pagepocket_<svc>` → own schema only), write `DB_PASSWORD_*` into `pagepocket/.env`, cutover recreate + health verification (dry-run by default; D12/2.16) |
| `roll-redis-password.sh` | set `REDIS_PASSWORD`, coordinated redis-first rolling restart, AUTH + health verification (dry-run by default) |
| `archive-maintenance/loop.py` | the 5.9 sidecar loop (RetryPendingIndexing / SweepOrphanR2Objects over mTLS) |
