## 1. Workspace & Proto Contracts

- [x] 1.1 Create `pagepocket/` workspace with subdirs: `proto/`, `services/`, `shared/`, and top-level `docker-compose.yml`, `docker-compose.prod.yml`, `Makefile`, `.env.example`, `README.md`
- [x] 1.2 Author `proto/auth.proto` defining `AuthService { Register, Login, Verify, Refresh, Logout }` and all request/response messages
- [x] 1.3 Author `proto/archive.proto` defining `ArchiveService { IngestPage, GetPage, ListPages, DeletePage, GetPageContent }` and all messages including `Asset`
- [x] 1.4 Author `proto/library.proto` defining `LibraryService` with collections + page-collection RPCs
- [x] 1.5 Author `proto/search.proto` defining `SearchService { IndexPage, RemovePage, Search }`
- [x] 1.6 Author `proto/share.proto` defining `ShareService { CreateShareLink, GetShareLink, RevokeShareLink, ValidateToken }`
- [x] 1.7 Add `make proto` target that runs `grpc_tools.protoc` emitting stubs into `shared/proto_generated/`; commit a `.gitignore` entry so generated stubs are either always-generated or explicitly tracked (pick one and document)
- [x] 1.8 Verify stubs import cleanly from a throwaway `python -c "import auth_pb2, archive_pb2, library_pb2, search_pb2, share_pb2"` smoke test

## 2. Shared Utilities

- [x] 2.1 Create `shared/jwt_utils.py` with `issue_access_token(user)`, `issue_refresh_token()`, `verify_access_token(token) -> payload`, using HS256 + `JWT_SECRET` env var
- [x] 2.2 Create `shared/r2_utils.py` exposing `R2Client` with `upload`, `presign`, `delete`, `delete_prefix` (boto3, `s3v4`, `region_name="auto"`)
- [x] 2.3 Create `shared/db.py` with a helper that builds a SQLAlchemy engine + `db_session()` context manager from a `DB_URL` env var
- [x] 2.4 Create `shared/grpc_mtls.py` helpers `secure_server_credentials()` and `secure_channel_credentials()` loading CA, key, and cert paths from env vars
- [x] 2.5 Write a common Dockerfile template snippet under `services/_template/Dockerfile` that every service extends (Python 3.12-slim, copy `shared/proto_generated`, copy app, `CMD ["python", "main.py"]`)

## 3. MySQL Schemas & Migrations

- [x] 3.1 Create `init.sql` that creates five empty databases: `auth_db`, `archive_db`, `library_db`, `search_db`, `share_db`
- [x] 3.2 Add Alembic to `auth-service` with migration creating `users` and `refresh_tokens` tables per the schema in design.md
- [x] 3.3 Add Alembic to `archive-service` with migration creating `pages` (with UNIQUE `extension_job_id`, `idx_archived_at`) and `user_quotas`
- [x] 3.4 Add Alembic to `library-service` with migration creating `collections`, `page_collections`, `tags`, `page_tags`
- [x] 3.5 Add Alembic to `search-service` with migration creating `page_index` including `FULLTEXT ... WITH PARSER ngram`
- [x] 3.6 Add Alembic to `share-service` with migration creating `share_links`
- [x] 3.7 Add `make migrate` target that runs `alembic upgrade head` inside each service container

## 4. Auth Service

- [x] 4.1 Create `services/auth-service/` with `main.py`, `servicer.py`, `models.py`, `db.py`, `requirements.txt`, `Dockerfile`
- [x] 4.2 Implement SQLAlchemy `User` and `RefreshToken` models
- [x] 4.3 Implement `AuthServicer.Register` with bcrypt hashing (cost ≥ 12), uniqueness check, JWT issuance, refresh-token persistence
- [x] 4.4 Implement `AuthServicer.Login` with constant-time bcrypt verify and identical error for wrong-email vs wrong-password
- [x] 4.5 Implement `AuthServicer.Verify` decoding the JWT and returning `valid/user_id/email`
- [x] 4.6 Implement `AuthServicer.Refresh` with rotation (delete old row, insert new) and reuse detection (revoke-all on invalid-but-known-hash replay)
- [x] 4.7 Implement `AuthServicer.Logout` deleting all refresh tokens for a user
- [x] 4.8 Wire `main.py` to start a gRPC server on `:50051` with mTLS credentials (from `shared/grpc_mtls.py`) and a plaintext fallback for local dev gated on `MTLS_ENABLED=false`
- [x] 4.9 Write unit tests covering register/login/refresh/reuse-detection/logout flows

