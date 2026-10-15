## Context

Two backends serve the extension. `server/` is the legacy FastAPI monolith (:8000) that owns the live download pipeline (sessions → HTML chunks → resources → finalize → ZIP assembly → download) and pushes finished pages into PagePocket via gRPC mTLS. `pagepocket/` is the SaaS platform: a FastAPI gateway (:8090) fronting five gRPC services (auth, archive, library, search, share) over five MySQL databases, Redis (cache-only), and Cloudflare R2. The archived-HTML serving route lives in the Next.js frontend's route handlers (`/api/sc/*`), which proxy the gateway — that route is in scope; the rest of the frontend is not.

The Oct 2026 audits (5 parallel passes, all findings verified with file:line) found, at P0: a quota-escalation bypass (`pagepocket/services/api-gateway/routers/archive.py:115,136` accepts a client-controlled `plan` form field; `server/app/services/archive_client.py:118-125` never sends a plan at all), a stored-XSS → account-takeover chain (`page_processor.py:83-84` strips only `<script>`; the serving route sets no CSP; the viewer iframe sandbox includes `allow-same-origin`), zero MySQL backups, and prod deploys that bypass CI (`deploy.yml` on `pagepocket` with no gate; `ci.yml` only on `main`, which has diverged 1↔4 commits). P1 findings span trust boundaries (share-link IDOR, a designed empty-`user_id` ownership bypass, collection metadata leak, unauthenticated `pagepocketUserId` trust, non-user-scoped ingest idempotency), monolith correctness (the `filename_map` merge commits nothing — unit-reproduced; prod schema management disabled by the mTLS flag; per-service Alembic invoked by nothing), transport (4 MB default gRPC message limit vs 256 MB server limit surfacing as misleading HTTP 402; zero deadlines anywhere), and tests (gateway: 17 integration tests that always skip; monolith: 6 failing unit tests, no CI job). P2/P3 cover rate limiting, CORS, secrets, races, gzip bombs, orphaned R2 objects, swallowed search-index errors, the assembly timeout mismatch (client 5 min vs server worst case ~30 min), browser-restart identity orphans, and docs/Makefile drift.

## Goals / Non-Goals

**Goals:**
- Close all four P0s: plan integrity, archived-HTML sandboxing, backups, CI-gated deploys.
- Make ownership checks mandatory on every cross-identity read/write in pagepocket services.
- Make the monolith pipeline correct (filename map, finalize race, restart duplication) and bound (gzip, buffering, timeouts).
- One authoritative schema-management mechanism and CI-gated, health-checked deploys.
- Both backends actually tested in CI: gateway tests execute; monolith tests pass.
- Specs reconciled with implemented behavior (archive-relative rewrite, rate-limit numbers, `chrome.storage.session`).

**Non-Goals:**
- No migration of the monolith into pagepocket services (architectural question deliberately deferred — see D15).
- No rewrite of the auth system (stay with HS256 + refresh rotation; only TTL/secret-hygiene change — see D5).
- No frontend work beyond the two archived-HTML serving route handlers and the viewer iframe attribute.
- No multi-host MySQL HA story; backups + documented restore are the deliverable, not replication.
- No new auth for the extension↔monolith protocol beyond the client-identity binding (no per-request signatures).

## Live Verification Spike (Task 1 — findings recorded here)

Task 1 is a **read-only verification spike** against production (`ssh -o BatchMode=yes siim@185.213.25.5 '<cmd>'`). It is blocked by nothing and MUST complete before tasks that depend on prod topology (deploy gating, backups, migrations, routing contract, cert rotation). Findings are recorded in this section by Task 1.

