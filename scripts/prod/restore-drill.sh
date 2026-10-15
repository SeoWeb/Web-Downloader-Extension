#!/usr/bin/env bash
#
# restore-drill.sh — restore drill into scratch databases (harden-backend-
# security-and-ops 5.5, backend-backup-restore "Documented and verified
# restore procedure").
#
# Picks a backup, restores it into a scratch database
# (<db>_drill_<timestamp>) inside the same MySQL container, verifies table
# presence and exact row counts against the live source database, then drops
# the scratch database. SAFE BY DEFAULT: without --yes it only prints the
# plan (dry-run). The drill creates and drops scratch DBs on the production
# MySQL instance — run it in a quiet window; it never touches source data.
#
# Usage:
#   restore-drill.sh [--db NAME] [--backup FILE] [--container NAME]
#                    [--keep] [--yes]
#
#     --db        source database to drill (default: auth_db)
#     --backup    explicit backup file (default: newest $BACKUP_DIR/<db>_*.sql.gz)
#     --container mysql container (default: pagepocket-mysql-1;
#                 use server-db-1 for website_downloader)
#     --keep      keep the scratch database after verification (for manual
#                 inspection; drop it afterwards, see the printed command)
#     --yes       actually execute (default: dry-run plan only)
#
# Exit codes: 0 drill verified OK; 1 verification mismatch / failure;
# 2 setup error (no backup, no container).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/mysql}"
DB="auth_db"
BACKUP=""
CONTAINER="${PP_MYSQL_CONTAINER:-pagepocket-mysql-1}"
KEEP=0
YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --db) DB="$2"; shift 2 ;;
    --backup) BACKUP="$2"; shift 2 ;;
    --container) CONTAINER="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --yes) YES=1; shift ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }

# Root password from the host env files (see backup-mysql.sh).
env_var() {
  local file="$1" key="$2" line=""
  [ -f "$file" ] && line="$(grep -E "^${key}=" "$file" | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
  printf '%s' "$line"
}
PW="${MYSQL_ROOT_PASSWORD:-$(env_var "$REPO_ROOT/pagepocket/.env" MYSQL_ROOT_PASSWORD)}"
PW="${PW:-pagepocket}"

# Pick the newest backup for the DB unless one was given explicitly.
if [ -z "$BACKUP" ]; then
  BACKUP="$(ls -1t "$BACKUP_DIR/${DB}_"*.sql.gz 2>/dev/null | head -1 || true)"
fi
if [ -z "$BACKUP" ] || [ ! -f "$BACKUP" ]; then
  echo "ERROR: no backup found for ${DB} in ${BACKUP_DIR} — run scripts/prod/backup-mysql.sh first" >&2
  exit 2
fi

SCRATCH="${DB}_drill_$(date +%s)"

run_mysql() { # run_mysql SQL... (executes mysql inside the container)
  docker exec -i "$CONTAINER" sh -s -- "$@" <<SQL
cat > /tmp/.drill.cnf <<'CNF'
[client]
user=root
password=${PW}
CNF
chmod 600 /tmp/.drill.cnf
tool=\$1; shift
"\$tool" --defaults-extra-file=/tmp/.drill.cnf "\$@"
rc=\$?
rm -f /tmp/.drill.cnf
exit \$rc
SQL
}

log "restore drill plan:"
log "  container : $CONTAINER"
log "  source DB : $DB"
log "  backup    : $BACKUP ($(du -h "$BACKUP" | cut -f1), $(date -u -r "$BACKUP" '+%Y-%m-%d %H:%M:%SZ'))"
log "  scratch   : $SCRATCH"
log "  keep      : $KEEP"

if [ "$YES" -ne 1 ]; then
  log "DRY-RUN — re-run with --yes to execute. The drill will:"
  log "  1. gunzip < backup | mysql  (creates ${SCRATCH})"
  log "  2. compare table list + exact COUNT(*) per table between ${DB} and ${SCRATCH}"
  log "  3. compare alembic_version"
  log "  4. DROP DATABASE ${SCRATCH}   (unless --keep)"
  exit 0
fi

docker inspect "$CONTAINER" >/dev/null 2>&1 || { echo "ERROR: container ${CONTAINER} not found" >&2; exit 2; }

log "restoring backup into ${SCRATCH} ..."
gunzip -c "$BACKUP" | run_mysql mysql "$SCRATCH"

# Verify: exact row counts per table, source vs scratch.
fail=0
tables_src="$(run_mysql mysql -N -e "SELECT table_name FROM information_schema.tables WHERE table_schema='${DB}' ORDER BY table_name;")"
if [ -z "$tables_src" ]; then
  log "ERROR: source database ${DB} has no tables?! aborting"
  run_mysql mysql -e "DROP DATABASE IF EXISTS ${SCRATCH};" || true
  exit 1
fi

printf '%-28s %12s %12s %s\n' "table" "source" "scratch" "match"
while read -r t; do
  [ -z "$t" ] && continue
  src="$(run_mysql mysql -N -e "SELECT COUNT(*) FROM \`${DB}\`.\`${t}\`;")"
  dst="$(run_mysql mysql -N -e "SELECT COUNT(*) FROM \`${SCRATCH}\`.\`${t}\`;" 2>/dev/null || echo "MISSING")"
  if [ "$src" = "$dst" ]; then
    printf '%-28s %12s %12s %s\n' "$t" "$src" "$dst" "OK"
  else
    printf '%-28s %12s %12s %s\n' "$t" "$src" "$dst" "MISMATCH"
    fail=1
  fi
done <<< "$tables_src"

# Schema version must match the backup point.
ver_src="$(run_mysql mysql -N -e "SELECT version FROM \`${DB}\`.alembic_version;" 2>/dev/null || echo "(none)")"
ver_dst="$(run_mysql mysql -N -e "SELECT version FROM \`${SCRATCH}\`.alembic_version;" 2>/dev/null || echo "(none)")"
log "alembic_version: source=${ver_src} scratch=${ver_dst}"
[ "$ver_src" = "$ver_dst" ] || fail=1

if [ "$KEEP" -eq 1 ]; then
  log "scratch database KEPT for inspection: ${SCRATCH}"
  log "drop it afterwards with:"
  log "  docker exec -it ${CONTAINER} mysql -e 'DROP DATABASE ${SCRATCH};'"
else
  log "dropping scratch database ${SCRATCH}"
  run_mysql mysql -e "DROP DATABASE ${SCRATCH};"
fi

if [ "$fail" -ne 0 ]; then
  log "DRILL FAILED — row-count or alembic_version mismatch (see table above)"
  exit 1
fi
log "DRILL VERIFIED: ${DB} restored from $(basename "$BACKUP") — all tables and row counts match"
log "record date / backup used / result in scripts/prod/README.md (restore-drill log)"
