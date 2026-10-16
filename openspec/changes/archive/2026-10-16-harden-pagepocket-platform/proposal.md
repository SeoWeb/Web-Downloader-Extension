## Why

A five-agent audit of the pagepocket platform (services, gateway, frontend, ops) immediately after `harden-backend-security-and-ops` landed found 2 P0s and ~15 P1s that the previous change did not target: one 256 MB ingest can freeze the entire gateway for up to 120 s (event-loop blocking + unbounded cumulative upload); service boundaries are fictional (search-service queries `library_db` via raw cross-database SQL, all services connect to one MySQL as root); the rate limiter's client identity is spoofable (leftmost-XFF + ungated `CF-Connecting-IP`); logout never revokes server-side sessions (untyped `request` parameter → the endpoint 422s); and the prepared restore-drill script can never succeed — or, if "fixed" naively, would restore into the live database. Several of these were independently confirmed by multiple auditors.

## What Changes

**Cluster A — Gateway survivability & trust (runtime bugs)**
- Gateway stops blocking its event loop: gRPC stub calls moved off the async path (`run_in_threadpool`), uvicorn runs multi-worker (safe — limiter is Redis-backed), cumulative (not per-part) upload bound on ingest, `UNAVAILABLE` → 503 + `Retry-After`.
- Rate-limit identity made spoof-proof: rightmost-untrusted XFF walk, `CF-Connecting-IP` honored only from trusted peers; the Next.js server forwards the real client IP to the gateway; public share routes get their own per-IP bucket (currently unthrottled, with a DB write per asset hit).
- CORS middleware moved outermost so 401/429 responses carry `Access-Control-Allow-Origin`; `POST /auth/logout` fixed (`request: Request`) so server-side refresh-token revocation actually runs.
- Share-token view-count deduped via Redis (no DB write per asset); malformed JSON bodies → 400 not 500.

