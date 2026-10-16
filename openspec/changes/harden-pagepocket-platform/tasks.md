# Tasks — harden-pagepocket-platform

## 1. Cluster A — Gateway survivability & trust

- [x] 1.1 Verify no extension (or frontend) consumer of presigned `/view` + `/share/public` URLs: grep `pagepocket/extension/**` and `pagepocket/frontend/src/**` for `signed_url` / `"url"` consumption (incl. `pagepocket/frontend/src/app/(share)/s/[token]/page.tsx`) and record the evidence needed before the removal tasks (1.16, 3.4)
- [x] 1.2 Wrap every synchronous gRPC stub call in gateway `async def` handlers with `run_in_threadpool` across all routers in `pagepocket/services/api-gateway/routers/` (archive.py, auth.py, share.py, library.py, search.py)
- [x] 1.3 Add a dedicated bounded executor (or enlarged AnyIO capacity) for ingest-class upstream calls in `pagepocket/services/api-gateway/main.py`
- [x] 1.4 Run uvicorn multi-worker via `GATEWAY_WORKERS` env (default 2) in `pagepocket/services/api-gateway/main.py` / `pagepocket/services/api-gateway/Dockerfile` and `pagepocket/docker-compose.yml`
- [x] 1.5 Enforce the cumulative ingest bound: running byte counter across parts → 413, `MAX_INGEST_ASSETS` (default 200), required `Content-Length` in `pagepocket/services/api-gateway/routers/archive.py` + `pagepocket/services/api-gateway/validation.py` + config module
- [x] 1.6 Validate `extension_job_id` (≤ 36 chars, charset) at the gateway ingest route in `pagepocket/services/api-gateway/routers/archive.py` → 400
- [x] 1.7 Map gRPC `UNAVAILABLE` → HTTP 503 + `Retry-After` (alongside existing `DEADLINE_EXCEEDED` handling) in `pagepocket/services/api-gateway/routers/__init__.py`
- [x] 1.8 Implement rightmost-untrusted XFF walk + peer-gated `CF-Connecting-IP` in `pagepocket/services/api-gateway/middleware/rate_limit.py`, mirroring `server/app/api/routes/auth.py`; add unit tests
- [x] 1.9 Narrow the default `TRUSTED_PROXIES` (specific nginx/host + Next hop addresses, env-overridable) in `pagepocket/docker-compose.yml` and `pagepocket/docker-compose.prod.yml`; document values in the ops runbook (rollout itself deploy-gated — task 6.10)
- [x] 1.10 Add a client-IP forwarding helper and wire it into all five server→gateway fetch sites: `pagepocket/frontend/src/app/api/session/route.ts`, `pagepocket/frontend/src/app/api/session/register/route.ts`, `pagepocket/frontend/src/app/api/pp/[...path]/route.ts`, `pagepocket/frontend/src/app/api/v1/auth/[...path]/route.ts`, `pagepocket/frontend/src/lib/api/http.ts`
- [x] 1.11 Add the per-IP rate bucket for `/api/v1/share/public/*` (20/min class) in `pagepocket/services/api-gateway/middleware/rate_limit.py`
- [x] 1.12 Reorder middleware so CORS is outermost (added last) in `pagepocket/services/api-gateway/main.py` + `pagepocket/services/api-gateway/middleware/__init__.py`; test that 401/429 carry `Access-Control-Allow-Origin`
- [x] 1.13 Fix `POST /api/v1/auth/logout` (`request: Request` typed handler) in `pagepocket/services/api-gateway/routers/auth.py` so `AuthService.Logout` revocation runs; stop swallowing logout errors in `pagepocket/frontend/src/app/api/session/route.ts`
- [x] 1.14 Return 400 (not 500) for malformed/missing JSON bodies and guard all dict indexing on payloads in `pagepocket/services/api-gateway/routers/share.py` + `pagepocket/services/api-gateway/routers/auth.py`
- [x] 1.15 Add shared `exhausted:quota|size|rate` marker constants in `pagepocket/shared/`, set them on archive `RESOURCE_EXHAUSTED` details in `pagepocket/services/archive-service/servicer.py`, parse the prefix first (log legacy-fallback use) in `pagepocket/services/api-gateway/routers/__init__.py`
- [x] 1.16 Remove `url`/`signed_url` presigned fields from the `GET /archive/pages/{id}/view` and `GET /share/public/{token}` gateway responses in `pagepocket/services/api-gateway/routers/archive.py` + `pagepocket/services/api-gateway/routers/share.py` (only after 1.1 evidence)
- [x] 1.17 Deduplicate share view counts via Redis (per-viewer TTL dedupe, no DB UPDATE per asset hit) in `pagepocket/services/share-service/servicer.py` using `pagepocket/shared/cache_config.py`

## 2. Cluster B — Data integrity & real service boundaries

