## Why

The extension today only produces a local ZIP via the single Python extension server; users have no cloud archive, no library/organisation, no search, no sharing, and no account/plan model. To evolve WebsiteDownloader into the PagePocket SaaS — where users capture pages from the extension and then browse, search, organise, and share them on the web — we need a multi-service cloud backend. Doing this as a set of focused microservices (behind a single REST gateway) keeps each concern small, lets the existing extension server integrate with minimal disruption, and sets up a clean path to Kubernetes, quotas, and Stripe billing.

## What Changes

- Add a `pagepocket/` backend workspace (sibling to the extension) containing six Python 3.12 services plus shared proto definitions and generated stubs.
- Add `api-gateway` (FastAPI, port 8000) as the only public HTTP surface: REST → gRPC bridge, JWT middleware, rate limiting.
- Add `auth-service` (gRPC :50051): user registration, login, JWT access/refresh issuance, token verification, logout.
- Add `archive-service` (gRPC :50052): receives captured pages from the existing extension server via `IngestPage`, sanitises/rewrites HTML, uploads HTML + assets to Cloudflare R2, persists metadata to MySQL, enforces per-plan quotas, returns presigned viewer URLs, and fans out to search indexing.
- Add `library-service` (gRPC :50053): CRUD for collections (with optional nesting), tags, and page↔collection membership.
- Add `search-service` (gRPC :50054): MySQL `FULLTEXT` index (ngram parser) over page title + body text, per-user scoped search with snippets.
- Add `share-service` (gRPC :50055): creation, validation, revocation, and view-counting of hashed share tokens with optional expiry and public/private flag.
- Add `proto/` with `auth.proto`, `archive.proto`, `library.proto`, `search.proto`, `share.proto` and a `make proto` step that emits stubs into `shared/proto_generated/`.
- Add per-service MySQL schemas (`auth_db`, `archive_db`, `library_db`, `search_db`, `share_db`) managed via Alembic; introduce a `user_quotas` table and plan limits (`free`/`pro`/`team`).
- Add Cloudflare R2 as object storage with two buckets (`pagepocket-pages`, `pagepocket-thumbnails`) and a reusable `R2Client` wrapper using the S3-compatible API via `boto3`.
- Add a development `docker-compose.yml` wiring MySQL and all six services together, plus a production variant and a `Makefile` (`proto`, `build`, `dev`, `test`, `migrate`).
- Integrate the **existing extension server** with the new backend: after a successful local capture it calls `ArchiveService.IngestPage` via gRPC, supplying a `user_id`, captured HTML, assets, and an idempotency `extension_job_id`. The extension server never talks to any other internal service directly.
- Add mTLS for all service-to-service gRPC calls (including extension server → archive) and JWT-bearer auth for every `api-gateway` route.

### Non-goals (this change)

- No frontend (Next.js/React) work — the gateway contract is enough for a future frontend change.
- No Stripe billing wiring, no AI summarisation, no annotations, no change-monitoring, no Notion/Obsidian export (tracked as future phases in design.md).
- No Kubernetes manifests — Docker Compose is the deployable target for this change; k8s is a follow-up.
- No modification to how the extension itself scrapes pages; only the extension server gains an outbound gRPC client.

## Capabilities

### New Capabilities

- `pagepocket-api-gateway`: Public REST surface at `/api/v1/*`, JWT auth middleware, per-route rate limiting, and gRPC-client fan-out to internal services.
- `pagepocket-auth-service`: Account registration, password hashing (bcrypt), login, JWT access/refresh issuance and verification, refresh-token rotation, and logout.
- `pagepocket-archive-service`: Ingestion of captured pages from the extension server, HTML sanitisation/asset rewriting, R2 upload, metadata persistence, idempotent ingest by `extension_job_id`, presigned viewer URLs, list/get/delete, and plan-based quota enforcement.
- `pagepocket-library-service`: Collections (with optional parent), tags, and page-to-collection/tag membership, all scoped per user.
- `pagepocket-search-service`: MySQL `FULLTEXT`-backed per-user search with snippets and optional collection filter; index/remove hooks called by archive-service.
- `pagepocket-share-service`: Hashed share tokens with optional expiry and public/private flag, validation endpoint for the viewer, revocation, and view counting.
- `pagepocket-r2-storage`: Canonical R2 bucket layout (`{user_id}/{page_id}/index.html`, `assets/*`, `meta.json`; thumbnails in a separate bucket) and presigned-URL contract.
- `pagepocket-proto-contracts`: The five `.proto` files as the authoritative inter-service contract, plus the generated-stub distribution rule.

### Modified Capabilities

- `server-api`: The existing extension server REST API gains an optional outbound "push to cloud archive" hook invoked after successful finalization. When `ARCHIVE_SERVICE_ADDR` is configured, the server opens a gRPC channel (with mTLS) to `ArchiveService.IngestPage`, sends the finalized HTML + assets with an idempotent `extension_job_id`, and returns the resulting cloud `page_id` alongside the existing local download URL. When the env var is unset, behaviour is unchanged.

## Impact

- **New codebase**: `pagepocket/` workspace with six Python services, shared proto, generated stubs, docker-compose, Makefile, and per-service Alembic migrations.
- **Extension server** (existing): adds `archive_client.py` and an env-gated call site in the post-finalise path; adds `ARCHIVE_SERVICE_ADDR`, mTLS cert paths, and `PAGEPOCKET_USER_ID` mapping config; no change to scraping behaviour.
- **Extension (browser)**: no behavioural change in this change; the cloud flow is server-to-server.
- **Dependencies**: `grpcio`, `grpcio-tools`, `protobuf`, `sqlalchemy`, `pymysql`, `alembic`, `fastapi`, `uvicorn`, `pyjwt`, `passlib[bcrypt]`, `boto3`, `beautifulsoup4`, `lxml`, `python-dotenv` across services.
- **Infrastructure**: MySQL 8.0 (ngram parser required), Cloudflare R2 account + two buckets + API token, TLS CA for internal mTLS, Docker + Docker Compose for dev; production target remains Docker Compose in this change (Kubernetes is a follow-up).
- **Security**: JWT on every public route; mTLS on every internal gRPC call; per-plan quotas enforced server-side before R2 upload; presigned R2 URLs are short-lived (≤1h).
- **Observability (deferred)**: structured logging, OpenTelemetry tracing, Prometheus metrics, and load testing are explicitly out of scope for this change and tracked as Phase 4.
