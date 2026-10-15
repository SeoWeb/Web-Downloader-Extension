## Why

A five-audit review (Oct 2026, findings verified with file:line) of both backends found four P0 issues: a quota-escalation bypass (client-controlled `plan` overrides the JWT claim on ingest, and the monolith cloud push never sends a plan so every cloud page is billed `free`), a stored-XSS → account-takeover chain (archived HTML is served raw on the `pagepocket.app` origin with only `<script>` stripped, no CSP, and a `allow-same-origin` iframe sandbox), zero MySQL backups for five production databases holding SaaS user data on a single host, and prod deploys that bypass CI entirely (deploy triggers on `pagepocket` with no test gate; CI runs only on `main`, which has diverged from `pagepocket`). Beyond the P0s, the audit found cross-user trust-boundary holes (share-link IDOR, a designed empty-`user_id` bypass, collection-metadata leak, unauthenticated `pagepocketUserId` trust on the monolith), user-visible pipeline corruption (the `filename_map` merge silently commits nothing so linked-page ZIPs are broken), a broken prod schema-management story (`create_all` disabled by mTLS flag, per-service Alembic invoked by nothing), missing gRPC message-size limits and deadlines, and zero executing tests for the API gateway plus six failing monolith unit tests.

## What Changes

**P0 — Security and survivability**
- Derive the billing plan exclusively from the JWT claim on both ingest paths (gateway REST form field is ignored; monolith cloud push sends the plan resolved server-side)
- Sandboxed serving of archived HTML: CSP sandbox headers on `/api/sc/*/f/*` and `/api/pp/archive/*/f/*`, sanitize inline event handlers and `javascript:` URIs at ingest, drop `allow-same-origin` from the viewer iframe
- Nightly MySQL backups for all five databases with off-host copy and a documented (and once-executed) restore procedure
- CI gates deploys: CI runs on both `main` and `pagepocket`, deploy requires green CI, the backend deploy job gains a post-deploy health check (mirroring the frontend curl gate), and migrations run in the deploy path

**P1 — Trust boundaries (pagepocket)**
- `CreateShareLink` verifies page ownership; `ValidateToken` resolves and returns the owner's `user_id`
- Ownership checks become mandatory everywhere: the empty-string `user_id` bypass in `GetPageContent`/`GetArchiveFile` and the share router's `user_id=""` call are removed
- `AddPageToCollection` verifies the page is owned by the caller before linking
- Ingest idempotency becomes user-scoped (`extension_job_id` + `user_id`), closing a cross-user page-shadowing leak

**P1 — Monolith pipeline correctness**
- Persist the `filename_map` merge (copy-before-assign or `flag_modified`) so linked-page downloads stop producing broken ZIPs
- Bind `options.pagepocketUserId` to the authenticated `X-API-Key` client identity via a server-side mapping; unauthenticated trust is removed
- Production schema management: one authoritative mechanism (`alembic upgrade head` in service entrypoints or the deploy step); `create_all` no longer silently disabled by the mTLS flag

**P1 — Transport and gateway hardening**
- Gateway gRPC channels get explicit max message sizes matching the archive service; size failures map to HTTP 413 (not the misleading 402)
- Every gateway→service gRPC call gets a deadline; `DEADLINE_EXCEEDED` maps to 503
- Multipart ingest body size is capped before buffering

**P1 — Tests and CI**
- API gateway integration tests actually execute (17 currently skip; Makefile `SERVICES` and CI compose omit the service)
- Monolith: fix the 6 failing `tests/test_session_lifecycle.py` tests and add a CI job for `server/`

**P2 — Hardening**
- Rate limiter moves to Redis keyed by `CF-Connecting-IP` (replacing the unbounded in-memory dict that blindly trusts the peer address behind a proxy)
- CORS pinned to explicit origins (was `*`); prod fails fast on default/dev `JWT_SECRET`
- Access tokens become short-lived (refresh flow already exists); 7-day non-revocable HS256 access tokens retired
- Double-finalize race serialized with `SELECT ... FOR UPDATE` (corrupt/orphan ZIPs)
- Gzip resources: validate inflated size before decompressing (gzip-bomb guard)
- Restart-during-upload no longer duplicates the first scroll chunk into the merged HTML

**P3 — Hygiene**
- `GetArchiveFile` traversal check hardening; registration abuse gate; API keys hashed at rest on the monolith; Redis auth/network segmentation; `BASE_URL` pinned for share short URLs; logging/observability baseline (no more silent exception swallowing); healthcheck for api-gateway; docs drift fixes (gateway port, JWT TTL, deploy-on-main, `.env.example`); Makefile cert-name drift fixed; stale jest refs, phantom e2e compose stack, and dead scripts removed

## Capabilities