| # | Question | Method | Finding |
|---|---|---|---|
| a | What fronts `server.pagepocket.app` — the monolith :8000 or the gateway :8090? (Determines whether the extension contract is served directly and where `X-Forwarded-*` must be trusted.) | `curl -sI https://server.pagepocket.app/api/v1/health` from the host; inspect Caddy/Nginx/Cloudflare config and `ss -tlnp` | _recorded by Task 1_ |
| b | mTLS cert expiry — repo copies of `certs/*.pem` are dated June 2025 with 365-day validity, so they may already be expired (~June 2026) | `openssl x509 -enddate -noout -in <cert>` for ca/server/client certs, on host and in repo | _recorded by Task 1_ |
| c | Is monolith MySQL :33060 host-exposed? | `ss -tlnp \| grep 33060` on host; external probe of the port | _recorded by Task 1_ |
| d | Does prod `JWT_SECRET` differ from the dev default in compose? | inspect the prod compose/env on the host (value comparison only, never paste the secret into the repo) | _recorded by Task 1_ |
| e | Has Alembic ever run in prod / do the expected tables and `alembic_version` rows exist in all five DBs? | `docker exec <mysql> mysql -e 'SHOW TABLES FROM archive_db; SELECT * FROM archive_db.alembic_version;'` etc. | _recorded by Task 1_ |
| f | Does the monolith container run, and how is it deployed (systemd unit? hand-run compose? restart-prod.sh?) | `systemctl list-units \| grep -i pagepocket`, `docker ps`, crontab -l, read `restart-prod.sh` on host | _recorded by Task 1_ |

Rule: the spike is read-only; if any check cannot be completed, the blocker and workaround are recorded in the table and the dependent tasks re-order rather than guess.

## Decisions

### D1. One change for both backends
All findings land in a single change. The P0 chain (plan bypass) and the timeout envelope (D10) cross the monolith↔pagepocket boundary; splitting them would leave half-fixed trust boundaries that are worse than either half alone. Task grouping inside `tasks.md` keeps the two backends' work streams separable for review and revert.
*Why not two changes?* The brief's findings are interdependent (e.g., the monolith push fix requires the same proto/verification work as the gateway plan fix); sequencing two changes would serialize on the same files.

### D2. Bake the live checks in as a verification spike
Production topology questions (which host fronts the monolith, cert expiry, exposed ports, secret state, migration state, deploy mechanism) gate several fixes but cannot be answered from the repo. Task 1 is a read-only SSH spike whose findings are written into this file (table above) before dependent tasks proceed. Nothing in the spike mutates prod.

### D3. Ownership checks become mandatory — the empty-string bypass is removed
`archive-service/servicer.py` (`GetPageContent`, `GetArchiveFile`) currently treats an empty `request.user_id` as "skip the ownership check" (`if not page or (request.user_id and ...)`), and the gateway's public share route exploits exactly that (`routers/share.py:107` passes `user_id=""`). The rule becomes: **every** read of a page requires a non-empty `user_id` that owns the row; an empty `user_id` is `INVALID_ARGUMENT`, never a wildcard. The share path resolves the owner at `ValidateToken` (additive `owner_user_id` field in the response, proto change per D9) and passes it downstream. `CreateShareLink` and `AddPageToCollection` gain the same mandatory page-ownership check. NOT_FOUND semantics are preserved (no existence leaks).
*Alternative considered:* an internal-only "service token" authorizing the share path — rejected: it reintroduces a bypass-shaped credential for exactly the flow that was abused.

### D4. `pagepocketUserId` becomes a server-side binding, not a client hint
The monolith keeps its `clients.pagepocket_user_id` column but it is written only by a new authenticated binding flow: `POST /api/v1/cloud/link` (X-API-Key authenticated) carrying the user's PagePocket access token, which the monolith verifies via `AuthService.Verify` and stores the resulting `user_id` (and plan) on the client row. `POST /api/v1/sessions` ignores/validates `options.pagepocketUserId` against the binding (mismatch → 403); the push path (`archive_client.py`) fills `user_id` and `plan` exclusively from the binding. The extension change is small: call link once at PagePocket login instead of passing the user id per session.
*Alternative considered:* HMAC-signing the user id with a monolith↔extension shared secret — rejected: the extension's secrets are extractable; a server-side binding verified against the auth service is strictly stronger and simpler.

