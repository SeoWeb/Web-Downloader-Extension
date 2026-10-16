# Design — harden-pagepocket-platform

Findings source: 5-agent audit @ `4895059` (architecture, frontend, security-round-2, correctness, ops). Cross-agent-confirmed findings are marked **[×3]**/**[×2]**. All file:line references are at that commit.

## Decisions

### D1 — Gateway concurrency: threadpool + multi-worker, NOT grpc.aio (Cluster A, P0 **[×2]**)
Every router is `async def` calling sync gRPC stubs inline (e.g. `routers/archive.py:150-158`), freezing the single-worker event loop for up to 120 s per ingest; the compose healthcheck (5 s timeout) can be starved into restart loops. **Choice:** wrap every stub call in Starlette's `run_in_threadpool` (mechanical, per-call-site, verifiable by extending the `test_grpc_transport.py` AST convention to assert `run_in_threadpool` wrapping) and run uvicorn with `--workers 2-4` via env `GATEWAY_WORKERS` (default 2; limiter is Redis-backed so multi-worker is safe — that was task 4.5's point). `grpc.aio` migration is explicitly deferred (touches every stub + error semantics; follow-up change). Also extend the AnyIO threadpool default capacity or run ingest-class calls through a dedicated bounded executor so 120 s pushes can't exhaust the default 40-thread pool.

### D2 — Cumulative upload bound (Cluster A, P0)
`read_bounded` caps each multipart part at MAX_UPLOAD_BYTES but `ingest_page` sums html + N assets unbounded (`routers/archive.py:133-141`) against a 512 M container. **Choice:** accumulate a running counter across parts in the ingest route; when `html_bytes + Σ asset_bytes > max_upload_bytes()` → 413 immediately; also cap asset count (new env `MAX_INGEST_ASSETS`, default 200) and require a declared Content-Length for ingest (reject missing → 413/400). Chunked bodies with no length are rejected for ingest only.

### D3 — Client-IP derivation: rightmost-untrusted + peer-gated CF header (Cluster A, P1 **[×2]**)
`middleware/rate_limit.py:47-56` trusts `CF-Connecting-IP` unconditionally and takes the *leftmost* XFF entry; prod trusts `172.16.0.0/12` (whole bridge) so any in-docker peer "validates" a spoofed header → per-IP brute-force guard fully bypassed. **Choice (mirroring the monolith's correct implementation at `server/app/api/routes/auth.py:43-55`):** walk XFF right-to-left, skipping entries matching TRUSTED_PROXIES, take the first untrusted; honor `CF-Connecting-IP` only when the immediate peer is trusted AND no untrusted XFF entry exists beyond it. **Narrow the default TRUSTED_PROXIES** in compose from the whole bridge to the specific nginx/host + Next hop addresses (documented in runbook; env-overrideable). The Next.js server adds a helper that copies the inbound client IP (from nginx's `X-Forwarded-For` as seen by Next) into all five server→gateway fetch sites (`session`, `register`, `pp` proxy, `v1/auth` proxy, `http.ts`) as outbound `X-Forwarded-For`. Public share routes get a per-IP bucket (same 20/min class as auth).

### D4 — Presigned-URL removal from the REST contract (Cluster A/B boundary, **BREAKING**; P2 **[×2]**)
`GetPageContent` returns a 1 h presigned R2 URL served by `/archive/pages/{id}/view` and `/share/public/{token}` (`routers/share.py:96-106`, `archive-service/servicer.py:381-406`) — archived HTML reachable with no sandbox/CSP, bypassing all four hardened serving routes. Both auditors verified no current consumer (web app only validity-checks the URL at `(share)/s/[token]/page.tsx:18`). **Choice:** remove `url`/`signed_url` from both responses (proto response fields become reserved); the sandboxed `/f/*` proxies are the only delivery path. Gate the removal behind a verification task grepping the extension + frontend for consumers; keep R2 presigning internally where genuinely needed (none known). `PageResponse.r2_key` also removed (internal storage layout leak).

### D5 — Ingest idempotency: IntegrityError → re-select → return existing (Cluster B, P1)
Check-then-insert race at `archive-service/servicer.py:159-167` + unique index `(user_id, extension_job_id)`: concurrent retries (the new bounded-parallel push makes this realistic) → loser gets IntegrityError → gRPC UNKNOWN → HTTP 500 + full double R2 upload. **Choice:** catch IntegrityError at flush/commit, rollback, re-select by `(user_id, extension_job_id)`, return the existing `page_id` (idempotent success); clean up the loser's just-uploaded R2 prefix via the existing `_cleanup_failed_ingest` path. No schema change. Also validate `extension_job_id` length ≤ 36 / charset at the gateway (strict-mode truncation currently 500s).

### D6 — Delete ordering: commit first, R2 after, notify downstream (Cluster B, P1)
`DeletePage` deletes R2 objects inside the open DB transaction (`servicer.py:461-492`); crash between delete and commit = unrecoverable zombie page (no reverse sweep exists). **Choice:** tombstone-then-delete — commit row deletion + quota decrement first, then `delete_prefix`; leftovers become sweepable orphans (direction the sweep already handles). Add two small additive RPCs: `library.PurgePageLinks(page_id)` and `share.RevokeLinksForPage(page_id)` (best-effort, logged on failure) to kill collection count-vs-items drift and dangling share links. Fixes the drift found at `library-service/servicer.py:156-160`.

### D7 — Search-index fidelity: byte-safe truncation + R2-backed retry + atomic upsert (Cluster B, P1)
`body_text[:16*1024*1024]` slices chars not bytes (CJK → `Data too long` → permanent preview-only index via retry). **Choice:** single shared helper `truncate_utf8(text, limit_bytes=16*1024*1024 - 4096)` in `pagepocket/shared/` (encode → slice → `decode("utf-8", "ignore")`) used by archive before sending AND search before insert; search insert becomes `INSERT … ON DUPLICATE KEY UPDATE` (kills the upsert race); `RetryPendingIndexing` re-reads the page's HTML from R2 (authoritative) instead of re-indexing from the 500-char preview — no schema change needed. All archive→search/library RPCs get explicit deadlines (30 s class; `timeout=` audit extended to service-to-service calls), and the per-call channel/stub churn (`archive-service/servicer.py:51-72`, `library`, `share`) is replaced with the gateway's memoized-`grpc_clients` pattern.

### D8 — Library-outage semantics: fail 503, never silently empty (Cluster B, P1)
`archive-service/servicer.py:337-347` maps library RPC failure to `collection_page_ids = set()` → zero rows → **cached** empty result. **Choice:** on library failure during a collection-scoped list → surface `UNAVAILABLE` (gateway → 503 + Retry-After per D1's mapping), never cache; log truthfully. `ListCollectionPageIds` cache keys become `(user_id, collection_id)` (currently collection-only — ID-list leak across users, content-safe today only because archive re-filters).

### D9 — Rate-limit error taxonomy: structured details, strings as fallback (Cluster A, P1-fragility)
RESOURCE_EXHAUSTED → 402/413/429 mapping rests on English prose matching duplicated in gateway + monolith (`routers/__init__.py:16-34`, `server/app/services/archive_client.py:41-50`); unknown sources default to 402 Payment Required. **Choice:** archive-service sets a machine-readable prefix in gRPC details — `exhausted:quota`, `exhausted:size`, `exhausted:rate` (set alongside the human message, e.g. `"exhausted:quota|Monthly page limit reached"`); gateway parses the prefix first, falls back to legacy string markers (which stay for the monolith), logs when the fallback fires. Shared marker constants live in `pagepocket/shared/` so gateway and archive import one source.

### D10 — Session UX: outlive-the-token cookie + single refresh primitive (Cluster C, P2)
`pp_access` expires with the 1 h access token (`cookies.ts:34`) → browser deletes it → `proxy.ts` hard-redirects despite valid 30 d refresh; RSC deep-links 404. **Choice:** `pp_access` becomes a 30-day cookie (value-TTL is enforced by the gateway on every use — cookie lifetime is transport only); `proxy.ts` treats `pp_refresh` presence as pass-worthy. The `/api/pp` refresh block gets try/catch (network/parse errors → 503/401, single-flight waiters not poisoned by a raw 500), never writes an empty `pp_refresh` (`?? ""` at `route.ts:201`), and the dead `/api/session/refresh` route (zero callers; racing it trips reuse-detection → global logout) is deleted. Global 401: `QueryCache.onError` → clear + redirect to `/login`. Redirect validation rejects `\` (open-redirect bypass at `redirect.ts:3`).

### D11 — Proxy contract hardening (Cluster C, P1/P2)
`/api/pp`: force `Cache-Control: private` (preserving max-age) on file responses in `proxyResponse` — cookie-authenticated `public, immutable` behind Cloudflare is a cross-user cache-serve risk; reject any composed path not matching `^/api/v1/(archive|library|search|share|auth)/` after normalization (kills the `..` prefix-escape relay to `/docs`/`openapi.json`); forward `Range`/`Accept`/`If-None-Match`/`If-Modified-Since`/caller `Content-Type`; stream bodies both directions. `/api/sc`: stream like `/api/pp` (256 MB `arrayBuffer()` today), same segment validation on the token. Viewer delete flow checks status and surfaces errors.

### D12 — Service boundaries: least-privilege DB users + RPC instead of cross-DB SQL (Cluster B, P0)
`search-service/servicer.py:92-97` embeds raw SQL into `library_db.page_collections`; all services connect as root to one MySQL — boundaries are conventional only. **Choice:** (1) search uses the existing `library.ListCollectionPageIds` RPC (already memoizable, already used by archive) — no new RPC; add `AND user_id = :uid` scoping to the collection filter semantics at the library RPC level. (2) `init.sql` + a new deploy-gated `scripts/prod/rotate-db-users.sh` create per-service MySQL users (`pagepocket_archive`@`%` → archive_db only, etc.); services' `DB_URL`s gain per-service credentials via compose env (dev falls back to root for convenience, prod overlay requires the scoped users). (3) Monolith network confinement: prod overlay moves the monolith's attachment so it can reach only `archive-service` + `auth-service` (compose network/alias plumbing + iptables-free — docker network policy per docs; deploy-gated, runbook-documented). No splitting of the MySQL instance in this change (noted as future).

### D13 — Ops proof: drill safety, SHA pinning, frontend gate (Cluster D, P1)
- **Restore drill** (`scripts/prod/backup-mysql.sh:149` + `restore-drill.sh:110`): `--databases` embeds `USE auth_db` which overrides the scratch-DB target — the drill can never succeed, and pre-creating the scratch DB (the obvious naive fix) would restore into the live DB. Fix: drop `--databases`; drill explicitly `CREATE DATABASE $SCRATCH`; add a canary row written into `SCRATCH` post-restore and asserted to NOT exist in the source DB. Drill stays deploy-gated.
- **SHA pinning:** deploy.yml passes `DEPLOY_SHA=${{ github.sha }}` into both SSH scripts; scripts `git reset --hard "$DEPLOY_SHA"` and fail if `origin/pagepocket != DEPLOY_SHA` (queue-race → re-run). Add `workflow_dispatch` to ci.yml (the gate's failure message currently tells you to do something impossible).
- **Frontend gate:** `deploy-frontend` gets `needs: [changes, ci-gate]` with a non-backend-conditioned gate.
- **Search integration floor:** `make test-integration` sets `SEARCH_TEST_DB_URL` against the stack MySQL it just booted, running the 7 skipped FULLTEXT/CJK tests.
- **Stub freshness:** CI step `git diff --exit-code -- pagepocket/shared/proto_generated` after `make proto`.

### D14 — Scope guards (what this change deliberately does NOT do)
- **No extension code changes** — verification tasks only (presigned-URL consumer grep). The extension's dead direct-ingest path (`pagepocket-client.ts:306-383`, 404-in-prod) is recorded as a follow-up.
- **No grpc.aio, no chunked ingest proto** — deferred (chunked ingest is already the documented follow-up in `harden-backend-security-and-ops/design.md`).
- **No per-service client certs / CN→RPC interceptor** — the network confinement (D12) is this change's monolith-blast-radius answer; cert-level authz is a follow-up.
- **No sanitizer rewrite** — the bs4 mXSS residuals (P3) stand behind the CSP sandbox; noted as follow-up with the presigned-URL removal shrinking the surface to the four sandboxed routes only.
- **Prod mutations stay deploy-gated** per the established convention: DB-user rotation, network confinement, share-service `ENVIRONMENT` arming (see below) are prepared + runbook-documented, executed only on user-ordered deploy.

## Live-verification notes (all resolved locally — no spike needed)

- (a) Share-service prod overlay lacks `ENVIRONMENT=production` (`docker-compose.prod.yml:103-117`) → its BASE_URL fail-fast is dead code; prod share links currently point at the compose-default `http://localhost:8090`. Fix is overlay-only; effect visible only in prod → deploy-gated verification step in runbook.
- (b) `make test-integration` uses project name `pagepocket` (same as prod) and ends `down -v` — volume-wipe footgun. Fix: dedicated `-p pagepocket-it` project/network for integration runs.
- (c) `pagepocket_default` is `external: true` but only `test-integration` creates it → `make dev` fails on fresh clone. Fix: network guard in `make dev`/`make build`.
- (d) Redis URL (with password) logged at startup (`shared/cache.py:30`) → redact. Also give the cache client a `socket_timeout` and remove the one-shot `_checked` latch (boot-blip permanently disables caching today).
- (e) Quota row lock (`FOR UPDATE`) is held across the parallel R2 upload phase (`servicer.py:187→252-257`) → second concurrent ingest of the same user can hit 50 s lock-wait timeout. Fix: reserve in a short transaction, re-check+commit after upload completes (reserve-then-confirm).
- (f) R2 error classification (`servicer.py:450-458`): any R2 exception → NOT_FOUND → gateway's `assets/` fallback double-fetches and tells clients "file not found" during R2 rate-limit storms. Classify: `NoSuchKey/404` → NOT_FOUND; `SlowDown/503/ServiceUnavailable` → UNAVAILABLE.

## Ops actions requiring user-ordered deploy (prepared now, executed later)

1. Per-service MySQL user rotation (`scripts/prod/rotate-db-users.sh`) + compose env cutover.
2. Monolith network confinement apply + verification.
3. Share-service `ENVIRONMENT=production`/`BASE_URL` arming + short-link verification.
4. Restore drill execution (post-D13-fix) + evidence recorded.
5. Narrowed TRUSTED_PROXIES rollout (coordinate with nginx/Next addresses) + limiter-behavior verification.

## Open questions / follow-ups recorded

- Boot-race knowledge (fixed in-wave): MySQL's `mysqladmin ping -h localhost` healthcheck can pass during the entrypoint's socket-only init phase → services raced TCP readiness (fixed via bounded connect-retry in `shared/db.py`, pymysql-2002/2003-only, bad creds still fail fast). Deploy-day option: switch healthchecks to `healthcheck.sh --connect` (audit P3-8).

- grpc.aio migration for the gateway.
- Chunked-ingest RPC (carried from `harden-backend-security-and-ops`).
- Per-service mTLS client certs + CN→RPC allow-list interceptor.
- Extension: delete/feature-flag the dead direct `ingestPage` path; runtime endpoint discovery (build-time `PAGEPOCKET_URL`).
- Sanitizer mXSS hardening (noscript/template re-parse classes).
- MySQL instance splitting / per-service DB hosts (unlocked by D12).
- `view_count` Redis-counter flush cadence analytics (D-detail: dedupe first, dashboard later).
