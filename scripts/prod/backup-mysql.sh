#!/usr/bin/env bash
#
# backup-mysql.sh — nightly MySQL backups (harden-backend-security-and-ops 5.4)
#
# Dumps every production database with a consistent snapshot per DB
# (mysqldump --single-transaction), gzipped, timestamped, into
# /var/backups/mysql on the HOST (outside any container):
#
#   pagepocket-mysql-1 : auth_db archive_db library_db search_db share_db
#   server-db-1        : website_downloader (the legacy monolith DB)
#
# Observable by design:
#   - per-run log:            /var/backups/mysql/backup.log
#   - freshness marker:       /var/backups/mysql/last_backup_success (UTC ISO)
#   - `--check-fresh` exits non-zero when the marker is missing or stale
#     (> 26 h) — wire it to any alerting to detect "silently stopped backups".
#
# Off-host copy (5.4/D7): if BACKUP_RCLONE_REMOTE is set (rclone remote name,
# ideally a crypt remote so copies are encrypted with keys not stored here),
# the dumps are copied there and pruned on the same 14-day retention.
# NOT configured by the repo on purpose — see scripts/prod/README.md for the
# R2 / B2 / remote-ssh setup options.
#
# Scheduling is NOT installed by this repo (policy: prod is only mutated by
# explicit operator action). The cron line lives in scripts/prod/README.md.
#
# Usage:
#   backup-mysql.sh [--dry-run] [--check-fresh]
#
# Exit codes: 0 success; 1 one or more dumps failed; 2 dumps ok but the
# off-host copy failed; 3 freshness check failed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/mysql}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
LOG_FILE="$BACKUP_DIR/backup.log"
MARKER="$BACKUP_DIR/last_backup_success"
FRESHNESS_MAX_HOURS=26

PP_CONTAINER="${PP_MYSQL_CONTAINER:-pagepocket-mysql-1}"
SERVER_CONTAINER="${SERVER_MYSQL_CONTAINER:-server-db-1}"
PP_DBS=(auth_db archive_db library_db search_db share_db)
SERVER_DBS=(website_downloader)

# Off-host target: an rclone remote (configure in `rclone config`). Example
# for Cloudflare R2 with client-side encryption: an rclone crypt remote
# wrapping an s3-type remote. Empty = skip (loudly).
RCLONE_REMOTE="${BACKUP_RCLONE_REMOTE:-}"

DRY_RUN=0
CHECK_FRESH=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --check-fresh) CHECK_FRESH=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 64 ;;
  esac
done

log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" | tee -a "$LOG_FILE"; }

# ---------------------------------------------------------------------------
# Freshness check (no DB access, no credentials — the documented "did backups
# silently stop?" probe)
# ---------------------------------------------------------------------------
if [ "$CHECK_FRESH" -eq 1 ]; then
  if [ ! -f "$MARKER" ]; then
    echo "STALE: no backup marker at $MARKER — backups never succeeded" >&2
    exit 3
  fi
  hours=$(( ( $(date +%s) - $(date -u -r "$MARKER" +%s) ) / 3600 ))
  if [ "$hours" -gt "$FRESHNESS_MAX_HOURS" ]; then
    echo "STALE: last successful backup is ${hours}h old (max ${FRESHNESS_MAX_HOURS}h)" >&2
    exit 3
  fi
  echo "FRESH: last successful backup ${hours}h ago ($(cat "$MARKER"))"
  exit 0
fi

mkdir -p "$BACKUP_DIR"
touch "$LOG_FILE"

# ---------------------------------------------------------------------------
# Credentials: read root passwords from the host env files (0600, written by
# scripts/prod/rotate-credentials.sh). Legacy committed defaults are used as
# a last-resort fallback with a loud warning — rotation (5.12) removes them.
# ---------------------------------------------------------------------------
env_var() { # env_var FILE KEY -> value (or empty)
  local file="$1" key="$2" line=""
  [ -f "$file" ] && line="$(grep -E "^${key}=" "$file" | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
  printf '%s' "$line"
}

PP_PW="${MYSQL_ROOT_PASSWORD:-$(env_var "$REPO_ROOT/pagepocket/.env" MYSQL_ROOT_PASSWORD)}"
SERVER_PW="${MYSQL_ROOT_PASSWORD_SERVER:-$(env_var "$REPO_ROOT/server/.env" MYSQL_ROOT_PASSWORD)}"
if [ -z "$PP_PW" ]; then
  PP_PW="pagepocket"
  log "WARNING: no MYSQL_ROOT_PASSWORD in pagepocket/.env — using the LEGACY committed default. Run scripts/prod/rotate-credentials.sh."
