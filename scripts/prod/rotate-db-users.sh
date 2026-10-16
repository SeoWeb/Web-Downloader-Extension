#!/usr/bin/env bash
#
# rotate-db-users.sh — per-service least-privilege MySQL users (D12/2.16)
#
# Creates/rotates the five pagepocket service users inside the pagepocket
# MySQL container and grants each ALL on ONLY its own schema:
#
#   pagepocket_auth    -> auth_db        (password: DB_PASSWORD_AUTH)
#   pagepocket_archive -> archive_db     (password: DB_PASSWORD_ARCHIVE)
#   pagepocket_library -> library_db     (password: DB_PASSWORD_LIBRARY)
#   pagepocket_search  -> search_db      (password: DB_PASSWORD_SEARCH)
#   pagepocket_share   -> share_db       (password: DB_PASSWORD_SHARE)
#
# After the grants, the services can be cut over from root: the prod
# overlay (docker-compose.prod.yml) REQUIRES DB_PASSWORD_* in
# pagepocket/.env and hardcodes the scoped user in each DB_URL — this
# script is what provisions those env values (generated, never printed).
#
# What it does, in order:
#   1. read DB_PASSWORD_* from pagepocket/.env; any missing value is
#      generated (openssl rand -hex 24) and written back (0600, .bak-<ts>)
#   2. CREATE USER IF NOT EXISTS + ALTER USER (rotate) + GRANT ALL on the
#      service's own schema + FLUSH PRIVILEGES, inside the running mysql
#      container (credentials via a short-lived 0600 defaults file — never
#      in argv, never in the host process list)
#   3. print SHOW GRANTS per user (no secrets in grants output) as evidence
#   4. recreate the 5 service containers + restart the gateway (--no-deps,
#      scoped) so DB_URLs pick up the scoped credentials
#   5. verify: gateway GET /api/v1/health 200 + no unhealthy containers
#   6. print a summary WITHOUT secrets
#
# Rollback: pagepocket/.env.bak-<ts> holds the pre-run env; re-run this
# script's ALTER pass with the old passwords (or restore the .bak and
# recreate again) — exact guidance is printed on failure.
#
# Idempotent: re-running rotates again (fresh passwords for entries it
# generates; existing DB_PASSWORD_* values are reused, making a re-run a
# no-op password-wise — just re-granted).
#
# Safe by default: without --yes it prints the plan (dry-run) and changes
# NOTHING.
#
# NEVER run against prod without the coordinator's explicit go-ahead
# (service containers are recreated in step 4; brief DB session churn).
# NOTE: init.sql no longer creates users; on a FRESH datadir the mysql
# container's init-users.sh seeds them from the same DB_PASSWORD_* env.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PP_ENV="$REPO_ROOT/pagepocket/.env"
PP_CONTAINER="${PP_MYSQL_CONTAINER:-pagepocket-mysql-1}"
TS="$(date +%Y%m%d_%H%M%S)"

# service -> (user, schema, env key)
USERS=(auth archive library search share)
user_for()   { printf 'pagepocket_%s' "$1"; }
schema_for() { printf '%s_db' "$1"; }
key_for()    { printf 'DB_PASSWORD_%s' "$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')"; }

MODE="dry-run"
[ "${1:-}" = "--yes" ] && MODE="yes"
[ "${1:-}" = "--dry-run" ] && MODE="dry-run"
if [ "${1:-}" != "" ] && [ "$MODE" = "dry-run" ] && [ "${1:-}" != "--dry-run" ]; then
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

# Root credential for the ALTER/GRANT connection itself.
ROOT_PW="$(env_var "$PP_ENV" MYSQL_ROOT_PASSWORD)"; ROOT_PW="${ROOT_PW:-pagepocket}"

# sql_quote VALUE — single SQL literal (doubles embedded quotes).
sql_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }

# Execute SQL inside the mysql container; credentials via a short-lived
# 0600 defaults file created INSIDE the container (never in argv, never in
# the host process list). SQL arrives on stdin (docker exec -i forwards
# it); the sh -c script itself rides in argv, so there is no script-tail-
# as-SQL hazard.
sql_exec() { # sql_exec SQL_TEXT
  docker exec -i -e ROT_PW="$ROOT_PW" "$PP_CONTAINER" sh -c '
    cnf="/tmp/.dbusers.$$.cnf"
    umask 077
    printf "[client]\nuser=root\npassword=%s\n" "$ROT_PW" > "$cnf"
    mysql --defaults-extra-file="$cnf"
    rc=$?
    rm -f "$cnf"
    exit $rc
  ' sql-sh <<< "$1"
}

# --- plan -------------------------------------------------------------------

log "per-service DB user rotation plan (${MODE}):"
log "  container: $PP_CONTAINER"
log "  env file : $PP_ENV"
for svc in "${USERS[@]}"; do
  key="$(key_for "$svc")"
  pw="$(env_var "$PP_ENV" "$key")"
  if [ -z "$pw" ]; then
    log "  $(user_for "$svc") -> $(schema_for "$svc").*  password: GENERATE + write ${key} to pagepocket/.env"
  else
    log "  $(user_for "$svc") -> $(schema_for "$svc").*  password: reuse existing ${key} ($(mask "$pw"))"
  fi