## 5. Archive Service

- [x] 5.1 Create `services/archive-service/` scaffolding (`main.py`, `servicer.py`, `models.py`, `r2_client.py`, `page_processor.py`, `quota.py`, `requirements.txt`, `Dockerfile`)
- [x] 5.2 Implement SQLAlchemy `Page` and `UserQuota` models
- [x] 5.3 Implement `page_processor.sanitise_and_rewrite(html_bytes, asset_map) -> (rewritten_html, preview_text, body_text)` using BeautifulSoup + lxml
- [x] 5.4 Implement `quota.check_and_reserve(user_id, plan, request_size, db)` using `SELECT ... FOR UPDATE` to avoid concurrent-ingest races; include monthly rollover when `quota_reset_at` is past
- [x] 5.5 Implement `ArchiveServicer.IngestPage`: idempotency check on `extension_job_id` → quota check → upload assets → rewrite HTML → upload HTML → insert `pages` row → increment quota → fire-and-forget `SearchService.IndexPage`
- [x] 5.6 Implement `ArchiveServicer.GetPage`, `ListPages` (with `sort_by` + pagination), `GetPageContent` (presigned URL, 3600s), `DeletePage` (DB row + R2 prefix + thumbnail + SearchService.RemovePage + quota decrement)
- [x] 5.7 Enforce cross-user isolation on every RPC: return `NOT_FOUND` when `user_id` mismatches rather than leaking existence
- [x] 5.8 Wire `main.py` on `:50052` with mTLS credentials and gRPC `max_receive_message_length=128*1024*1024`
- [x] 5.9 Write unit tests: idempotent replay, quota exceeded (pages + bytes), HTML rewrite with mixed asset refs, cross-user denial, delete cleans up R2 prefix (use `moto` or a mocked `R2Client`)

## 6. Library Service

- [x] 6.1 Create `services/library-service/` scaffolding
- [x] 6.2 Implement `Collection`, `PageCollection`, `Tag`, `PageTag` SQLAlchemy models
- [x] 6.3 Implement `LibraryServicer` CRUD: `CreateCollection`, `GetCollection`, `ListCollections` (with optional `parent_id` filter, computed `page_count`), `UpdateCollection`, `DeleteCollection`
- [x] 6.4 Implement `AddPageToCollection` / `RemovePageFromCollection` with collection-ownership check; return `PERMISSION_DENIED` on cross-user attempts
- [x] 6.5 Wire `main.py` on `:50053` with mTLS
- [x] 6.6 Write unit tests: nesting, ownership, cascade on collection delete, duplicate add is idempotent

## 7. Search Service

- [x] 7.1 Create `services/search-service/` scaffolding
- [x] 7.2 Implement `PageIndex` SQLAlchemy model (with MEDIUMTEXT `body_text`)
- [x] 7.3 Implement `SearchServicer.IndexPage` as an UPSERT truncating `body_text` to the MEDIUMTEXT limit
- [x] 7.4 Implement `SearchServicer.RemovePage` (idempotent)
- [x] 7.5 Implement `SearchServicer.Search`: `MATCH ... AGAINST ... IN NATURAL LANGUAGE MODE`, scoped by `user_id`, with 240-char snippet generation and relevance score; optional cross-schema join to `library_db.page_collections` when `collection_id` is supplied
- [x] 7.6 Validate empty query returns `INVALID_ARGUMENT`
- [x] 7.7 Wire `main.py` on `:50054` with mTLS
- [x] 7.8 Write integration test hitting a real MySQL container verifying ngram parser finds CJK short tokens

## 8. Share Service