### D5. Auth stays as-is except TTL and secret hygiene
No token-format rewrite, no revocation list, no new token type. Changes: access-token TTL drops from 7 days (`shared/jwt_utils.py:10`) to the spec's 1 hour (the refresh flow and rotation already exist and clients already handle 401→refresh); prod fails fast when `JWT_SECRET` is unset or matches the known dev default; logout semantics unchanged. Short access tokens make the stateless-JWT trade-off (logout doesn't revoke access tokens) acceptable.

### D6. Archived HTML is sandboxed in depth (sanitize + headers + iframe)
Three independent layers, so no single miss reintroduces the XSS chain:
1. **Ingest sanitization** (`page_processor.py`): keep `<script>` stripping; additionally remove `on*` event-handler attributes and neutralize `javascript:`/`data:text/html` URIs in `href`/`src`/`action`/`formaction`/`xlink:href` (rewrite to `#` or drop the attribute).
2. **Serving headers**: the gateway file route and the frontend proxy routes (`/api/sc/[token]/[...path]`, `/api/pp/archive/*/f/*`) set `Content-Security-Policy: sandbox allow-popups allow-forms` — the CSP sandbox deliberately **excludes `allow-same-origin`** — plus `X-Content-Type-Options: nosniff` and a pinned `Content-Type` (HTML only on the index route; assets served with their stored content type). HTML responses also get `Referrer-Policy: no-referrer`.
3. **Viewer iframe**: `IFRAME_SANDBOX` drops `allow-same-origin` (`public-viewer-shell.tsx`).
*Spec correction:* the existing `pagepocket-archive-service` spec claims HTML is rewritten to absolute `/r2/...` paths; the delta corrects this to archive-relative rewriting + sanitization, which is what both code paths do and what the sandbox requires.

### D7. Backups: nightly dump, off-host copy, restore procedure
A scheduled job (host cron or a dedicated container) runs `mysqldump --single-transaction --all-databases` (per-DB files for the five schemas), gzip-compresses, encrypts with age/openssl using a key stored off the DB host, and copies to off-host storage (second disk or object storage) with 14-day retention. A restore runbook (`docs/`) documents the exact commands; Task executes one restore drill into a scratch database to prove it. Backup success/failure emits a log line and a healthcheck-visible marker file so "silently stopped backups" is detectable.

### D8. CI gates deploys; migrations run in the deploy path
`ci.yml` triggers on both `main` and `pagepocket` (paths-filter fixed, stale `jest.config.cjs` references removed). `deploy.yml` gains a `needs`/`workflow_run`-style gate on green CI for the same SHA — a deploy never runs untested code again. The backend deploy job adds a post-deploy health check mirroring the frontend's curl gate (`/api/v1/health` on :8090, retry window, non-zero exit on failure). Migrations: the deploy step runs `alembic upgrade head` for each service (image already contains the alembic dirs; the entrypoint no longer calls `create_all` when migrations are managed — see D14's authoritative-mechanism decision: **deploy-step Alembic is the single mechanism**; `Base.metadata.create_all` remains dev/test-only via an explicit `AUTO_CREATE` env, decoupled from `MTLS_ENABLED`).

### D9. Proto changes are additive only
`ValidateShareResponse.owner_user_id` (D3) and `VerifyResponse.plan` (used by the binding in D4) are additive fields; both services regenerate stubs in the same change (`pagepocket-proto-contracts` delta permits additive additions). No wire-incompatible change; monolith and pagepocket deploy order is therefore unconstrained for these fields (unknown fields are ignored by older readers).

### D10. Assembly timeout envelope: size the client to the server, then shrink the server
Today the client polls for 5 minutes while the server's worst case is ~30 minutes (3 sequential 600 s gRPC calls + queueing) — guaranteed false failures. The envelope becomes explicit: server push budget = 3 × 600 s + 120 s queueing = 32 min worst case, target ≤ 10 min p95; client `ASSEMBLY_TIMEOUT_MS` raised to 35 min with the existing adaptive poll intervals. To pull the server side down, `archive_client.push_to_archive` uploads assets in parallel batches (bounded concurrency, each batch well under the message-size limit) instead of one giant unary call. A true streaming ingest RPC was considered and rejected for this change: it is a wire-protocol change requiring atomic dual-backend upgrades, for a benefit the batched path already delivers.