**Cluster B — Data integrity & real service boundaries**
- Ingest idempotency made race-safe (concurrent same-job retries converge on the existing page instead of 500 + double R2 upload).
- `DeletePage` reordered to commit the row deletion first, delete R2 after (crash-safe; orphans stay sweepable); delete notifies share-service and library to purge links/collection links (kills count-vs-items drift and dangling links).
- MEDIUMTEXT truncation becomes byte-safe (CJK pages currently corrupt the search index permanently via preview-only retry); search upsert made atomic; archive→search/library RPCs get deadlines; service-to-service gRPC channels are memoized, not per-call.
- Cross-database SQL removed from search-service (uses library's RPC); every service gets a least-privilege MySQL user scoped to its own schema (rotation script + runbook, deploy-gated); library-outage degrade semantics fixed (fail 503 instead of silently empty collections).
- Monolith confined on the docker network to archive+auth only (deploy-gated network policy).

**Cluster C — Frontend serving contract & session UX**
- `/api/pp` file responses forced to `Cache-Control: private` (currently `public, immutable` on cookie-authenticated files behind Cloudflare — cross-user cache-serve risk); `/api/sc` streams instead of buffering whole 256 MB archives; both proxies reject path escapes and allow-list route families; `Range`/`Accept`/`If-*` passed through.
- Session UX: `pp_access` cookie outlives the 1 h access token (browser no longer hard-logs-out with a valid 30-day refresh); global 401 handling (no more zombie dashboard); refresh path gets error handling and never writes an empty refresh cookie; dead `/api/session/refresh` route removed; viewer pages fetched by id (currently 404s beyond the newest 50); open-redirect backslash bypass closed; shell security headers + `server-only` env guard; favicon lookups self-hosted (currently leaks every archived hostname to Google).

**Cluster D — Ops proof & pipeline integrity**
- Restore-drill script fixed (`--databases` removed, scratch DB created explicitly, canary row asserts restore target) BEFORE anyone runs it; backup/restore contract made provably safe.
- Deploy gate binds to the gated SHA (currently `git reset --hard origin/pagepocket` can ship an ungated newer tip); frontend deploy becomes CI-gated; maintenance-sidecar and search-integration files added to CI/deploy path filters.
- The 7 skipped MySQL FULLTEXT/CJK search-integration tests execute in `make test-integration`; proto-stub freshness guard (`git diff --exit-code` after `make proto`) in CI; compose-contract render test.
- First-run fixed: `pagepocket/.env.example` created, `make dev` network guard, share-service gets `ENVIRONMENT=production` + `BASE_URL` in the prod overlay (its fail-fast is currently dead code — prod share links point at localhost).
- Hygiene: `.dockerignore` (certs/.env out of build context), Redis URL password redacted in logs, rootless containers, pip/docker caching in CI, Dockerfile layer order, docs drift (READMEs, runbook), proto hygiene (`reserved`, deprecated `plan`, shared `StatusResponse`, `r2_key` removed from `PageResponse`).

**BREAKING** (API contract): presigned R2 URLs are removed from `GET /archive/pages/{id}/view` and `GET /share/public/{token}` responses — the sandboxed proxy routes become the only archived-content delivery path (verified: no current client consumes the `url` field). Quota/limit errors move from prose-string matching to structured gRPC status details (string markers kept as legacy fallback).

## Capabilities

### New Capabilities
- `gateway-request-isolation`: the gateway must never serialize behind a single upstream call — non-blocking handlers, bounded cumulative ingest, multi-worker-safe, transient-outage → 503 semantics.
- `client-identity-propagation`: how client IP/identity is derived and forwarded (spoof-proof derivation at the gateway, Next.js forwarding duty, public-route buckets).
- `service-boundary-enforcement`: each service owns exactly its schema — no cross-DB SQL, least-privilege DB credentials, network confinement for foreign clients (monolith).
- `archived-file-proxy`: the `/api/pp` and `/api/sc` proxy contract — streaming, route allow-lists, traversal rejection, private caching, range passthrough.

### Modified Capabilities
- `pagepocket-api-gateway`: middleware order (CORS outermost), logout endpoint contract, share-public throttling, structured quota errors, view-count dedup, body validation 400s.
- `pagepocket-archive-service`: idempotent-concurrent ingest convergence, crash-safe delete ordering, intra-RPC deadlines, memoized channels, byte-safe indexing payload, library-outage semantics, R2 error classification, quota lock scope, presigned-URL removal, delete notifications.
- `pagepocket-search-service`: byte-aware truncation, atomic upsert, no cross-database access.
- `pagepocket-library-service`: user-scoped collection-id cache; page-link purge contract.
- `pagepocket-share-service`: immediate revocation visibility (no stale-cache window), duplicate-active-link race, token hashing at rest, dangling-link cleanup, `GetShareLink` expiry check.
- `pagepocket-proto-contracts`: reserved ranges/deprecations, shared `StatusResponse`, `r2_key` removal, comment accuracy.
- `pagepocket-frontend-auth`: cookie lifetime vs refresh lifetime, global 401 handling, refresh error handling, dead route removal, redirect validation.
- `pagepocket-frontend-page-viewer`: by-id page fetch, delete-flow error handling.
- `pagepocket-frontend-shell`: first-party security headers, env `server-only` guard, favicon privacy.
- `deployment-routing`: deployed tree must equal the gated SHA; frontend deploys CI-gated; sidecar/scripts in path filters. (Note: this capability is new-in-flight in `harden-backend-security-and-ops`; delta written against its scenarios.)

## Impact

- **Code**: `pagepocket/services/api-gateway/**` (routers, middleware, validation, main), `pagepocket/services/{archive,search,library,share}-service/**`, `pagepocket/shared/**` (cache, db, serving), `pagepocket/frontend/src/**` (proxy routes, auth libs, viewer, config), `pagepocket/proto/*.proto` + regenerated stubs, `.github/workflows/{ci,deploy}.yml`, `pagepocket/Makefile` + `docker-compose*.yml`, `scripts/prod/*` (restore-drill, new rotation script), `pagepocket/.env.example` (new), READMEs.
- **Deploy coupling**: gateway and share-service already require atomic deploy (previous change); this change adds archive↔search↔library RPC-deadline and cache-key changes that keep wire contracts additive — no new atomic pairs, but the per-service DB-user rotation is deploy-gated (scripts prepared, executed on user-ordered deploy, per the established `scripts/prod/` convention).
- **Extension**: no code changes; verification tasks only (confirm no extension consumer of `/view` presigned URLs before removal lands).
- **Monolith**: no code changes; network confinement is compose-only and deploy-gated.
- **Risk concentration**: Cluster B touches the most surface (archive-service ingest/delete paths) — mitigated by the existing 59-test archive suite + integration stack; Cluster A is mechanical but touches every router (sed-verifiable via AST/grep gates already established in `test_grpc_transport.py`).