- [x] 8.1 Create `services/share-service/` scaffolding
- [x] 8.2 Implement `ShareLink` SQLAlchemy model
- [x] 8.3 Implement `ShareServicer.CreateShareLink` with 32-byte URL-safe base64 token generation and `short_url` built from `BASE_URL` env
- [x] 8.4 Implement `ShareServicer.ValidateToken` that atomically increments `view_count` only when public, non-revoked, non-expired; returns uniform `valid=false` for all failure modes
- [x] 8.5 Implement `ShareServicer.RevokeShareLink` enforcing user ownership
- [x] 8.6 Implement `ShareServicer.GetShareLink` returning metadata; gateway enforces ownership on this RPC
- [x] 8.7 Wire `main.py` on `:50055` with mTLS
- [x] 8.8 Write unit tests: expiry, revocation, view-count increment, enumeration-proof error uniformity

## 9. API Gateway

- [x] 9.1 Create `services/api-gateway/` with `main.py`, `routers/{auth,archive,library,search,share}.py`, `middleware/{auth,rate_limit}.py`, `grpc_clients/`, `requirements.txt`, `Dockerfile`
- [x] 9.2 Build a `grpc_clients` module that lazily opens and memoises one mTLS channel per downstream service (`AUTH_SERVICE_ADDR`, `ARCHIVE_SERVICE_ADDR`, etc.)
- [x] 9.3 Implement JWT middleware: require `Authorization: Bearer <jwt>` on all routes except explicitly listed public ones; inject `user_id` into request context
- [x] 9.4 Implement rate-limit middleware: 600/min per user on authenticated routes, 20/min per IP on `/api/v1/auth/*`, 429 with `Retry-After`
- [x] 9.5 Implement auth router: `POST /register`, `POST /login`, `POST /refresh`, `POST /logout`, all forwarding to `AuthService`
- [x] 9.6 Implement archive router: `GET /pages`, `GET /pages/{id}/view`, `DELETE /pages/{id}` — inject `user_id` from JWT, forward to `ArchiveService`
- [x] 9.7 Implement library router: collections CRUD + page-collection membership, forwarding to `LibraryService`
- [x] 9.8 Implement search router: `GET /search?q=&page=&page_size=&collection_id=`, forwarding to `SearchService`
- [x] 9.9 Implement share router: `POST /share`, `DELETE /share/{token}`, `GET /share/public/{token}` (public, validates token then calls `ArchiveService.GetPageContent` for the resolved `page_id`)
- [x] 9.10 Add `GET /api/v1/health` (no auth)
- [x] 9.11 Translate gRPC statuses to HTTP: `NOT_FOUND`→404, `PERMISSION_DENIED`→403, `RESOURCE_EXHAUSTED`→402 (quota) or 429 (rate), `INVALID_ARGUMENT`→400, `UNAUTHENTICATED`→401, `ALREADY_EXISTS`→409
- [x] 9.12 Ensure error responses include `api_version` field
- [x] 9.13 Write integration tests against a Compose-spun stack hitting each route

## 10. Cloudflare R2 Setup

- [x] 10.1 Provision Cloudflare R2 account, create `pagepocket-pages` and `pagepocket-thumbnails` buckets, confirm public access disabled
- [x] 10.2 Create an R2 API token scoped to these buckets only
- [x] 10.3 Smoke-test `R2Client.upload` / `presign` / `delete_prefix` against the real R2 from a local script
- [x] 10.4 Add `R2_ENDPOINT_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` to `.env.example` and document values under `README.md` without real secrets

## 11. mTLS Certificates

- [x] 11.1 Add `make certs` target that generates a private CA (`ca.pem`, `ca-key.pem`) into `certs/`
- [x] 11.2 Extend `make certs` to generate per-service server certs + one shared client cert for the extension server
- [x] 11.3 Wire every service's `main.py` to refuse to start with `MTLS_ENABLED=true` and missing cert paths
- [x] 11.4 Document cert rotation (regenerate + restart) in `README.md`

## 12. Docker Compose (Dev)

