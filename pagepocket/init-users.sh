#!/bin/bash
# init-users.sh — per-service least-privilege MySQL users (D12/2.16).
#
# Mounted into the mysql container as /docker-entrypoint-initdb.d/20-init-
# users.sh (see docker-compose.yml). Runs ONLY on a FRESH datadir, right
# after init.sql has created the five schemas. Creates:
#
#   pagepocket_auth    -> auth_db        (password: $DB_PASSWORD_AUTH)
#   pagepocket_archive -> archive_db     (password: $DB_PASSWORD_ARCHIVE)
#   pagepocket_library -> library_db     (password: $DB_PASSWORD_LIBRARY)
#   pagepocket_search  -> search_db      (password: $DB_PASSWORD_SEARCH)
#   pagepocket_share   -> share_db       (password: $DB_PASSWORD_SHARE)
#
# each with ALL PRIVILEGES on its own schema and NOTHING else (no global
# grants, no cross-schema access — the boundary is enforced by grants, not
# convention). The compose env gives the DB_PASSWORD_* vars dev defaults
# (pp-*-dev); prod sets real values in pagepocket/.env, so the users are
# created with exactly the credentials the services' DB_URLs use.
#
# Existing datadir (prod): this script never runs there — use
# scripts/prod/rotate-db-users.sh to CREATE/rotate these users live.

set -euo pipefail

# The mysql client is on PATH in the entrypoint context; MYSQL_PWD avoids
# putting the password in argv. During init the temp server only accepts
# local root connections.
: "${MYSQL_ROOT_PASSWORD:?MYSQL_ROOT_PASSWORD must be set}"

# sql_quote VALUE — single SQL literal (doubles embedded single quotes).
sql_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }

run_sql() { # run_sql SQL...
  MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot "$@"
}

# create_service_user USER SCHEMA PASSWORD_ENV_VALUE
create_service_user() {
  local user="$1" schema="$2" pw="$3"
  run_sql <<SQL
CREATE USER IF NOT EXISTS '${user}'@'%' IDENTIFIED BY $(sql_quote "$pw");
ALTER USER '${user}'@'%' IDENTIFIED BY $(sql_quote "$pw");
GRANT ALL PRIVILEGES ON \`${schema}\`.* TO '${user}'@'%';
FLUSH PRIVILEGES;
SQL
  echo "init-users: provisioned ${user} -> ${schema}.*"
}

create_service_user pagepocket_auth    auth_db    "${DB_PASSWORD_AUTH:-pp-auth-dev}"
create_service_user pagepocket_archive archive_db "${DB_PASSWORD_ARCHIVE:-pp-archive-dev}"
create_service_user pagepocket_library library_db "${DB_PASSWORD_LIBRARY:-pp-library-dev}"
create_service_user pagepocket_search  search_db  "${DB_PASSWORD_SEARCH:-pp-search-dev}"
create_service_user pagepocket_share   share_db   "${DB_PASSWORD_SHARE:-pp-share-dev}"

echo "init-users: per-service least-privilege users ready"
