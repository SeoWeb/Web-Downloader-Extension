#!/usr/bin/env bash
#
# roll-redis-password.sh — coordinated Redis password rollout (5.13)
#
# Sets REDIS_PASSWORD in pagepocket/.env (the compose files interpolate it
# into `redis-server --requirepass` and every service's REDIS_URL), then
# performs a coordinated rolling restart: redis first, then the services.
# Safe by default: without --yes it prints the plan (dry-run).
#
#   1. generate a strong password (openssl rand -hex 24 — redis://-URL safe,
#      no escaping needed)
#      (or take an explicit one via --password, e.g. for ROLLBACK)
#   2. back up + update pagepocket/.env (0600): REDIS_PASSWORD=...
#   3. recreate redis (--no-deps --force-recreate) and wait for its
#      healthcheck; verify `redis-cli ping` (AUTH via REDISCLI_AUTH) -> PONG
#   4. recreate the 5 services + gateway so they pick up the new REDIS_URL
#   5. verify the gateway health endpoint (GET, bounded retries)
#
# Rollback: the pre-change .env is kept as pagepocket/.env.bak-<ts>. Restore
# it and re-run this script with `--password <old>` — the old value is in
# the .bak file. No credential was lost (Redis is cache-only; a rollback
# briefly degrades caching/rate limiting, never data).
#
# Downtime window: between steps 3 and 4 the services talk to a
# password-protected Redis WITHOUT credentials — the gateway's limiter fails
# OPEN (logged, health reports degraded) and service caches error/rebuild.
# This is availability-preserving by design (D12) and lasts seconds.
#
# NEVER run against prod without the coordinator's explicit go-ahead.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PP_ENV="$REPO_ROOT/pagepocket/.env"
PP_DIR="$REPO_ROOT/pagepocket"
TS="$(date +%Y%m%d_%H%M%S)"
PASSWORD=""
YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1; shift ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --dry-run) YES=0; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
mask() { printf '<%d chars>' "${#1}"; }

env_var() {
  local file="$1" key="$2" line=""
  [ -f "$file" ] && line="$(grep -E "^${key}=" "$file" | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
  printf '%s' "$line"
}

if [ -z "$PASSWORD" ]; then
  PASSWORD="$(openssl rand -hex 24)"
  log "generated new REDIS_PASSWORD: $(mask "$PASSWORD")"
else
  log "using supplied REDIS_PASSWORD: $(mask "$PASSWORD")"
fi

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

log "rollout plan:"
log "  set REDIS_PASSWORD in $PP_ENV (0600)"
log "  recreate redis, wait healthy, AUTH ping"
log "  recreate auth/archive/library/search/share services + api-gateway"
log "  verify gateway /api/v1/health (GET, 30 x 2s)"

if [ "$YES" -ne 1 ]; then
  log "DRY-RUN — re-run with --yes to execute. Nothing was changed."
  exit 0
fi

# 2. Env file (backup + update-or-append, 0600).
[ -f "$PP_ENV" ] || install -m 600 /dev/null "$PP_ENV"
cp -p "$PP_ENV" "${PP_ENV}.bak-${TS}"
if grep -qE '^REDIS_PASSWORD=' "$PP_ENV"; then
  sed -i "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=${PASSWORD}|" "$PP_ENV"
else
  printf 'REDIS_PASSWORD=%s\n' "$PASSWORD" >> "$PP_ENV"
fi
chmod 600 "$PP_ENV"
log "pagepocket/.env updated (backup: ${PP_ENV}.bak-${TS})"

cd "$PP_DIR"

# 3. Redis first.
log "recreating redis with --requirepass ..."
$COMPOSE up -d --no-deps --force-recreate redis
log "waiting for redis healthcheck ..."
for i in $(seq 1 30); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$($COMPOSE ps -q redis)" 2>/dev/null || echo unknown)"
  [ "$status" = "healthy" ] && break
  sleep 2
done
if [ "${status:-unknown}" != "healthy" ]; then
  log "ERROR: redis did not become healthy — inspect: docker logs \$(cd $PP_DIR && $COMPOSE ps -q redis)"
  log "rollback: cp ${PP_ENV}.bak-${TS} $PP_ENV && $COMPOSE up -d --no-deps --force-recreate redis"
  exit 1
fi
redis_c="$($COMPOSE ps -q redis)"
if docker exec -e REDISCLI_AUTH="$PASSWORD" "$redis_c" redis-cli ping 2>/dev/null | grep -q PONG; then
  log "redis AUTH ping: PONG (password active)"
else
  log "ERROR: authenticated PING failed against the new password — aborting before touching services"
  log "rollback: cp ${PP_ENV}.bak-${TS} $PP_ENV && $COMPOSE up -d --no-deps --force-recreate redis"
  exit 1
fi

# 4. Services (they now pick up the new REDIS_URL with credentials).
log "recreating services + gateway with the new REDIS_URL ..."
$COMPOSE up -d --no-deps --force-recreate auth-service archive-service library-service search-service share-service
$COMPOSE up -d --no-deps api-gateway
$COMPOSE restart api-gateway

# 5. Verify.
code=000
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:8090/api/v1/health || true)"
  [ "$code" = "200" ] && break
  sleep 2
done
unhealthy="$(docker ps --filter name=pagepocket --filter health=unhealthy --format '{{.Names}}' || true)"

log "==================== rollout summary ===================="
log "  redis      : password active, healthcheck green"
log "  gateway    : /api/v1/health -> ${code}"
log "  unhealthy  : ${unhealthy:-none}"
if [ "$code" = "200" ] && [ -z "$unhealthy" ]; then
  log "RESULT  : OK (previous env preserved at ${PP_ENV}.bak-${TS})"
  log "  rollback if ever needed: cp ${PP_ENV}.bak-${TS} $PP_ENV && $COMPOSE up -d --no-deps --force-recreate redis auth-service archive-service library-service search-service share-service api-gateway"
else
  log "RESULT  : FAILED (see ERROR/health lines above)"
  log "  rollback: cp ${PP_ENV}.bak-${TS} $PP_ENV && $COMPOSE up -d --no-deps --force-recreate redis auth-service archive-service library-service search-service share-service api-gateway"
  exit 1
fi
