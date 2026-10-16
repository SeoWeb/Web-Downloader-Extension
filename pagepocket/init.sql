-- PagePocket schema bootstrap — runs ONLY on a fresh MySQL datadir
-- (mounted as /docker-entrypoint-initdb.d/init.sql).

CREATE DATABASE IF NOT EXISTS auth_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS archive_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS library_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS search_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS share_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Per-service least-privilege users (D12/2.16): pagepocket_auth,
-- pagepocket_archive, pagepocket_library, pagepocket_search,
-- pagepocket_share — each granted ALL on its own schema and nothing else.
--
-- They are deliberately NOT created in this file: a mounted .sql script
-- cannot read the container's environment, so the passwords would be
-- static literals here and would drift from the DB_PASSWORD_* values the
-- services actually use in their DB_URLs. Instead they are created by
-- init-users.sh (mounted alongside this file as
-- /docker-entrypoint-initdb.d/20-init-users.sh) from the mysql container's
-- DB_PASSWORD_{AUTH,ARCHIVE,LIBRARY,SEARCH,SHARE} env vars, which compose
-- populates from the same pagepocket/.env keys.
--
-- On an EXISTING datadir (prod), entrypoint scripts never run — rotate and
-- provision with scripts/prod/rotate-db-users.sh instead.
