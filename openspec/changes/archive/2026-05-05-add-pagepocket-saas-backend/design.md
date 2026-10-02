## Context

WebsiteDownloader today consists of a browser extension plus a single Python "extension server" that merges HTML, assembles ZIPs, and serves local downloads (capabilities: `server-api`, `server-html-merge`, `server-zip-assembly`, `server-session-storage`, etc.). There is no concept of a user account, no cloud library, no search, and no sharing. PagePocket is the SaaS evolution: users should be able to capture pages in the extension and later browse, search, organise, and share them from a web UI.

The existing extension server is a single monolith tightly coupled to the capture flow. Rather than fold SaaS features into that monolith (auth, billing, search, sharing, collections), this change introduces a separate backend workspace (`pagepocket/`) composed of six focused services behind a single public REST gateway, with internal communication over gRPC. The extension server remains authoritative for *local* captures and gains a single outbound gRPC call to the Archive Service to mirror finalised pages to the cloud.

Key constraints:
- Python 3.12 across the backend (consistent with the existing server's toolchain).
- MySQL 8.0 for all persistence (team familiarity, existing ops knowledge, `ngram` FULLTEXT covers v1 search).
- Cloudflare R2 for object storage (S3-compatible API, no egress fees — critical because stored pages are re-served to users).
- Docker Compose is the deployable target for this change; Kubernetes is a follow-up.
- The browser extension itself is NOT modified in this change.

## Goals / Non-Goals

**Goals:**
- Define a clean six-service decomposition where each service owns exactly one concern and one MySQL schema.
- Make `ArchiveService.IngestPage` the single point of entry from the extension server into the cloud, with idempotency and mTLS.
- Establish a reproducible proto → generated-stub pipeline so schema changes cannot drift between services.
- Enforce per-plan quotas at ingest time, before any R2 bytes are written.
- Keep R2 buckets private; all viewer access is via short-lived presigned URLs.
- Provide a local-first developer experience: `make proto && docker compose up` should spin up the whole stack against a local MySQL.
- Ensure local extension-server downloads continue to work even if the cloud push fails or is disabled.

**Non-Goals:**
- Frontend (Next.js/React) application — out of scope; gateway contract is the boundary.
- Stripe billing, plan upgrade/downgrade flow — schema carries `plan`, but enforcement in billing is deferred.
- AI summarisation, annotations/highlights, citation generator, page-change monitoring, Notion/Obsidian export — Phase 5 in the original plan, not in this change.
- Kubernetes manifests, Prometheus, Grafana, OpenTelemetry, structured logging hardening, load testing — Phase 4 follow-ups.
- Modifying browser-extension behaviour or any existing extension-side capability.
- Private (authenticated-viewer) share tokens — schema supports `is_public=false`, but the validation path is public-only in this change.

## Decisions

### D1. Six services, not one

The alternative is a single "pagepocket-api" monolith. We chose six services because:
- Each service has a distinct scaling profile (archive-service is CPU-heavy during ingest; search-service is memory/IO-bound; auth-service is bursty during login peaks).
- Quotas and R2 credentials stay isolated to archive-service only — the rest of the system cannot accidentally read or write user bytes.
- A future team can own `search-service` independently (e.g. swap MySQL FULLTEXT for Meilisearch/OpenSearch) without touching other services.

Cost: higher ops overhead in dev. Mitigation: shared Python base image, identical Dockerfile template, shared `R2Client`/`db`/`jwt_utils` modules.

### D2. gRPC internally, REST at the edge

gRPC gives us strongly-typed contracts with codegen and cheap streaming for future features (e.g. streaming search results). REST/JSON at the edge avoids forcing gRPC-web onto browsers and keeps the public API diffable.

Alternative considered: REST everywhere. Rejected because contract drift between services is much more likely with ad-hoc JSON, and we would still need a schema system (OpenAPI) — protobuf is simpler and faster.

### D3. Schema-per-service, shared MySQL instance (for now)

Each service owns its own schema (`auth_db`, `archive_db`, ...), but all schemas share a single MySQL container in dev and a single logical MySQL instance in prod. This gives us logical isolation without the ops cost of five databases in dev.

Cross-schema joins are explicitly allowed in exactly one place: `search-service` may join to `library_db.page_collections` to implement collection-filtered search. We accept this narrow coupling as a pragmatic v1 choice; it is cleanly replaceable with a future `PageInCollection` gRPC lookup on `library-service` if the schemas ever need to split to separate hosts.

Alternative considered: physically separate MySQL instances. Rejected for v1 due to infra overhead; schemas can be peeled off to their own instances later without code changes.

### D4. Idempotency by `extension_job_id`

`IngestPage` takes an `extension_job_id` (the extension server's session UUID) and the `archive_db.pages` table UNIQUE-constrains it. This means:
- The extension server can retry `IngestPage` safely on any transient gRPC failure.
- A finalised session that was already mirrored to the cloud will never produce a duplicate page row or duplicate R2 objects on retry.

The archive service returns `success=true, page_id=<existing>` on replay — indistinguishable from first-ingest success for the caller.

### D5. Asset rewrite inside `IngestPage`, not in the extension server

The extension server sends the *original* HTML and the list of assets; the archive service is responsible for (a) uploading assets to R2, (b) rewriting `<img src>` / `<link href>` / etc. to R2-relative paths, (c) uploading the rewritten HTML. This keeps rewrite logic in one place and means future R2 layout changes (e.g. adding a CDN origin prefix) don't require extension-server changes.

Cost: archive service holds the full HTML + all assets in memory during rewrite. Mitigation: `IngestPage` has a generous gRPC message size limit (128 MB) and a per-user quota cap well below that; very large pages were always handled by the local flow first and stayed local.

### D6. Presigned URLs, not proxying

Viewer reads presigned R2 GET URLs directly from R2 (3600s expiry). The API gateway never proxies page bytes. Rationale: R2 has no egress fees, so letting the browser fetch directly is free and fast; proxying would add CPU and latency and force the gateway to be scaled for page-view traffic.

Trade-off: presigned URLs leak the R2 key and expiry in the URL. Mitigation: buckets are private, URLs expire in 1 hour, and cross-user access is blocked at the gateway *before* a URL is ever minted.

### D7. MySQL FULLTEXT with `ngram` parser for v1 search

Alternatives considered: Meilisearch, OpenSearch, Typesense. All are stronger search engines but add a second data store to operate, back up, and keep consistent with MySQL.

Decision: start with MySQL `FULLTEXT WITH PARSER ngram`. It supports CJK and short tokens, lives in the same database as everything else, and requires zero extra infra. Replacement is behind the `SearchService` gRPC boundary — swapping the engine later touches one service.

### D8. mTLS for all internal gRPC, including extension-server → archive

Internal gRPC uses mutual TLS from a private CA. The extension server, which is physically separate from the backend, authenticates to the archive service using a client certificate issued by the same CA. This means:
- Network-layer authentication: the archive service never trusts unauthenticated callers, even on a private network.
- No shared API key to rotate or leak — cert rotation is the ops control plane.

Cost: cert management. Mitigation: the CA + per-service certs are generated by a single `make certs` task; cert paths are environment variables, making rotation a restart.

### D9. JWT HS256, 1-hour access + 30-day refresh

HS256 (shared `JWT_SECRET`) over RS256/ES256 because all consumers are internal and the rotation story is simpler for v1. If external JWT consumers ever appear, migration to RS256 is a contained change in auth-service + the gateway middleware.

Refresh-token rotation on every use with reuse detection (revoke-all on reuse) is standard OWASP guidance and inexpensive to implement.

### D10. Quota enforcement lives in archive-service, not gateway

Quotas are checked *after* JWT auth but *before* R2 upload. This avoids trusting the gateway with plan math and keeps the "authoritative refusal" next to the side-effect. `user_quotas` is a separate table (not a column on `users`) so it can be moved/partitioned later, and so quota resets can be applied with a single UPDATE.

`PLAN_LIMITS` is a compile-time constant in archive-service for v1 (no runtime plan table). Justification: plans change rarely, and a constant is trivially testable and reviewable in PRs.

### D11. Cloud push is additive, not replacement, for the extension server

The cloud-archive hook is gated on `ARCHIVE_SERVICE_ADDR`; when unset, the extension server behaves exactly as today. A failed cloud push never breaks the local download. The extension server exposes `cloud_status` in its status endpoint so the extension can optionally surface a non-blocking warning, but no retry logic is added to the extension itself — the extension server owns up to 3 retries with backoff.

## Risks / Trade-offs

- **[Large pages exceed gRPC message limit]** → Cap ingest at 64 MB (user-facing) via quota; raise gRPC `max_receive_message_length` to 128 MB as safety margin; reject oversized payloads at archive-service with `RESOURCE_EXHAUSTED` so the extension server doesn't time out.
- **[Cross-schema coupling between search and library]** → Only one coupling point (`search.collection_id` filter); documented in D3; isolated behind gRPC in search-service so schemas can be physically split later without public API change.
- **[Presigned URL leak via browser history or logs]** → Expiry set to 3600s; buckets private; gateway logs redact `signed_url`; future frontend can iframe the URL with `referrerpolicy=no-referrer`.
- **[Idempotency key collision across tenants]** → `extension_job_id` is a session UUIDv4 per extension server; the UNIQUE constraint is global. Collision probability is negligible (2^-122), but we also index by `(user_id, extension_job_id)` conceptually so a future multi-tenant extension-server deployment could be re-partitioned.
- **[MySQL FULLTEXT result quality]** → Ngram parser gives correct recall but sometimes low precision on English. Acceptable for v1; escape hatch is swapping the engine behind `SearchService` without public API change (D7).
- **[mTLS cert drift]** → Cert paths are env vars; a `make certs` script regenerates everything; services refuse to start if cert files are missing when mTLS is required; dev compose can ship pre-generated test certs.
- **[Extension server retries on cloud push cause user-visible latency]** → Run the gRPC call in a background task after the local download is ready; status response returns immediately with `cloud_status: "pending"`; final status reflects success/failure asynchronously.
- **[Quota race between concurrent ingests]** → Use `SELECT ... FOR UPDATE` on `user_quotas` inside the ingest transaction so two concurrent `IngestPage` calls can't both squeeze past the cap; transaction also covers the `pages` insert.
- **[Refresh-token theft]** → Reuse detection revokes all refresh tokens for the user; access tokens still expire within 1 hour; stolen access tokens remain usable until `exp` (accepted stateless-JWT trade-off).
- **[Docker Compose isn't production-grade]** → Explicitly acknowledged; Phase 4 follow-up adds Kubernetes. For v1 launch, Compose with a supervisor (systemd unit or Railway/Render equivalent) is enough.

## Migration Plan

This is additive — there is no existing PagePocket to migrate from. Roll-out order:

1. Create `pagepocket/` workspace alongside the extension repo (or as a sibling repo if preferred; spec allows either).
2. Generate proto stubs (`make proto`).
3. Stand up MySQL, run Alembic migrations for all five schemas.
4. Deploy services individually in dependency order: `auth-service` → `search-service` → `library-service` → `share-service` → `archive-service` → `api-gateway`. Each step is verified with its own health check before proceeding.
5. Provision Cloudflare R2 account, create both buckets, verify privacy, store credentials in `archive-service` env only.
6. Mint internal CA and per-service certs; smoke-test mTLS with a throwaway gRPC client.
7. Flip `ARCHIVE_SERVICE_ADDR` (and cert paths) on the extension server; first ingests start flowing. `extension_job_id` idempotency means re-flipping the flag is safe.
8. Register the first real user via `POST /api/v1/auth/register`; validate end-to-end: extension captures → extension server finalises → archive-service ingests → list/view/search/share via gateway.

Rollback: unset `ARCHIVE_SERVICE_ADDR` on the extension server. Local capture flow immediately returns to pre-change behaviour. Cloud data in R2/MySQL is untouched and can be re-enabled later.

## Open Questions

- **Thumbnails**: Who generates them? Options: (a) archive-service generates on ingest (synchronous, adds latency); (b) a separate thumbnail-worker consumes a queue; (c) defer entirely. Leaning toward (c) for this change — `thumbnail_key` column exists but stays NULL — and adding a worker as a follow-up change.
- **Private share tokens**: Schema has `is_public=false` but no authenticated-viewer validation path. Acceptable to defer; the API gateway's public validation route explicitly rejects non-public tokens in this change.
- **Per-user refresh-token cap**: Should we cap the number of simultaneous refresh tokens per user to, say, 10? Defer; single-token rotation is the common case.
- **Tags API shape**: Library service has a `tags` table but this change does not define tag CRUD RPCs (only collections). Tag endpoints are a small follow-up change.
- **Cross-region R2**: Single bucket, single region for v1. Revisit if we onboard non-US/EU traffic at meaningful volume.