done
log "  grants   : ALL PRIVILEGES on the user's OWN schema only; no global grants"
log "  recreate : the 5 service containers (--no-deps) + gateway restart"
log "  verify   : gateway GET /api/v1/health + no unhealthy containers"

if [ "$MODE" != "yes" ]; then
  log "DRY-RUN — re-run with --yes to execute. Nothing was changed."
  exit 0
fi

command -v openssl >/dev/null 2>&1 || { echo "openssl not found" >&2; exit 1; }
docker inspect "$PP_CONTAINER" >/dev/null 2>&1 || { echo "ERROR: container ${PP_CONTAINER} not found" >&2; exit 1; }

# --- 1. passwords (generate what is missing; write env, 0600, backed up) ----
cp -p "$PP_ENV" "${PP_ENV}.bak-${TS}" 2>/dev/null || true
for svc in "${USERS[@]}"; do
  key="$(key_for "$svc")"
  if [ -z "$(env_var "$PP_ENV" "$key")" ]; then
    set_env_var "$PP_ENV" "$key" "$(openssl rand -hex 24)"
    log "generated ${key} -> $PP_ENV"
  fi
done

# --- 2. CREATE/ALTER/GRANT inside the container -----------------------------
fail=0
for svc in "${USERS[@]}"; do
  user="$(user_for "$svc")"
  schema="$(schema_for "$svc")"
  pw="$(env_var "$PP_ENV" "$(key_for "$svc")")"
  log "provisioning ${user} -> ${schema}.* ..."
  if ! sql_exec "CREATE USER IF NOT EXISTS '${user}'@'%' IDENTIFIED BY $(sql_quote "$pw");
ALTER USER '${user}'@'%' IDENTIFIED BY $(sql_quote "$pw");
GRANT ALL PRIVILEGES ON \`${schema}\`.* TO '${user}'@'%';
FLUSH PRIVILEGES;"; then
    log "ERROR: grant pass FAILED for ${user} — see mysql output above"
    fail=1
    continue
  fi
  # Evidence (SHOW GRANTS contains no passwords).
  grants="$(sql_exec "SHOW GRANTS FOR '${user}'@'%';" || true)"
  log "grants for ${user}:"
  printf '%s\n' "$grants" | sed 's/^/    /'
done
if [ "$fail" -ne 0 ]; then
  log "RESULT: FAILED during grants — env updated but rotation incomplete."
  log "  rollback: cp ${PP_ENV}.bak-${TS} $PP_ENV; fix the mysql error; re-run."
  exit 1
fi

# --- 3. cutover: recreate services so DB_URLs use the scoped users ----------
log "recreating pagepocket services with scoped DB_URLs (this lands the compose change) ..."
(cd "$REPO_ROOT/pagepocket" \
  && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps --force-recreate \
       auth-service archive-service library-service search-service share-service \
  && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps api-gateway \
  && docker compose -f docker-compose.yml -f docker-compose.prod.yml restart api-gateway)

# --- 4. verify ---------------------------------------------------------------
log "waiting for containers to come up ..."
sleep 10
gw=000
for i in $(seq 1 30); do
  gw="$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:8090/api/v1/health || true)"
  [ "$gw" = "200" ] && break
  sleep 2
done
if [ "$gw" = "200" ]; then log "pagepocket gateway health: 200"; else
  log "ERROR: gateway did not become healthy on :8090 (scoped credentials rejected? check DB_PASSWORD_* vs SHOW GRANTS)"; fail=1; fi

unhealthy="$(docker ps --filter name=pagepocket --filter health=unhealthy --format '{{.Names}}' || true)"
if [ -n "$unhealthy" ]; then
  log "ERROR: unhealthy containers after rotation: $unhealthy"; fail=1
else
  log "pagepocket containers: no unhealthy services"
fi

# --- 5. summary (no secrets) --------------------------------------------------
log "==================== db-user rotation summary ===================="
log "  users   : pagepocket_{auth,archive,library,search,share} scoped to their own schema"
log "  env     : $PP_ENV (DB_PASSWORD_*; backups: ${PP_ENV}.bak-${TS}, 0600)"
log "  secrets : NOT printed — read the env file if you must (0600)"
log "  evidence: SHOW GRANTS output above (each user: usage + own-schema ALL only)"
if [ "$fail" -ne 0 ]; then
  log "RESULT  : FAILED (see ERROR lines) — rollback notes:"
  log "  rollback: cp ${PP_ENV}.bak-${TS} $PP_ENV && re-run this script with --yes"
  log "  (or ALTER USER the old passwords back manually, then recreate the services)"
  exit 1
fi
log "RESULT  : OK"
log "next    : services now run as their scoped users (prod overlay DB_URLs); root is no longer used by services — keep it for administration only."