- [x] 2.1 Make ingest idempotency race-safe: catch `IntegrityError`, rollback, re-select by `(user_id, extension_job_id)`, return the existing `page_id`, clean the loser's R2 prefix via `_cleanup_failed_ingest` in `pagepocket/services/archive-service/servicer.py`; add concurrency tests (incl. service-side `extension_job_id` guard → `INVALID_ARGUMENT`)
- [x] 2.2 Reorder `DeletePage`: commit row deletion + quota decrement first, delete R2 prefix/thumbnail after (sweepable orphans) in `pagepocket/services/archive-service/servicer.py`; update the delete tests
- [x] 2.3 Add `LibraryService.PurgePageLinks(page_id)` and `ShareService.RevokeLinksForPage(page_id)` RPCs: proto edits in `pagepocket/proto/library.proto` + `pagepocket/proto/share.proto`, servicers in `pagepocket/services/library-service/servicer.py` + `pagepocket/services/share-service/servicer.py`, then `make proto`
- [x] 2.4 Wire delete notifications: archive `DeletePage` calls `SearchService.RemovePage` (with deadline), `RevokeLinksForPage`, `PurgePageLinks` (best-effort, logged) in `pagepocket/services/archive-service/servicer.py`
- [x] 2.5 Add the shared byte-safe `truncate_utf8` helper in `pagepocket/shared/` and use it before send in `pagepocket/services/archive-service/servicer.py` and before insert in `pagepocket/services/search-service/servicer.py`
- [x] 2.6 Make `RetryPendingIndexing` re-read the page HTML from R2 (authoritative) instead of the 500-char preview in `pagepocket/services/archive-service/servicer.py`
- [x] 2.7 Replace search read-then-insert with atomic `INSERT … ON DUPLICATE KEY UPDATE` in `pagepocket/services/search-service/servicer.py`
- [x] 2.8 Remove cross-database SQL from search-service: use `ListCollectionPageIds` (user-scoped) in `pagepocket/services/search-service/servicer.py`; add `user_id` scoping to the collection filter semantics in `pagepocket/services/library-service/servicer.py`
- [x] 2.9 Attach explicit deadlines (30 s class) to all archive→search/library/share RPCs (`IndexPage`, `RemovePage`, `ListCollectionPageIds`, `RevokeLinksForPage`, `PurgePageLinks`) in `pagepocket/services/archive-service/servicer.py`
- [x] 2.10 Replace per-call channel/stub churn with the memoized `grpc_clients` pattern in `pagepocket/services/archive-service/servicer.py`, `pagepocket/services/library-service/servicer.py`, `pagepocket/services/share-service/servicer.py` (mirror `pagepocket/services/api-gateway/grpc_clients/__init__.py`)
- [x] 2.11 Fix library-outage semantics: collection-scoped list failure → `UNAVAILABLE`, never cache an empty set, truthful log message in `pagepocket/services/archive-service/servicer.py`
- [x] 2.12 Scope `ListCollectionPageIds` cache keys by `(user_id, collection_id)` and enforce ownership on the cache path in `pagepocket/services/library-service/servicer.py`
- [x] 2.13 Classify R2 errors (`NoSuchKey`/404 → `NOT_FOUND`; `SlowDown`/503-class → `UNAVAILABLE`; else `INTERNAL`) in `pagepocket/services/archive-service/servicer.py`
- [x] 2.14 Restructure quota locking to reserve-then-confirm (short `FOR UPDATE` transaction, re-check + commit after upload) in `pagepocket/services/archive-service/servicer.py`
- [x] 2.15 Share-service hardening: hash tokens at rest (`pagepocket/services/share-service/models.py`), close the duplicate-active-link race and revoke-commit/cache-set staleness guard in `pagepocket/services/share-service/servicer.py`, add expiry reporting to `GetShareLink`
- [x] 2.16 Prepare per-service least-privilege MySQL users: grants in `pagepocket/init.sql`, `pagepocket/scripts/prod/rotate-db-users.sh` (new, deploy-gated), per-service `DB_URL` env in `pagepocket/docker-compose.yml` (dev root fallback) + `pagepocket/docker-compose.prod.yml` (scoped users required)
- [x] 2.17 Prepare monolith network confinement in the prod overlay (archive+auth only) in `pagepocket/docker-compose.prod.yml`; document apply + verification steps in the runbook (apply deploy-gated — task 6.8)

## 3. Cluster C — Frontend serving contract & session UX

