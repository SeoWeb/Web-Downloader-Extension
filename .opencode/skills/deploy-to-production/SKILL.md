---
name: deploy-to-production
description: Deploy or release this project to production on the Contabo server 185.213.25.5 (pagepocket.app). Use when the user asks to deploy, ship, release, publish, or update production, or mentions the production host or Contabo.
---

# Deploy to Production

Verified production topology (verified 2026-10-02). Follow these procedures exactly — several parts of the server are fragile in non-obvious ways.

## Connection & secrets

- SSH one-shots (BatchMode, no password prompt): `ssh -o BatchMode=yes siim@185.213.25.5 '<cmd>'`
- Key: `~/.ssh/id_rsa` (RSA), fingerprint `SHA256:DYj4iF797Xzx+idp1eNF/8fFOuR/6DO5Z2eEBwA9srA`
- Credentials are also stored gitignored in `.deploy.env` at the repo root (`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_KEY_PATH`, `DEPLOY_KEY_FINGERPRINT`, `DEPLOY_APP_DIR`, `DEPLOY_BRANCH`)
- Repo on server: `/var/www/Web-Downloader-Extension`, branch `pagepocket` — **this is THE production trunk**. `main` only advances via GitHub PR merge; never push to `main` directly.
- GitHub secrets `CONTABO_HOST` / `CONTABO_USER` / `CONTABO_SSH_KEY` are configured for `deploy.yml` (GitHub Actions deploy workflow).

## Server topology (verified 2026-10-02)

- **Cloudflare proxies pagepocket.app.** Cloudflare edge transforms apply to HTML responses: Email Obfuscation was observed injecting scripts into `/api/sc/*` responses. A CF config rule to disable Email Obfuscation for `/api/sc/*` + `/api/pp/*` was recommended — keep this in mind when debugging "impossible" HTML mutations of API responses.
- **Frontend:** runs under **PM2 v7** as app `pagepocket-frontend` (created 2026-06-07), serving host port `:3000`. Rebuild with `pnpm install --frozen-lockfile && pnpm build` (node via nvm — source nvm in non-login shells; pnpm 10 via corepack), keeping a hardlink backup `cp -al .next .next.bak-$(date +%s)` before the build. Restart flow: `pm2 stop pagepocket-frontend` → `pkill -f 'next[-]server'` (clean orphan processes) → `pm2 restart pagepocket-frontend` → verify `pm2 status` shows online with a frozen restart counter + `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/`. `.github/workflows/deploy.yml` automates this (deploy-frontend job); manual trigger: `gh workflow run deploy.yml --ref pagepocket`.
- **Backend:** docker compose project `pagepocket`, run from `/var/www/Web-Downloader-Extension/pagepocket` with **BOTH files**:
  `docker compose -f docker-compose.yml -f docker-compose.prod.yml ...`
  Services: `api-gateway` (8090 — the only host-published port), `auth` (50051), `archive` (50052), `library` (50053), `search` (50054), `share` (50055) — all internal-only, mTLS on — plus `mysql` and `redis` (internal).
- `restart-prod.sh` exists in `pagepocket/` (full `up -d --build` of everything). `scripts/deploy-contabo.sh` is **DRIFTED** (assumes pm2 + `main` branch) — do not trust it blindly.

### Gotchas

- After recreating any backend services, **RESTART api-gateway too** — stale gRPC channels caused transient 500s last time.
- Always use **BOTH compose files** (`-f docker-compose.yml -f docker-compose.prod.yml`), **`--no-deps`**, and run **from the `pagepocket` dir**. Wrong dir or missing override flips mTLS off and republishes internal ports to the host.
- `/etc/hosts` on the server maps `api-gateway` → `127.0.0.1` for the frontend — do not remove or "fix" this.
- **pkill self-match hazard:** when killing orphan frontend processes, write the pattern as `pkill -f 'next[-]server'` — never the literal `next-server`. A matchable literal inside the command text (SSH one-shot, script, heredoc) makes pkill match and kill its own shell/ssh process.
- **PM2 crash-loop history:** PM2 previously crash-looped (~1178 restarts) against orphan `next-server` processes (EADDRINUSE), which is why the frontend served a stale build from Jun 7 until 2026-10-02. Resolved; `pm2 save` done. Always kill orphans *before* `pm2 restart`, and afterwards confirm the restart counter is frozen (not climbing) in `pm2 status`.

## Standard procedures

### Verify before deploying

- Local CI-equivalent checks green (build + tests for the changed components).
- CI on GitHub green (PR flow: `pagepocket` → `main`, PR #2-style merge gate).

### Deploy backend

1. Assess which services actually changed (assess first, deploy second).
2. On the server: `git pull --ff-only` in `/var/www/Web-Downloader-Extension` (on branch `pagepocket`).
3. From the `pagepocket` dir, recreate only the changed services:
   `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build --no-deps <changed services>`
4. **Restart api-gateway as well** (stale gRPC channels otherwise).
5. Verify: `docker ps` health status + `curl https://pagepocket.app` smoke tests (frontend loads, API endpoints respond).
6. If unhealthy: roll back via `git revert` of the offending commit(s) + rebuild the affected services.

### Deploy frontend

1. In `pagepocket/frontend` on the server: source nvm (non-login shells don't have it), then `pnpm install --frozen-lockfile && pnpm build` (pnpm 10 via corepack).
   The real env file **must be present** — Zod env validation fails without it, and `NEXT_PUBLIC_*` values are baked at build time.
2. Back up the existing `.next` directory first: `cp -al .next .next.bak-$(date +%s)` (hardlink backup).
3. Restart via PM2: `pm2 stop pagepocket-frontend` → `pkill -f 'next[-]server'` (clean orphan `next-server` processes; mind the pkill self-match hazard above) → `pm2 restart pagepocket-frontend`.
4. Verify: `pm2 status` shows `pagepocket-frontend` **online** with a frozen restart counter, `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/` returns 200, and `https://pagepocket.app` renders correctly.
5. Or let CI do it: the `deploy-frontend` job in `.github/workflows/deploy.yml` automates the nvm/pnpm build + pm2 restart — `gh workflow run deploy.yml --ref pagepocket`.

## Safety rules

- **Assess first, deploy second.** Confirm what changed and what needs rebuilding before touching production.
- **Ask the user when unsure or when the change is risky** — DB migrations, destructive operations, or anything with expected downtime. Never guess on production.
- **Never print private keys** or log secrets. Use env files already present on the server.
- **Never push to `main` directly.** Production trunk is `pagepocket`; `main` advances only via GitHub PR merge.
- Prefer incremental deploys (`--no-deps <services>`) over full rebuilds; `restart-prod.sh` rebuilds everything and should be a last resort.
- If a deploy fails, restore the previous working state (rollback) and report what happened.
