#!/usr/bin/env bash
#
# rotate-credentials.sh — MySQL credential rotation (5.12; spike findings c/d)
#
# Rotates the monolith MySQL root + app-user passwords and the pagepocket
# MYSQL_ROOT_PASSWORD off the committed defaults. Safe by default: without
# --yes it prints the plan (dry-run).
#
# What it does, in order:
#   1. generate strong passwords (openssl rand -hex 24 — URL/URL-encoding safe)
#   2. back up + update host env files (0600, never committed):
#        server/.env       MYSQL_ROOT_PASSWORD, MYSQL_USER, MYSQL_PASSWORD
#        pagepocket/.env   MYSQL_ROOT_PASSWORD
#   3. ALTER USER in both running MySQL containers (root@localhost, root@%,
#      and monolith webdownloader@%) + FLUSH PRIVILEGES
#   4. recreate affected containers with --no-deps (monolith db+app; pagepocket
#      mysql + the 5 services; gateway restarted for its gRPC channels)
#   5. verify: monolith GET /api/v1/health shows mysql ok; pagepocket gateway
#      GET /api/v1/health returns 200; compose reports the services healthy
#   6. print a summary WITHOUT secrets (passwords live only in the env files)
#
# Rollback: the pre-rotation env files are kept as <file>.bak-<ts>; restore
# them, re-run the ALTER USER pass with the old values, recreate again —
# exact commands are printed at the end.
#
# Idempotent: every run generates FRESH passwords and converges to a rotated
# state; re-running is safe (it is another rotation).
#
# NEVER run against prod without the coordinator's explicit go-ahead
# (running services lose their DB sessions during the recreate step).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SERVER_ENV="$REPO_ROOT/server/.env"
PP_ENV="$REPO_ROOT/pagepocket/.env"
SERVER_CONTAINER="${SERVER_MYSQL_CONTAINER:-server-db-1}"
PP_CONTAINER="${PP_MYSQL_CONTAINER:-pagepocket-mysql-1}"
MYSQL_USER="${MYSQL_USER:-webdownloader}"
TS="$(date +%Y%m%d_%H%M%S)"
YES=0
[ "${1:-}" = "--yes" ] && YES=1
[ "${1:-}" = "--dry-run" ] && YES=0
if [ "${1:-}" != "" ] && [ "$YES" -eq 0 ] && [ "${1:-}" != "--dry-run" ]; then
  echo "usage: $0 [--dry-run|--yes]" >&2; exit 64
fi

log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
mask() { # mask VALUE — show only its length, never the value
  printf '<%d chars>' "${#1}"
}

env_var() {
  local file="$1" key="$2" line=""
  [ -f "$file" ] && line="$(grep -E "^${key}=" "$file" | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
  printf '%s' "$line"
}

# Update-or-append KEY=VALUE in an env file (creates the file 0600 if absent).
set_env_var() { # set_env_var FILE KEY VALUE
  local file="$1" key="$2" value="$3"
  [ -f "$file" ] || { install -m 600 /dev/null "$file"; }
  if grep -qE "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
  chmod 600 "$file"
}

# Current credentials (needed for the ALTER USER connection itself).
CUR_SERVER_PW="$(env_var "$SERVER_ENV" MYSQL_ROOT_PASSWORD)"; CUR_SERVER_PW="${CUR_SERVER_PW:-root_password}"
CUR_PP_PW="$(env_var "$PP_ENV" MYSQL_ROOT_PASSWORD)"; CUR_PP_PW="${CUR_PP_PW:-pagepocket}"

# Fresh secrets (hex: no shell/URL quoting hazards anywhere downstream).
NEW_SERVER_ROOT="$(openssl rand -hex 24)"
NEW_SERVER_APP="$(openssl rand -hex 24)"
NEW_PP_ROOT="$(openssl rand -hex 24)"

log "credential rotation plan:"
log "  server/.env        MYSQL_ROOT_PASSWORD -> $(mask "$NEW_SERVER_ROOT"), MYSQL_PASSWORD -> $(mask "$NEW_SERVER_APP") (user ${MYSQL_USER})"
log "  pagepocket/.env    MYSQL_ROOT_PASSWORD -> $(mask "$NEW_PP_ROOT")"
log "  ALTER USER in ${SERVER_CONTAINER}: root@localhost, root@%, ${MYSQL_USER}@%"
log "  ALTER USER in ${PP_CONTAINER}: root@localhost, root@%"
log "  recreate: ${SERVER_CONTAINER} + monolith app; pagepocket mysql + 5 services; gateway restart"

sql_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }

alter_users() { # alter_users CONTAINER CURRENT_PW SQL
  local container="$1" current="$2" sql="$3"
  docker exec -i "$container" sh -s -- "$sql" <<SQL
cat > /tmp/.rot.cnf <<'CNF'
[client]
user=root
password=${current}
CNF
chmod 600 /tmp/.rot.cnf
mysql --defaults-extra-file=/tmp/.rot.cnf -e "\$1"
rc=\$?
rm -f /tmp/.rot.cnf
exit \$rc
SQL
}

if [ "$YES" -ne 1 ]; then
  log "DRY-RUN — re-run with --yes to execute. Nothing was changed."
  exit 0