### D11. Gateway gRPC hardening: sizes, deadlines, honest status codes
Channels get `max_send_message_length`/`max_receive_message_length` = 256 MB (matching `archive-service/main.py`), so large ingests no longer die client-side at 4 MB. Every stub call passes an explicit `timeout=` (per-RPC constants; ingest/push-class calls get a larger budget than metadata calls). Error mapping (`routers/__init__.py`): `DEADLINE_EXCEEDED` → 503 with `Retry-After`, `RESOURCE_EXHAUSTED` carrying a message-size detail → 413 (quota exhaustion keeps 402, rate keeps 429). The ingest route enforces a request body cap (content-length + stream bounds) so a single upload cannot buffer unboundedly in RAM.

### D12. Rate limiting moves to Redis; client IP from the proxy header
The in-memory dict is replaced by a Redis fixed-window/token-bucket counter (`INCR`+`EXPIRE`), keyed by `user_id` for authenticated routes and by `CF-Connecting-IP` (falling back to `X-Forwarded-For` rightmost-trusted, then peer addr) for unauthenticated routes — behind Cloudflare the peer address is the edge, which today turns the auth bucket into a global DoS tripwire. Unbounded-key growth is bounded by short EXPIRE. If Redis is unavailable the limiter fails **open** with an error log (availability over strictness), and the gateway healthcheck reports the limiter state.

### D13. Monolith correctness fixes (user-visible)
- **Filename map**: `dict(existing_map)` copy before `update()` (or `flag_modified`) — the SQLAlchemy same-object assign commits nothing, silently breaking linked-page ZIPs; regression test from the unit repro.
- **Finalize race**: the status transition reads the session row `WITH FOR UPDATE` so a double-finalize cannot start two assemblies (corrupt/orphan ZIPs).
- **Restart duplication**: skeleton reconstruction (`html_merger.py`) marks the first chunk as consumed when it is promoted to skeleton, so a restart during upload no longer duplicates the first scroll chunk into the merged HTML.
- **Gzip bomb**: validate inflated size **before** decompression — read with a bounded cap (min of remaining session budget and a hard per-resource ceiling) and reject 413 when exceeded.

### D14. Identity lifecycle for the extension
Keys stay in `chrome.storage.session` (browser-restart orphaning is the accepted trade-off from the previous change — it is the privacy-preserving choice), but the failure modes are fixed: (1) when a stored instance id resolves to a revoked key, re-registration mints a **fresh** instance id instead of retrying the doomed one (no deadlock, `server-client.ts:767-813`); (2) the monolith gains a cleanup pass that deletes clients with no sessions and no successful auth for > N days, and expired sessions of dead clients are reaped by the existing expiry cron. Documented behavior: browser restart ⇒ new identity ⇒ old sessions 403 ⇒ re-register transparently.

### D15. The monolith stays a monolith (for now)
Migrating `server/` into pagepocket services (or vice versa) is an architectural question that this change deliberately does not answer. All fixes here are local to each backend plus the two contract points (plan/identity binding, timeout envelope) that must move together. A follow-up change can revisit consolidation once the trust boundaries hold.

