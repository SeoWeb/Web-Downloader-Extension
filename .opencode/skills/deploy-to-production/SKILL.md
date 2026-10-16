---
name: deploy-to-production
description: Deploy or release this project to production on the Contabo server 185.213.25.5 (pagepocket.app). Use when the user asks to deploy, ship, release, publish, or update production, or mentions the production host or Contabo.
---

# Deploy to Production

**The user orders deploys explicitly.** Never deploy, push to production branches without `[skip ci]`, or mutate the production host unless the user asked for it in the current conversation. When the user does order a deploy, follow `scripts/prod/README.md` (the authoritative runbook) in order — this skill carries the connection facts, the non-negotiable safety rules, and the current-state notes the runbook assumes.

## Connection

- Host: `185.213.25.5` (Contabo, pagepocket.app)
- User: `siim` — **public-key auth only**, no password prompts:
  `ssh -o BatchMode=yes siim@185.213.25.5 '<cmd>'`
- Key: `~/.ssh/id_rsa` (RSA), fingerprint `SHA256:DYj4iF797Xzx+idp1eNF/8fFOuR/6DO5Z2eEBwA9srA`; also gitignored at repo root `.deploy.env` (`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_KEY_PATH`, `DEPLOY_KEY_FINGERPRINT`, `DEPLOY_APP_DIR`, `DEPLOY_BRANCH`)
- **Sudo on the host needs the user's password** — hand interactive/sudo steps to the user, or ask them to run the exact command and paste output. Never assume passwordless sudo.
- Code path on server: `/var/www/Web-Downloader-Extension`, branch `pagepocket` — **this is the production trunk**. `main` is the GitHub-side line (advances via PR merge or explicit user-ordered consolidation; it does not deploy anything).

## What a deploy IS now (post-hardening, 2026-10)

- `deploy.yml` fires on **every push to `pagepocket`**: path-filtered jobs, a **CI gate** (backend + frontend deploys require a green `ci.yml` run of the exact pushed SHA), SHA-pinned checkout (`DEPLOY_SHA`; aborts on queue-race), alembic per service, **GET** (never HEAD) health polls with bounded retries.
- To push code **without** deploying (consolidation), put `[skip ci]` in the HEAD commit message of the push (done 2026-10-16 for the main fast-forward).
- Backend = docker compose project `pagepocket` from `/var/www/Web-Downloader-Extension/pagepocket`, **always both files** (`-f docker-compose.yml -f docker-compose.prod.yml`). `api-gateway` :8090 is the only host-published port (bound to 127.0.0.1); MySQL :33060 is **not** published anymore; internal services are mTLS-only.
- Frontend = nohup `next start` on :3000 (**no pm2 on the host** — deploy.yml handles both, prefers the no-pm2 path; if you see pm2 output, fine, but do not "restore" pm2).
- The **monolith** (`server/`, compose project `server`, port 8000) is deployed **manually, outside CI — by design**. Never let a pagepocket deploy touch it. **Deploy day INCLUDES a manual monolith rebuild** (user order 2026-10-16: only the operator's own extension build consumes it, so no legacy contract applies) — procedure in runbook §3 step 3b (build → alembic stamp-or-upgrade → up on the confinement network; subsumes the §7 switch).

## Non-negotiable safety rules

1. **Both compose files, from the `pagepocket` dir, `--no-deps` for scoped recreates.** Missing the prod overlay flips mTLS off and republishes internal ports to the host.
2. **After recreating ANY backend service, restart `api-gateway`** (stale gRPC channels caused transient 500s).
3. **pkill self-match hazard:** write `pkill -f 'next[-]server'` — a matchable literal kills its own SSH shell.
4. **Do not remove or "fix" `/etc/hosts` on the server** (`api-gateway` → 127.0.0.1 for the frontend is intentional).
5. **Never copy locally generated certs to prod.** Host PKI is authoritative (valid to 2036; see runbook §9). After the rootless-container change, host `pagepocket/certs/*.pem` keys must be `chmod 0644` or services can't read them.
6. **Order matters on the first hardened deploy:** run `scripts/prod/rotate-db-users.sh --yes` and set `BASE_URL` **before** the first deploy carrying the new prod overlay (its compose render hard-fails without `DB_PASSWORD_*` / `BASE_URL`). Full sequence: runbook §2 → §3.
7. **Backend + frontend ship atomically.** The frontend (by-id page fetch, proxy contracts) assumes the new gateway. Never hand-deploy one side against the other.
8. If a deploy fails mid-way, **stop and reconcile with runbook §10 (rollback) before retrying** — don't stack fixes on a half-deployed host.

## Deploy-day sequence (summary — runbook is authoritative)

1. Read `scripts/prod/README.md` §2–§3; verify host `.env` has every var in its table (incl. `DB_PASSWORD_*`, `BASE_URL`, `REDIS_PASSWORD`, `TRUSTED_PROXIES`, `GATEWAY_WORKERS`).
2. Prep scripts (prepared, never yet executed): `rotate-db-users.sh` → `rotate-credentials.sh` → `roll-redis-password.sh` — each has a `--dry-run` default; run dry first, show the user the plan, then `--yes` on their go.
3. Trigger the gated deploy: push `pagepocket` (or `gh workflow run deploy.yml --ref pagepocket`), watch `gh run list`, then the deploy job logs.
4. Post-deploy verification: `GET http://127.0.0.1:8090/api/v1/health` (expect `"status":"ok"`, rate_limiter not degraded), `curl` :3000 for 200, `docker compose ps` all healthy, external port scan (:33060/:8000/:8090 must now be CLOSED).
5. Deploy-gated verifications still open: monolith confinement (§7), share-service short-URL check (§3 step 9), TRUSTED_PROXIES bucketing (§5), restore drill + canary evidence (`scripts/prod/restore-drill.sh`), E2E smoke against prod.
6. Record results in the runbook (§ restore-drill log) so the OpenSpec deploy-gated tasks can be ticked and the remaining change archived.

## Known gotchas (earned, keep)

- Cloudflare edge mutates HTML (Email Obfuscation injected scripts into `/api/sc/*` once) — when API responses look "impossibly" mutated, suspect CF, not the app.
- `scripts/deploy-contabo.sh` is a drifted stub — do not trust; `restart-prod.sh` in `pagepocket/` does a full `up -d --build` (blunt but real).
- MySQL boot race is fixed in code (`shared/db.py` bounded connect-retry); if a service still exit-loops on fresh volumes, check `docker logs` for the retry lines before restarting blind.
- `make test-integration` uses project `-p pagepocket-it` and needs :3306/:8090 free — never run it against the prod stack's ports.