fi

command -v openssl >/dev/null 2>&1 || { echo "openssl not found" >&2; exit 1; }

# 1+2. Back up env files, then write the new values (0600).
cp -p "$SERVER_ENV" "${SERVER_ENV}.bak-${TS}" 2>/dev/null || true
cp -p "$PP_ENV" "${PP_ENV}.bak-${TS}" 2>/dev/null || true
set_env_var "$SERVER_ENV" MYSQL_ROOT_PASSWORD "$NEW_SERVER_ROOT"
set_env_var "$SERVER_ENV" MYSQL_USER "$MYSQL_USER"
set_env_var "$SERVER_ENV" MYSQL_PASSWORD "$NEW_SERVER_APP"
# Keep the monolith's explicit connection string in sync too (compose's
# `environment:` overrides env_file, but nothing should read a stale URL).
set_env_var "$SERVER_ENV" MYSQL_CONNECTION_STRING \
  "mysql+aiomysql://${MYSQL_USER}:${NEW_SERVER_APP}@db:3306/website_downloader"
set_env_var "$PP_ENV" MYSQL_ROOT_PASSWORD "$NEW_PP_ROOT"
log "env files updated (backups: *.bak-${TS}, 0600)"

# 3. Rotate the live credentials FIRST (existing pooled connections keep
# working; new connections fail only between this step and the recreates).
log "ALTER USER in ${SERVER_CONTAINER} ..."
alter_users "$SERVER_CONTAINER" "$CUR_SERVER_PW" \
  "ALTER USER 'root'@'localhost' IDENTIFIED BY $(sql_quote "$NEW_SERVER_ROOT"); \
   ALTER USER 'root'@'%' IDENTIFIED BY $(sql_quote "$NEW_SERVER_ROOT"); \
   ALTER USER '${MYSQL_USER}'@'%' IDENTIFIED BY $(sql_quote "$NEW_SERVER_APP"); \
   FLUSH PRIVILEGES;"
log "ALTER USER in ${PP_CONTAINER} ..."
alter_users "$PP_CONTAINER" "$CUR_PP_PW" \
  "ALTER USER 'root'@'localhost' IDENTIFIED BY $(sql_quote "$NEW_PP_ROOT"); \
   ALTER USER 'root'@'%' IDENTIFIED BY $(sql_quote "$NEW_PP_ROOT"); \
   FLUSH PRIVILEGES;"
log "credentials rotated inside MySQL"

# 4. Recreate affected containers (--no-deps, scoped).
log "recreating monolith db + app (server/)"
(cd "$REPO_ROOT/server" && docker compose up -d --no-deps --force-recreate db && docker compose up -d --no-deps --force-recreate app)
log "recreating pagepocket mysql + services (pagepocket/)"
(cd "$REPO_ROOT/pagepocket" \
  && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps --force-recreate mysql \
  && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps --force-recreate \
       auth-service archive-service library-service search-service share-service \
  && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps api-gateway \
  && docker compose -f docker-compose.yml -f docker-compose.prod.yml restart api-gateway)

# 5. Verify (bounded waits).
log "waiting for containers to come up ..."
sleep 10
fail=0
mono="$(curl -s -m 5 http://127.0.0.1:8000/api/v1/health || true)"
if printf '%s' "$mono" | grep -q '"mysql":"ok"'; then
  log "monolith health: mysql ok"
else
  log "ERROR: monolith health does not show mysql ok — check server/.env vs rotated credentials"
  fail=1
fi
gw=000
for i in $(seq 1 30); do
  gw="$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:8090/api/v1/health || true)"
  [ "$gw" = "200" ] && break
  sleep 2
done
if [ "$gw" = "200" ]; then log "pagepocket gateway health: 200"; else
  log "ERROR: gateway did not become healthy on :8090"; fail=1; fi

unhealthy="$(docker ps --filter name=pagepocket --filter health=unhealthy --format '{{.Names}}' || true)"
if [ -n "$unhealthy" ]; then
  log "ERROR: unhealthy containers after rotation: $unhealthy"; fail=1
else
  log "pagepocket containers: no unhealthy services"
fi

# 6. Summary (no secrets).
log "==================== rotation summary ===================="
log "  updated : $SERVER_ENV (MYSQL_ROOT_PASSWORD, MYSQL_USER, MYSQL_PASSWORD)"
log "  updated : $PP_ENV (MYSQL_ROOT_PASSWORD)"
log "  backups : ${SERVER_ENV}.bak-${TS}, ${PP_ENV}.bak-${TS} (0600)"
log "  rotated : monolith root + ${MYSQL_USER}; pagepocket root"
log "  secrets : NOT printed — read the env files if you must (0600)"
if [ "$fail" -ne 0 ]; then
  log "RESULT  : FAILED (see ERROR lines) — rollback commands follow"
  log "  rollback: cp ${SERVER_ENV}.bak-${TS} $SERVER_ENV && cp ${PP_ENV}.bak-${TS} $PP_ENV"
  log "  then re-run this script's ALTER + recreate pass with the old values (or restore the containers from the .bak envs and recreate)."
  exit 1
fi
log "RESULT  : OK"