### D16. P3 hygiene batch
GetArchiveFile rejects any path containing `..` segments after `posixpath.normpath` (currently neutralized by R2's flat namespace, hardened anyway); registration keeps its rate limit but the limiter now actually works per real client IP (D12) and per-instance-id; monolith API keys stored as SHA-256 hashes (lookup by hash; existing keys migrated lazily or force re-register — migration stores a hash alongside, verification prefers hash); Redis gets a password and stays on the internal compose network; `BASE_URL` becomes required (no localhost default) so share short URLs are correct in prod; logging gets a real config (structured, request IDs) and the blanket ruff exception ignores that hide failures are removed; api-gateway gets a compose healthcheck like the other services.

## Risks / Trade-offs

- **[D3 mandatory ownership]** Any internal caller still passing `user_id=""` breaks loudly. → Mitigation: grep-audit all call sites in the same task; the only known caller is the share route, migrated in the same commit; the spike's routing finding (a) confirms no other consumer exists.
- **[D4 identity binding]** Extension versions that still send `options.pagepocketUserId` without linking will 403. → Mitigation: the binding call is added in the same release; server accepts a match between sent id and binding (grace path) so in-flight sessions survive the upgrade window.
- **[D5 short access tokens]** Clients that never implemented refresh would log users out hourly. → Mitigation: both known clients (frontend, extension) already refresh on 401; the extension's refresh flow is spec'd in `extension-cloud-auth`.
- **[D7 backups]** `--single-transaction` dumps can degrade under heavy write load. → Mitigation: nightly off-peak schedule; dump duration logged; restore drill validates usefulness, not just presence.
- **[D8 deploy gate]** `pagepocket` deploys now block on CI — if CI is red, hotfixes stall. → Mitigation: CI on the deploy branch runs the same fast suite (no new long jobs); failing health check auto-notifies with rollback instructions (previous image tag retained).
- **[D8 Alembic in deploy]** First prod run on DBs created by `create_all` may race existing schema. → Mitigation: spike finding (e) establishes whether `alembic_version` exists; if not, a one-time `alembic stamp head` (after diff-verification) precedes the first upgrade; recorded in the runbook.
- **[D10 longer client timeout]** A genuinely hung assembly now holds the panel up to 35 min. → Mitigation: server-side phase timestamps in the status endpoint let the client distinguish "progressing" from "stuck"; the client surfaces elapsed time.
- **[D11 message-size raise]** 256 MB gateway buffering overlaps the RAM-buffer concern. → Mitigation: the ingest body cap (D11) bounds what the gateway accepts regardless of the gRPC limit.
- **[D12 Redis dependency]** Rate limiting now fails open if Redis dies. → Mitigation: Redis gets auth + healthcheck + alert; fail-open is a deliberate availability choice, logged loudly.
- **[One big change]** Review surface is large. → Mitigation: tasks are grouped into independently revertible commits per group; each group carries its own tests.

## Migration Plan

1. **Spike (Task 1)** — record findings in this file; no code changes.
2. **Trust boundaries (pagepocket)** — ownership enforcement + share owner resolution + proto additive fields + plan-from-JWT; gateway tests un-skipped and green before merge.
3. **Monolith pipeline correctness** — filename map, finalize lock, gzip cap, skeleton dedup, identity binding + push plan; fix the 6 failing tests.
4. **Transport/gateway hardening** — channel options, deadlines, error mapping, body cap, Redis rate limiter, CORS pinning, secret fail-fast.
5. **Ops** — Alembic-in-deploy (+ one-time stamp if spike says so), backups + restore drill, CI on both branches, deploy gate + health check, Makefile cert names, Redis auth.
6. **Timeout envelope + identity lifecycle** — client timeout raise, batched parallel push, re-registration fix, orphan cleanup.
7. **Docs/spec reconciliation + P3 batch** — README/env drift, sanitization + sandbox headers (P0-2 lands here with its own tests), traversal hardening, dead-code removal.
8. **Final verification** — full suites both backends, `openspec validate`, manual sandbox/XSS smoke, restore-drill evidence link.

Rollback: each group is a normal revert; no data migration exists except the Alembic stamp (documented in the runbook) and lazy API-key hashing (old plaintext keys keep working until rotated).

## Open Questions

- If spike (a) shows the gateway fronts the extension contract today, does the monolith keep a public ingress at all, or does it become internal-only behind the binding flow?
- Backup target: second disk on the same host is not a real off-host copy — is there an existing off-site target (R2 bucket / another machine) the runbook should standardize on?
- Should revoked-key re-registration (D14) notify the user (a "your browser was re-registered" state) or stay fully silent?
- API-key hashing cutover: lazy dual-write vs. one-time force re-register for all clients (chosen: lazy; revisit if the spike shows very few active clients).