fi
if [ -z "$SERVER_PW" ]; then
  SERVER_PW="root_password"
  log "WARNING: no MYSQL_ROOT_PASSWORD in server/.env — using the LEGACY committed default. Run scripts/prod/rotate-credentials.sh."
fi

# mysqldump/mysql with the password in a short-lived --defaults-extra-file
# inside the container (never in argv, never in the host process list).
# stdin receives the script; $1 container, $2 password, $3 tool, $4... args.
# The defaults file is passed FIRST — client tools stop parsing options at
# the first positional argument.
run_mysql() {
  local container="$1" password="$2"
  shift 2
  local cnf="/tmp/.mysql-ops.$$.cnf"
  docker exec -i "$container" sh -s -- "$@" <<SQL
cat > ${cnf} <<'CNF'
[client]
user=root
password=${password}
CNF
chmod 600 ${cnf}
tool=\$1; shift
"\$tool" --defaults-extra-file=${cnf} "\$@"
rc=\$?
rm -f ${cnf}
exit \$rc
SQL
}

TS="$(date +%Y%m%d_%H%M%S)"
FAILED=0
dumped=0

dump_db() { # dump_db CONTAINER PASSWORD DB
  local container="$1" password="$2" db="$3"
  local out="$BACKUP_DIR/${db}_${TS}.sql.gz"
  local started elapsed
  started="$(date +%s)"
  log "dumping ${container}/${db} -> ${out}"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "  (dry-run) would run: docker exec ${container} mysqldump --single-transaction --quick ${db} | gzip > ${out}"
    return 0
  fi
  # pipefail: a failed dump must not produce a silently-truncated gzip.
  if ! run_mysql "$container" "$password" mysqldump --single-transaction --quick --routines --triggers --databases "$db" | gzip > "$out"; then
    log "ERROR: dump of ${container}/${db} FAILED (partial file kept for forensics: ${out})"
    rm -f "$out"
    FAILED=1
    return 1
  fi
  chmod 600 "$out"
  elapsed=$(( $(date +%s) - started ))
  log "  ok: ${db} $(du -h "$out" | cut -f1) in ${elapsed}s"
  dumped=$((dumped + 1))
}

for db in "${PP_DBS[@]}"; do dump_db "$PP_CONTAINER" "$PP_PW" "$db" || true; done
for db in "${SERVER_DBS[@]}"; do dump_db "$SERVER_CONTAINER" "$SERVER_PW" "$db" || true; done

if [ "$DRY_RUN" -eq 1 ]; then
  log "dry-run complete — nothing written, no marker updated"
  exit 0
fi

if [ "$FAILED" -ne 0 ]; then
  log "BACKUP FAILED for one or more databases — freshness marker NOT updated"
  exit 1
fi

# Freshness marker: atomic (tmp + mv) so --check-fresh never reads a partial.
printf '%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "${MARKER}.tmp"
mv "${MARKER}.tmp" "$MARKER"
chmod 600 "$MARKER" "$LOG_FILE" 2>/dev/null || true
log "backup run complete: ${dumped} databases, marker updated"

# ---------------------------------------------------------------------------
# Off-host copy + retention (only when configured)
# ---------------------------------------------------------------------------
if [ -n "$RCLONE_REMOTE" ]; then
  if ! command -v rclone >/dev/null 2>&1; then
    log "ERROR: BACKUP_RCLONE_REMOTE is set but rclone is not installed — off-host copy FAILED"
    exit 2
  fi
  log "copying to off-host target ${RCLONE_REMOTE}"
  if rclone copy "$BACKUP_DIR" "$RCLONE_REMOTE" \
      --include '*.sql.gz' --include 'last_backup_success' --transfers 4; then
    # Retention: prune off-host copies older than the window, then local.
    rclone delete "$RCLONE_REMOTE" --include '*.sql.gz' --min-age "${RETENTION_DAYS}d" || true
    find "$BACKUP_DIR" -name '*.sql.gz' -mtime "+${RETENTION_DAYS}" -delete
    log "off-host copy + retention pruning done (kept ${RETENTION_DAYS} days)"
  else
    log "ERROR: off-host copy FAILED (local dumps are intact; investigate rclone before the next run)"
    exit 2
  fi
else
  log "WARNING: BACKUP_RCLONE_REMOTE not configured — dumps exist ONLY on this host. See scripts/prod/README.md (off-host copy)."
  find "$BACKUP_DIR" -name '*.sql.gz' -mtime "+${RETENTION_DAYS}" -delete
fi