### New Capabilities
- `cloud-push-authorization`: The `pagepocketUserId` authorization model — server-side binding of monolith API-key clients to PagePocket users, server-resolved plan on every push, and the removal of client-trusted user IDs
- `archived-html-serving`: Sandboxed delivery of archived HTML and assets on the `pagepocket.app` origin — CSP/sandbox header requirements, ingest-time sanitization, and viewer iframe restrictions
- `assembly-timeout-envelope`: The end-to-end assembly budget — client poll timeout vs. server push deadline, with the server-side push made fast/streamed so the envelope holds
- `extension-identity-lifecycle`: Session-scoped API-key storage, deadlock-free re-registration, and cleanup of orphaned clients/sessions after browser restarts
- `r2-orphan-reconciliation`: Ingest-time cleanup on failed ingests plus a periodic sweep so R2 objects never outlive their `pages` rows
- `deployment-routing`: The deployment and routing contract — which host fronts which backend, `X-Forwarded-*` requirements for server-built download URLs, CI-gated deploys with health checks, and one authoritative schema-migration mechanism
- `backend-backup-restore`: Nightly MySQL dumps for all five databases, off-host copy, and a documented restore procedure

### Modified Capabilities
- `pagepocket-api-gateway`: Plan comes from the JWT only; Redis-backed rate limiting keyed by proxy-forwarded client IP; pinned CORS origins; gRPC deadlines and message-size limits with 413/503 error mapping; capped multipart buffering; fail-fast on default secrets in prod
- `pagepocket-archive-service`: Mandatory ownership on every read (no empty-string bypass), user-scoped ingest idempotency, sanitization beyond `<script>` removal, hardened archive-path traversal check, plan accepted only from the authenticated request
- `pagepocket-auth-service`: Short-lived access tokens with the existing refresh flow; signing-secret hygiene (no dev fallback in prod)
- `pagepocket-library-service`: Page-ownership verification on collection membership writes
- `pagepocket-share-service`: Ownership-checked share creation and owner resolution at token validation
- `pagepocket-search-service`: Indexing failures are retried and surfaced — ingested pages can no longer become permanently unsearchable
- `pagepocket-ingest-rest`: The `plan` form field is removed from the contract; the JWT claim is the only plan source
- `pagepocket-proto-contracts`: Additive field additions (share owner resolution) are permitted with regenerated stubs in the same change
- `server-api`: Filename-map merges persist; `pagepocketUserId` is verified against the client identity; gzip size checked before decompression; finalize is race-safe; rate-limit numbers match the implementation; content-text append semantics documented
- `server-session-storage`: The cloud binding lives on the client record — session isolation and cloud identity share the same authenticated root
- `server-zip-assembly`: Cloud push carries the server-resolved plan; duplicate archive paths in ZIPs are deduplicated deterministically
- `server-html-merge`: A restart during upload no longer duplicates the first scroll chunk into the merged HTML
- `cloud-via-server`: The extension no longer dictates the cloud identity — the server binds sessions to the authenticated client; storage location corrected to `chrome.storage.session`
- `extension-server-client`: API-key storage in `chrome.storage.session` and re-registration that cannot deadlock when the stored instance id resolves to a revoked key
- `extension-cloud-auth`: Auth-state storage corrected to `chrome.storage.session` (session-scoped, not persistent)

## Impact

- **Code (pagepocket gateway/services)**: `services/api-gateway/routers/archive.py` (plan, body cap), `routers/share.py` (owner-resolved file access), `routers/__init__.py` (error mapping), `grpc_clients/__init__.py` (channel options, deadlines), `middleware/rate_limit.py` (Redis + CF header), `main.py` (CORS, secret check), `services/archive-service/servicer.py` (ownership, idempotency, traversal), `services/archive-service/page_processor.py` (sanitization), `services/share-service/servicer.py` (ownership, owner resolution), `services/library-service/servicer.py` (page ownership), `services/search-service` (retry), `shared/jwt_utils.py` (TTL), `shared/db.py` (create_all gating), `proto/` (additive ValidateToken field)
- **Code (monolith)**: `server/app/api/routes/sessions.py` (identity binding, finalize lock), `server/app/api/routes/resources.py` (filename map persistence, gzip guard), `server/app/services/archive_client.py` (plan propagation, streaming push), `server/app/services/zip_assembler.py` (path dedup), `server/app/services/html_merger.py` (skeleton reconstruction), `server/app/models/` (client→pagepocket-user mapping), `server/tests/` (fix 6 failures)
- **Frontend route handlers (in scope only)**: `pagepocket/frontend/src/app/api/sc/[token]/[...path]/route.ts` and the `/api/pp/archive/*/f/*` equivalent (CSP sandbox headers); `public-viewer-shell.tsx` iframe sandbox
- **Ops/infra**: `pagepocket/docker-compose*.yml`, `server/docker-compose.yml`, GitHub workflows (`.github/workflows/ci.yml`, `deploy.yml`), new backup job + restore runbook, Alembic invocation in entrypoints, Makefile cert targets, Redis hardening
- **Extension (minor)**: `src/background/server-client.ts` (re-registration, session-scoped keys), `src/background/server-download.ts` (assembly timeout), `src/background/pagepocket-client.ts` (drop direct user-id passthrough if required by the new binding)
- **Dependencies**: Redis becomes a hard runtime dependency of the gateway rate limiter (already deployed for cache); no new client-side dependencies
- **Breaking**: The `plan` form field on `POST /api/v1/archive/pages/ingest` is ignored/removed; client-supplied `pagepocketUserId` is rejected unless it matches the server-side client binding; 7-day access tokens shorten (clients already refresh on 401)