- [x] 3.1 Force `Cache-Control: private` (preserve max-age, strip `public`/`immutable`) on file responses in `pagepocket/frontend/src/app/api/pp/[...path]/route.ts` `proxyResponse`
- [x] 3.2 Add the route allow-list (`^/api/v1/(archive|library|search|share|auth)/` after normalization) + decoded-dot-segment rejection (400) to `pagepocket/frontend/src/app/api/pp/[...path]/route.ts` and token-segment validation to `pagepocket/frontend/src/app/api/sc/[token]/[...path]/route.ts`
- [x] 3.3 Stream bodies in both proxies: replace `/api/sc` `arrayBuffer()` buffering, forward `Range`/`Accept`/`If-None-Match`/`If-Modified-Since`/caller `Content-Type`, pass upstream `Content-Type` through, forward `DELETE` bodies in `pagepocket/frontend/src/app/api/pp/[...path]/route.ts` + `pagepocket/frontend/src/app/api/sc/[token]/[...path]/route.ts`
- [x] 3.4 Remove frontend reads of the removed presigned `url` field (validity check in `pagepocket/frontend/src/app/(share)/s/[token]/page.tsx`) — after 1.1
- [x] 3.5 Give `pp_access` a 30-day cookie lifetime and make the proxy guard treat `pp_refresh` presence as pass-worthy in `pagepocket/frontend/src/lib/auth/cookies.ts` + `pagepocket/frontend/src/proxy.ts` (or middleware equivalent)
- [x] 3.6 Harden the `/api/pp` refresh block: try/catch → definite 503/401, never write an empty `pp_refresh`, single-flight waiters not poisoned in `pagepocket/frontend/src/app/api/pp/[...path]/route.ts`
- [x] 3.7 Delete the dead `/api/session/refresh` route `pagepocket/frontend/src/app/api/session/refresh/route.ts` and remove all references
- [x] 3.8 Add global 401 handling (clear session + redirect `/login`, e.g. `QueryCache.onError`) in `pagepocket/frontend/src/lib/client-api.ts` + the providers file
- [x] 3.9 Reject backslash redirect bypass in `pagepocket/frontend/src/lib/auth/redirect.ts` (tests for `/\evil.com`)
- [ ] 3.10 Fetch viewer pages by id (drop `page_size: 50` + `.find()`) in `pagepocket/frontend/src/lib/api/archive.ts` + `pagepocket/frontend/src/components/app/page-viewer-shell.tsx`; iframe `src` uses the first-party proxy path
- [x] 3.11 Check delete-flow response status and surface errors (no UI removal on failure) in `pagepocket/frontend/src/components/app/page-viewer-shell.tsx`
- [x] 3.12 Add security headers + `poweredByHeader: false` (HSTS, `frame-ancestors 'none'`) in `pagepocket/frontend/next.config.ts`
- [x] 3.13 Add the `server-only` import guard to `pagepocket/frontend/src/lib/env.ts` (verify a client import fails `pnpm build`)
- [x] 3.14 Replace third-party favicon lookups with a first-party/local-fallback path in `pagepocket/frontend/src/components/app/page-card.tsx`

## 4. Cluster D — Ops proof & pipeline integrity

- [x] 4.1 Fix the restore drill: drop `--databases` from the dump in `pagepocket/scripts/prod/backup-mysql.sh`, explicitly `CREATE DATABASE $SCRATCH` + canary row asserted absent from source in `pagepocket/scripts/prod/restore-drill.sh` (execution stays deploy-gated — task 6.11)
- [x] 4.2 Bind deploys to the gated SHA: pass `DEPLOY_SHA=${{ github.sha }}` in `.github/workflows/deploy.yml` and `git reset --hard "$DEPLOY_SHA"` + `origin/pagepocket != DEPLOY_SHA` abort in `pagepocket/scripts/prod/deploy-*.sh`
- [x] 4.3 Gate the frontend deploy: `needs: [changes, ci-gate]` with a non-backend-conditioned gate in `.github/workflows/deploy.yml`
- [x] 4.4 Add `workflow_dispatch` to `.github/workflows/ci.yml` and extend path filters (both `ci.yml` + `deploy.yml`) for `pagepocket/scripts/prod/archive-maintenance/**`, `requirements-dev.txt`, `init.sql`
- [x] 4.5 Run the 7 skipped MySQL FULLTEXT/CJK tests: set `SEARCH_TEST_DB_URL` in the `test-integration` target of `pagepocket/Makefile` so `pagepocket/tests/test_search_integration.py` executes
- [x] 4.6 Isolate the integration stack (`-p pagepocket-it`, avoid prod project name + `down -v` footgun) in the `test-integration` target of `pagepocket/Makefile`
- [x] 4.7 Fix fresh-clone first run: network guard for `pagepocket_default` in `make dev`/`make build` in `pagepocket/Makefile`, create `pagepocket/.env.example`, and align the `cp .env.example .env` instructions in `pagepocket/README.md`
- [x] 4.8 Arm share-service prod config: `ENVIRONMENT=production` + public `BASE_URL` in `pagepocket/docker-compose.prod.yml` (arming + short-link verification deploy-gated — task 6.9)
- [x] 4.9 Add `pagepocket/.dockerignore` (certs/, .env, node_modules out of build context), rootless containers + pinned `python:3.12-slim` usage + `COPY shared/` after `pip install` layer order in the service `pagepocket/services/*/Dockerfile`s
- [x] 4.10 Fix the cache client: redact the passworded Redis URL in logs, add `socket_timeout`, remove the one-shot `_checked` latch in `pagepocket/shared/cache.py`
- [x] 4.11 CI hygiene: pip cache + `pnpm install --frozen-lockfile` for the extension job in `.github/workflows/ci.yml` and `.github/workflows/deploy.yml`
- [x] 4.12 Untrack `pagepocket/scripts/prod/archive-maintenance/__pycache__/loop.cpython-312.pyc` and ignore `__pycache__/` in `.gitignore`
- [x] 4.13 Add a compose-contract render test asserting the prod overlay contract (per-service env, scoped DB users, share `ENVIRONMENT`/`BASE_URL`) against `pagepocket/docker-compose.prod.yml` + `pagepocket/docker-compose.yml`
- [x] 4.14 Update docs/runbook drift: TRUSTED_PROXIES values, confinement + rotation runbooks, drill evidence steps in `pagepocket/README.md` and the ops runbook doc