- [x] 12.1 Author `docker-compose.yml` with `mysql`, `api-gateway`, `auth-service`, `archive-service`, `library-service`, `search-service`, `share-service`
- [x] 12.2 Pin MySQL 8.0 image; mount `init.sql` and a named volume `mysql_data`
- [x] 12.3 Plumb every service's `DB_URL`, `JWT_SECRET`, service-discovery env vars (`*_SERVICE_ADDR`), and (archive only) R2 + quota env vars
- [x] 12.4 Add `depends_on` so gateway waits on all downstream services
- [x] 12.5 Verify `docker compose up` followed by `make migrate` yields a working stack; `curl /api/v1/health` returns 200

## 13. Docker Compose (Prod variant)

- [x] 13.1 Author `docker-compose.prod.yml` override with restart policies, resource limits, and TLS everywhere (`MTLS_ENABLED=true`)
- [x] 13.2 Remove all host-port exposures for internal services; only `api-gateway:8000` is public
- [x] 13.3 Document deployment on a single VM (systemd unit managing `docker compose -f … -f docker-compose.prod.yml up -d`)

## 14. Extension Server Integration

- [x] 14.1 In the existing extension server, add `archive_client.py` wrapping an mTLS gRPC stub for `ArchiveService.IngestPage`
- [x] 14.2 Extend the server's session table with `pagepocket_user_id` (nullable) and populate it from the API-key → user mapping on session creation
- [x] 14.3 Add background task (after local finalize completes) that pushes to `ArchiveService.IngestPage` with the session UUID as `extension_job_id`
- [x] 14.4 Implement 3-attempt exponential-backoff retry on gRPC errors; persist `cloud_status` (`pending`/`success`/`failed`) and `cloud_page_id` on the session
- [x] 14.5 Extend `GET /api/v1/sessions/{id}/status` response shape to include `cloud_status` and `cloud_page_id` when `ARCHIVE_SERVICE_ADDR` is set
- [x] 14.6 Guard the whole cloud-push code path on `ARCHIVE_SERVICE_ADDR`; no behavioural change when unset
- [x] 14.7 Refuse to start when `ARCHIVE_SERVICE_ADDR` is set but any of `ARCHIVE_CA_CERT`, `ARCHIVE_CLIENT_KEY`, `ARCHIVE_CLIENT_CERT` is missing or unreadable
- [x] 14.8 Add integration test: finalize a session with the stack up, assert cloud page appears via `ArchiveService.GetPage`

## 15. End-to-End Validation

- [x] 15.1 Script: register a user via gateway → call `AuthService.Verify` with the returned token → expect `valid=true`
- [x] 15.2 Script: from a mock extension-server client, call `ArchiveService.IngestPage` twice with the same `extension_job_id` → assert same `page_id`, no duplicate R2 objects, no duplicate DB rows
- [x] 15.3 Script: ingest, then search via gateway for a term in the body text → assert result returned with a snippet
- [x] 15.4 Script: create a collection, add the page to it, search with `collection_id` filter → assert only that page returns
- [x] 15.5 Script: create a share link, hit `GET /api/v1/share/public/{token}` unauthenticated → assert presigned URL returned; revoke → assert 404
- [x] 15.6 Script: ingest beyond free-plan page limit → assert `402 Payment Required` (quota exceeded) and no R2 write
- [x] 15.7 Script: delete a page → assert R2 prefix empty, search no longer returns it, quota bytes decremented

## 16. Developer Experience

- [x] 16.1 Write `pagepocket/README.md` covering: one-time setup (`make proto && make certs && docker compose up && make migrate`), env var reference, troubleshooting
- [x] 16.2 Add `make test` target running `pytest` across every service's `tests/` folder
- [x] 16.3 Add `make lint` target (ruff) and `make format` (ruff --fix + black)
- [x] 16.4 Document proto-change workflow in README (edit `.proto` → `make proto` → commit stubs or keep generated; update affected services)

## 17. Validation

- [x] 17.1 Run `openspec validate add-pagepocket-saas-backend` → must report valid
- [x] 17.2 Manually review each spec file against the corresponding servicer implementation and tick off any drift
- [x] 17.3 Confirm every `Requirement` has a covering test or validation script referenced in tasks 4–15