## 5. Proto & stub regeneration + contract updates

- [x] 5.1 Reserve the removed field tags: `signed_url`/`url` in `pagepocket/proto/archive.proto` + `pagepocket/proto/share.proto`, `PageResponse.r2_key` (field 6) in `pagepocket/proto/archive.proto`
- [x] 5.2 Mark the ignored `plan` field (field 7) `[deprecated = true]` (or reserve it) in `pagepocket/proto/archive.proto`
- [x] 5.3 Correct the stale "empty for share-token access" comment in `pagepocket/proto/archive.proto` (ownership mandatory, no share-token bypass)
- [x] 5.4 Deduplicate `StatusResponse` into one canonical shared definition imported by all five protos (`pagepocket/proto/*.proto`), preserving the wire shape
- [x] 5.5 Regenerate all stubs with `make proto` and commit the output under `pagepocket/shared/proto_generated/`
- [x] 5.6 Add the CI stub-freshness guard (`make proto` + `git diff --exit-code -- pagepocket/shared/proto_generated`) to `.github/workflows/ci.yml`

## 6. Final verification, gates & deploy-gated checklist

- [x] 6.1 Extend the AST convention in `pagepocket/services/api-gateway/tests/test_grpc_transport.py` to fail on any sync stub call in an `async def` gateway handler not wrapped in `run_in_threadpool`, and run it
- [ ] 6.2 Run grep gates: no `library_db` in `pagepocket/services/search-service/**`; no `public, immutable` in `pagepocket/frontend/src/app/api/pp/[...path]/route.ts`; no `google.com/s2` in `pagepocket/frontend/src/**`; no `/api/session/refresh` references in `pagepocket/frontend/src/**`; no per-call channel construction in archive/library/share servicers
- [ ] 6.3 Verify presigned-URL removal completeness: no `signed_url`/`url` R2 fields in gateway view/share responses and no extension/frontend consumer (grep `pagepocket/extension/**`, `pagepocket/frontend/src/**`, `pagepocket/services/api-gateway/routers/**`)
- [ ] 6.4 Run the full test gates: `pnpm test` (in `pagepocket/frontend`), `make test`, `make test-integration` (in `pagepocket`), and `cd server && python3 -m pytest tests -q` — all green
- [ ] 6.5 Run `openspec validate --change "harden-pagepocket-platform"` until valid and confirm every spec scenario above has coverage in code or tests
- [ ] 6.6 Confirm no task above mutated production and that all prepared scripts (`pagepocket/scripts/prod/rotate-db-users.sh`, confinement overlay, drill fix) are un-executed locally
- [ ] 6.7 DEPLOY-GATED (user-ordered): execute per-service MySQL user rotation (`pagepocket/scripts/prod/rotate-db-users.sh`) + compose env cutover
- [ ] 6.8 DEPLOY-GATED (user-ordered): apply monolith network confinement and verify search/library/share unreachable, archive/auth reachable from the monolith container
- [ ] 6.9 DEPLOY-GATED (user-ordered): arm share-service `ENVIRONMENT=production`/`BASE_URL` and verify a prod `short_url` uses the public host
- [ ] 6.10 DEPLOY-GATED (user-ordered): roll out the narrowed `TRUSTED_PROXIES` (coordinated with nginx/Next addresses) and verify limiter bucketing behavior
- [ ] 6.11 DEPLOY-GATED (user-ordered): execute the fixed restore drill (`pagepocket/scripts/prod/restore-drill.sh`) and record the canary evidence in the runbook
