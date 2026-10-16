# PagePocket

PagePocket is a cloud-based website archiving SaaS that pairs with the [WebsiteDownloader Chrome extension](../). It stores, searches, organizes, and shares archived web pages captured by the extension.

Users can save pages locally (via the Chrome extension) or upload them to PagePocket for cloud storage, full-text search, collection management, and link sharing.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Services](#services)
- [REST API Reference](#rest-api-reference)
- [Request Flow](#request-flow)
- [Database Schema](#database-schema)
- [Object Storage Layout](#object-storage-layout)
- [Authentication](#authentication)
- [Quota System](#quota-system)
- [Security](#security)
- [Directory Structure](#directory-structure)
- [Quick Start](#quick-start)
- [Environment Variables](#environment-variables)
- [Proto Workflow](#proto-workflow)
- [Make Targets](#make-targets)
- [Production Deployment](#production-deployment)
- [Frontend](#frontend)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

## Architecture Overview

```mermaid
                         ┌──────────────┐
                         │   Chrome     │
                         │  Extension   │
                         └──────┬───────┘
                                │ HTTPS
                                ▼
                         ┌──────────────┐
                         │  api-gateway │  :8090 (FastAPI)
                         │  REST → gRPC │
                         └──┬─┬─┬─┬─┬───┘
                            │ │ │ │ │  gRPC
              ┌─────────────┘ │ │ │ └─────────────┐
              ▼               ▼ ▼ ▼               ▼
        ┌──────────┐  ┌────────────┐  ┌────────────┐
        │   auth   │  │  archive   │  │   share    │
        │ :50051   │  │  :50052    │  │  :50055    │
        └────┬─────┘  └──┬────┬────┘  └─────┬──────┘
             │           │    │              │
             │           │    ▼              │
             │           │  ┌────────────┐  │
             │           │  │  library   │  │
             │           │  │  :50053    │  │
             │           │  └────────────┘  │
             │           │                  │
             │           ▼                  │
             │     ┌────────────┐           │
             │     │  search    │◄──────────┘  (fire-and-forget indexing)
             │     │  :50054    │
             │     └────────────┘
             │
     ┌───────┴──────────────────────────────────┐
     │              MySQL 8.0                    │
     │  auth_db · archive_db · library_db       │
     │  search_db · share_db                    │
     └──────────────────────────────────────────┘

                    ┌────────────────┐
                    │  Cloudflare R2 │  (page assets + HTML)
                    └────────────────┘
```

## Services

Six microservices behind a single FastAPI REST gateway. All inter-service communication uses gRPC (plaintext in dev, mTLS in prod). Each service owns its own MySQL database.

### API Gateway (`:8090`)

FastAPI application that exposes a REST API and translates HTTP requests into gRPC calls to backend services.

- **JWT authentication middleware** — validates `Authorization: Bearer <token>` on all non-public routes
- **Rate limiting middleware** — Redis-backed counters (`REDIS_URL`): per-IP on auth routes (20 req/min), per-user on authenticated routes (600 req/min). Keys expire within the rate window; if Redis is unreachable the limiter **fails open**, logs the failure, and `GET /api/v1/health` reports `"rate_limiter": "degraded"`
- **gRPC error translation** — maps gRPC status codes to HTTP errors (`UNAUTHENTICATED` → 401, `NOT_FOUND` → 404, `DEADLINE_EXCEEDED` → 503 with `Retry-After`, size-induced `RESOURCE_EXHAUSTED` → 413, quota exhaustion → 402, rate exhaustion → 429)
- **Lazy gRPC channel management** — memoises channels and stubs per service

### Auth Service (`:50051`)

Manages user accounts, credentials, and token lifecycle.

| gRPC Method | Description                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| `Register`  | Create account (email + password + name), returns JWT pair                                           |
| `Login`     | Authenticate, returns JWT pair                                                                       |
| `Verify`    | Validate an access token, return user claims                                                         |
| `Refresh`   | Rotate refresh token (old token revoked, new one issued). Detects reuse and revokes all user tokens. |
| `Logout`    | Revoke all refresh tokens for a user                                                                 |

- Passwords hashed with bcrypt (12 rounds, truncated to 72 bytes)
- Access tokens: HS256 JWT, 1-hour expiry, contains `{sub, email, plan}`
- Refresh tokens: `secrets.token_urlsafe(48)`, stored as SHA-256 hash, 30-day expiry, rotated on every use

### Archive Service (`:50052`)

Core service — ingests, stores, and serves archived web pages.

| gRPC Method      | Description                                                                       |
| ---------------- | --------------------------------------------------------------------------------- |
| `IngestPage`     | Accept HTML + assets from the extension, sanitise, upload to R2, index for search |
| `GetPage`        | Get page metadata by ID                                                           |
| `ListPages`      | Paginated list of user's pages, sorted by date or title                           |
| `GetPageContent` | Generate a presigned R2 URL for viewing                                           |
| `DeletePage`     | Delete page + all R2 objects, decrement quota, remove from search index           |

**Ingestion pipeline:**

1. Idempotency check via `extension_job_id`
2. Title extraction from HTML `<title>` if not provided
3. Quota validation (pages/month + storage bytes)
4. HTML sanitisation — rewrite asset URLs to R2 paths, extract body text
5. Upload assets, rewritten HTML, and `meta.json` to Cloudflare R2
6. Insert page row in MySQL
7. Fire-and-forget gRPC call to search-service for indexing (with bounded retries; failures leave a durable `search_indexed=False` flag re-delivered by `RetryPendingIndexing`)

### Library Service (`:50053`)

Manages collections (folders) for organizing pages.

| gRPC Method                | Description                                                       |
| -------------------------- | ----------------------------------------------------------------- |
| `CreateCollection`         | Create a collection (supports nested collections via `parent_id`) |
| `GetCollection`            | Get collection with page count                                    |
| `ListCollections`          | List collections, optionally filtered by parent                   |
| `UpdateCollection`         | Update name, description, or color                                |
| `DeleteCollection`         | Delete collection (cascades to page associations)                 |
| `AddPageToCollection`      | Add a page to a collection                                        |
| `RemovePageFromCollection` | Remove a page from a collection                                   |

Collections support nesting (tree structure via `parent_id` FK) and custom colors for UI display.

### Search Service (`:50054`)

Full-text search powered by MySQL's ngram full-text parser.

| gRPC Method  | Description                                                         |
| ------------ | ------------------------------------------------------------------- |
| `IndexPage`  | Upsert page text into the search index                              |
| `RemovePage` | Remove a page from the index                                        |
| `Search`     | Full-text search with relevance scoring, optional collection filter |

- Uses `FULLTEXT INDEX ... WITH PARSER ngram` on `(title, body_text)` for CJK support
- Body text stored in `MEDIUMTEXT` (up to 16 MB per page)
- Results include relevance score and snippet extraction (context window around first match)
- Supports filtering by collection via cross-database query to `library_db.page_collections`

### Share Service (`:50055`)

Creates and validates shareable links for archived pages.

| gRPC Method       | Description                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `CreateShareLink` | Create a share link for a page (returns short URL). Returns existing active link if one exists. |
| `GetShareLink`    | Get share link metadata by token                                                                |
| `RevokeShareLink` | Revoke a share link                                                                             |
| `ValidateToken`   | Public endpoint — validate a share token, atomically increment view count                       |

- Tokens: `secrets.token_urlsafe(32)`, up to 64 characters
- Optional expiration timestamps
- View count tracked per link (atomic SQL-level increment to prevent lost updates)

## REST API Reference

All endpoints are prefixed with `/api/v1`.

### Auth (`/api/v1/auth`)

| Method | Path        | Auth | Description                                 |
| ------ | ----------- | ---- | ------------------------------------------- |
| POST   | `/register` | No   | `{email, password, name}` → JWT pair + user |
| POST   | `/login`    | No   | `{email, password}` → JWT pair + user       |
| POST   | `/refresh`  | No   | `{refresh_token}` → new JWT pair            |
| POST   | `/logout`   | Yes  | Revoke all refresh tokens                   |

### Archive (`/api/v1/archive`)

| Method | Path                               | Auth | Description                      |
| ------ | ---------------------------------- | ---- | -------------------------------- |
| GET    | `/pages?page=&page_size=&sort_by=` | Yes  | List user's pages                |
| GET    | `/pages/{id}/view`                 | Yes  | Get presigned R2 URL for viewing |
| DELETE | `/pages/{id}`                      | Yes  | Delete a page                    |

### Library (`/api/v1/library`)

| Method | Path                                | Auth | Description                                |
| ------ | ----------------------------------- | ---- | ------------------------------------------ |
| POST   | `/collections`                      | Yes  | `{name, description?, parent_id?, color?}` |
| GET    | `/collections?parent_id=`           | Yes  | List collections                           |
| GET    | `/collections/{id}`                 | Yes  | Get collection with page count             |
| PATCH  | `/collections/{id}`                 | Yes  | Update name/description/color              |
| DELETE | `/collections/{id}`                 | Yes  | Delete collection                          |
| POST   | `/collections/{id}/pages/{page_id}` | Yes  | Add page to collection                     |
| DELETE | `/collections/{id}/pages/{page_id}` | Yes  | Remove page from collection                |

### Search (`/api/v1`)

| Method | Path                                         | Auth | Description      |
| ------ | -------------------------------------------- | ---- | ---------------- |
| GET    | `/search?q=&page=&page_size=&collection_id=` | Yes  | Full-text search |

### Share (`/api/v1/share`)

| Method | Path              | Auth   | Description                                       |
| ------ | ----------------- | ------ | ------------------------------------------------- |
| POST   | ``                | Yes    | `{page_id, is_public?, expires_at?}` → share link |
| DELETE | `/{token}`        | Yes    | Revoke a share link                               |
| GET    | `/public/{token}` | **No** | Validate token, get presigned page URL            |

### Health

| Method | Path      | Auth | Description                             |
| ------ | --------- | ---- | --------------------------------------- |
| GET    | `/health` | No   | `{"status": "ok", "api_version": "v1"}` |

## Request Flow

### Page Upload (Extension → Cloud)

```plaintext
1. Extension captures page (HTML + CSS + JS + images)
2. Extension sends IngestPage gRPC call to archive-service
   (or REST via gateway, depending on the flow)
3. Archive-service:
   a. Checks idempotency (extension_job_id)
   b. Validates quota (pages/month, total bytes)
   c. Sanitises HTML, rewrites asset URLs
   d. Uploads to R2: {user_id}/{page_id}/index.html
                      {user_id}/{page_id}/assets/{filename}
                      {user_id}/{page_id}/meta.json
   e. Stores metadata in archive_db.pages
   f. Fires async IndexPage to search-service
4. Returns page_id to extension
```

### Page View (Web UI)

```plaintext
1. User clicks a page in the dashboard
2. Frontend calls GET /api/v1/archive/pages/{id}/view
3. Gateway forwards GetPageContent to archive-service
4. Archive-service generates presigned R2 URL (1-hour expiry)
5. Frontend redirects user to presigned URL
```

### Page Search

```plaintext
1. User types query in search bar
2. Frontend calls GET /api/v1/search?q=...&page=1
3. Gateway forwards Search to search-service
4. Search-service runs MySQL FULLTEXT MATCH...AGAINST
5. Returns ranked results with snippets and scores
```

### Share Link

```plaintext
1. User clicks "Share" on a page
2. Frontend calls POST /api/v1/share {page_id}
3. Share-service creates token, returns short URL
4. Visitor opens /api/v1/share/public/{token}
5. Gateway validates token via share-service
6. If valid, fetches presigned R2 URL from archive-service
7. Visitor views the archived page
```

## Database Schema

Each service owns a separate MySQL database. Created by `init.sql` on first startup.

### `auth_db`

**users**:

| Column        | Type                | Notes                       |
| ------------- | ------------------- | --------------------------- |
| id            | VARCHAR(36) PK      | UUID                        |
| email         | VARCHAR(255) UNIQUE | Indexed                     |
| password_hash | VARCHAR(255)        | bcrypt                      |
| name          | VARCHAR(255)        |                             |
| plan          | VARCHAR(50)         | `"free"`, `"pro"`, `"team"` |
| is_verified   | BOOLEAN             |                             |
| created_at    | DATETIME            |                             |

**refresh_tokens**:

| Column     | Type               | Notes                  |
| ---------- | ------------------ | ---------------------- |
| id         | VARCHAR(36) PK     | UUID                   |
| user_id    | VARCHAR(36)        | Indexed                |
| token_hash | VARCHAR(64) UNIQUE | SHA-256 of raw token   |
| expires_at | DATETIME           |                        |
| created_at | DATETIME           |                        |
| revoked_at | DATETIME NULLABLE  | Set on rotation/logout |

### `archive_db`

**pages**:

| Column           | Type               | Notes                    |
| ---------------- | ------------------ | ------------------------ |
| id               | VARCHAR(36) PK     | UUID                     |
| user_id          | VARCHAR(36)        | Indexed                  |
| url              | TEXT               | Original page URL        |
| title            | VARCHAR(500)       |                          |
| preview_text     | TEXT               | First 500 chars of body  |
| r2_key           | VARCHAR(500)       | R2 key for index.html    |
| size_bytes       | BIGINT             | Total page + assets size |
| extension_job_id | VARCHAR(36) UNIQUE | Idempotency key          |
| archived_at      | DATETIME           |                          |

**user_quotas**:

| Column           | Type           | Notes              |
| ---------------- | -------------- | ------------------ |
| user_id          | VARCHAR(36) PK |                    |
| pages_this_month | INT            | Reset monthly      |
| total_bytes      | BIGINT         | Lifetime storage   |
| quota_reset_at   | DATETIME       | Next monthly reset |

### `library_db`

**collections**:

| Column      | Type                            | Notes                        |
| ----------- | ------------------------------- | ---------------------------- |
| id          | VARCHAR(36) PK                  | UUID                         |
| user_id     | VARCHAR(36)                     | Indexed                      |
| name        | VARCHAR(255)                    |                              |
| description | TEXT NULLABLE                   |                              |
| parent_id   | VARCHAR(36) FK → collections.id | SET NULL on delete           |
| color       | VARCHAR(7)                      | Hex color, default `#6B7280` |
| created_at  | DATETIME                        |                              |
| updated_at  | DATETIME                        | Auto-updated                 |

**page_collections**:

| Column        | Type                               | Notes          |
| ------------- | ---------------------------------- | -------------- |
| page_id       | VARCHAR(36) PK                     |                |
| collection_id | VARCHAR(36) PK FK → collections.id | CASCADE delete |
| added_at      | DATETIME                           |                |

**tags** / **page_tags** — available in models, used for future tag-based organization.

### `search_db`

**page_index**:

| Column      | Type               | Notes                      |
| ----------- | ------------------ | -------------------------- |
| id          | VARCHAR(36) PK     | UUID                       |
| page_id     | VARCHAR(36) UNIQUE | Indexed                    |
| user_id     | VARCHAR(36)        | Indexed                    |
| url         | TEXT               |                            |
| title       | VARCHAR(500)       | FULLTEXT                   |
| body_text   | MEDIUMTEXT         | FULLTEXT with ngram parser |
| tags        | TEXT NULLABLE      |                            |
| archived_at | DATETIME           |                            |

FULLTEXT index on `(title, body_text)` with MySQL ngram parser.

### `share_db`

**share_links**:

| Column     | Type              | Notes                |
| ---------- | ----------------- | -------------------- |
| token      | VARCHAR(64) PK    | URL-safe random      |
| user_id    | VARCHAR(36)       | Indexed              |
| page_id    | VARCHAR(36)       |                      |
| is_public  | BOOLEAN           |                      |
| expires_at | DATETIME NULLABLE | NULL = never expires |
| view_count | INT               | Atomic increment     |
| created_at | DATETIME          |                      |
| revoked_at | DATETIME NULLABLE |                      |

## Object Storage Layout

Cloudflare R2 bucket (`pagepocket-pages`):

``` plaintext
{user_id}/{page_id}/
├── index.html       # Sanitised, rewritten HTML
├── meta.json        # {"title", "url", "archived_at", "size_bytes"}
└── assets/
    ├── style.css
    ├── script.js
    └── image.png    # All captured assets
```

Presigned URLs generated with 1-hour expiry for viewing.

## Authentication

``` mermaid
                    ┌─────────────┐
                    │   Register  │
                    │   / Login   │
                    └──────┬──────┘
                           │
              ┌────────────▼────────────┐
              │  access_token (1 hour)  │
              │  refresh_token (30 days)│
              └────────────┬────────────┘
                           │
                    ┌──────▼──────┐
                    │  API calls  │  Authorization: Bearer <access_token>
                    └──────┬──────┘
                           │ token expired
                    ┌──────▼──────┐
                    │   Refresh   │  POST /auth/refresh {refresh_token}
                    └──────┬──────┘
                           │ new token pair
                    ┌──────▼──────┐
                    │  Continue   │
                    └─────────────┘
```

- **Access tokens**: HS256 JWT containing `{sub: user_id, email, plan}`. Verified by the gateway middleware without calling auth-service.
- **Refresh tokens**: Opaque random strings, stored as SHA-256 hashes in the database. Rotated on every use — old token is revoked, new one issued. If a revoked token is reused, all tokens for that user are revoked (reuse detection).
- **Public endpoints**: `/auth/register`, `/auth/login`, `/auth/refresh`, `/health`, `/share/public/{token}`.

## Quota System

Enforced by the archive service during page ingestion using `SELECT ... FOR UPDATE` to prevent concurrent races.

| Plan   | Pages/month | Storage |
| ------ | ----------- | ------- |
| `free` | 50          | 500 MB  |
| `pro`  | 99,999      | 10 GB   |
| `team` | 99,999      | 50 GB   |

Quotas reset monthly. Deleting a page decrements the storage counter but does not credit the page count.

## Security

- **mTLS**: All gRPC traffic between services encrypted with mutual TLS in production (`MTLS_ENABLED=true`). Development uses plaintext.
- **bcrypt**: Passwords hashed with 12 rounds, truncated to 72 bytes (bcrypt limit).
- **JWT HS256**: Signed with a shared secret (`JWT_SECRET`). Access tokens expire after 1 hour (refresh flow issues new pairs); the gateway refuses to boot with a missing/dev-default secret when `ENVIRONMENT=production`.
- **Refresh token rotation**: Old tokens are revoked on every refresh. Reuse detection revokes all user tokens.
- **Rate limiting**: Redis-backed counters — per-IP on auth routes (20/min, keyed by `CF-Connecting-IP` with trusted-proxy fallback), per-user on authenticated routes (600/min). Fails open (with logging + `rate_limiter: degraded` health signal) if Redis is down.
- **R2 presigned URLs**: Page content served via time-limited presigned URLs (1-hour expiry), not direct access.
- **CORS**: Pinned to an explicit allow-list via `CORS_ALLOW_ORIGINS` (defaults to `https://pagepocket.app`, `https://app.pagepocket.app`; `*` is never honored).
- **Archived-HTML sandboxing**: Serving routes (`/api/sc/*`, gateway file routes) set `Content-Security-Policy: sandbox allow-popups allow-forms` (no `allow-same-origin`), `X-Content-Type-Options: nosniff`, pinned content types, and `Referrer-Policy: no-referrer` on HTML; archived HTML is sanitised at ingest.
- **Resource limits**: Production compose file sets memory limits per container (512 MB–1 GB).

## Directory Structure

``` plaintext
pagepocket/
├── proto/                          # Protobuf definitions (one .proto per service)
│   ├── auth.proto
│   ├── archive.proto
│   ├── library.proto
│   ├── search.proto
│   └── share.proto
├── shared/                         # Shared Python packages
│   ├── db.py                       # SQLAlchemy session helper (Base, db_session context manager)
│   ├── jwt_utils.py                # HS256 access/refresh token management
│   ├── r2_utils.py                 # Cloudflare R2 S3 client wrapper
│   ├── grpc_mtls.py                # mTLS credential helpers
│   └── proto_generated/            # Generated gRPC stubs (tracked in git)
├── services/
│   ├── api-gateway/                # FastAPI REST gateway
│   │   ├── main.py
│   │   ├── middleware/             # Auth + rate-limit middleware
│   │   ├── routers/                # REST route handlers (one per service)
│   │   └── grpc_clients/           # Lazy gRPC channel/stub management
│   ├── auth-service/               # User auth (register, login, JWT)
│   ├── archive-service/            # Page ingestion, R2 storage, quotas
│   │   ├── page_processor.py       # HTML sanitisation + asset URL rewriting
│   │   ├── quota.py                # Quota check + reserve logic
│   │   └── r2_client.py            # Re-exports shared R2Client
│   ├── library-service/            # Collections + tags
│   ├── search-service/             # Full-text search (MySQL ngram)
│   ├── share-service/              # Share link tokens
│   └── _template/                  # Dockerfile template for new services
├── frontend/                       # Next.js 16 web UI
│   ├── src/                        # App source (React 19, TanStack Query, shadcn/ui)
│   └── e2e/                        # Playwright E2E tests
├── tests/                          # Integration tests
├── init.sql                        # Creates all 5 databases on first startup
├── docker-compose.yml              # Development stack
├── docker-compose.prod.yml         # Production overrides (mTLS, resource limits, restart)
├── Makefile                        # Build, test, migration, proto targets
├── .env.example                    # Environment variable template
└── README.md
```

## Quick Start

```bash
# 1. Copy environment config
cp .env.example .env
# Edit .env with your R2 credentials and JWT secret (dev defaults let a
# fresh clone boot as-is; see the comments in .env.example)

# 2. Generate proto stubs
make proto

# 3. Generate mTLS certificates (dev uses plaintext; prod needs certs)
make certs

# 4. Start the stack
make dev
# (creates the external `pagepocket_default` network on first run — 4.7)

# 5. Run database migrations
make migrate

# 6. Verify
curl http://localhost:8090/api/v1/health
# {"status":"ok","api_version":"v1","rate_limiter":"ok"}
```

## Environment Variables

| Variable               | Used by                   | Description                                        |
| ---------------------- | ------------------------- | -------------------------------------------------- |
| `MYSQL_ROOT_PASSWORD`  | mysql                     | Root password for MySQL (dev default `pagepocket`; rotate in prod via `scripts/prod/rotate-credentials.sh`) |
| `DB_USER_<SVC>` / `DB_PASSWORD_<SVC>` | all gRPC services, mysql | Per-service least-privilege MySQL credentials (`<SVC>` = `AUTH`/`ARCHIVE`/`LIBRARY`/`SEARCH`/`SHARE`, users `pagepocket_<svc>` scoped to their own schema — D12). Dev falls back to root; the prod overlay **requires** the scoped passwords (provision via `scripts/prod/rotate-db-users.sh`). On a fresh MySQL volume `init-users.sh` seeds the users from these values |
| `JWT_SECRET`           | auth-service, api-gateway | HS256 signing key. Required (and must not be the dev default) when `ENVIRONMENT=production` — the gateway fails fast otherwise |
| `ENVIRONMENT`          | api-gateway, share-service | `development` (default) or `production`. Production enables fail-fast config checks (JWT_SECRET, BASE_URL). Set by the prod overlay |
| `CORS_ALLOW_ORIGINS`   | api-gateway               | Comma-separated CORS origin allow-list. `*` is dropped with a warning; defaults to `https://pagepocket.app`, `https://app.pagepocket.app` |
| `TRUSTED_PROXIES`      | api-gateway               | Comma-separated proxy IPs/CIDRs whose `X-Forwarded-For` is trusted for rate-limit identity (empty = peer address only). Compose default is the **docker bridge gateways only** (`172.18.0.1,172.17.0.1`) — verify against the host before overriding (`docker network inspect pagepocket_default`); rollout notes in `scripts/prod/README.md` |
| `MAX_UPLOAD_BYTES`     | api-gateway               | Cap on accepted ingest request size; oversized uploads get 413 |
| `MAX_INGEST_ASSETS`    | api-gateway               | Cap on the number of assets accepted per ingest request (default `200`); exceeded → 413 |
| `GATEWAY_WORKERS`      | api-gateway               | uvicorn worker count (default `2`). Multi-worker is safe — the rate limiter is Redis-backed, not per-process |
| `REDIS_URL`            | api-gateway, services     | Redis address for the rate limiter and cache. Limiter fails open when Redis is down; `/api/v1/health` reports `rate_limiter: ok \| degraded` |
| `REDIS_PASSWORD`       | redis                     | Password for Redis (dev default `dev-redis-change-me`; rotate in prod via `scripts/prod/roll-redis-password.sh`) |
| `AUTO_CREATE`          | gRPC services             | Dev-only: run `Base.metadata.create_all` at startup. Alembic is the authoritative schema mechanism — production must rely on `make migrate` |
| `BASE_URL`             | share-service             | Public base URL for generating short links. Required (and must not be `http://localhost:8000`) when `ENVIRONMENT=production` — the share service fails fast otherwise |
| `DB_URL`               | all gRPC services         | SQLAlchemy connection string (auto-set in compose) |
| `R2_ENDPOINT_URL`      | archive-service           | Cloudflare R2 endpoint                             |
| `R2_ACCESS_KEY_ID`     | archive-service           | R2 API access key                                  |
| `R2_SECRET_ACCESS_KEY` | archive-service           | R2 API secret key                                  |
| `R2_BUCKET_NAME`       | archive-service           | R2 bucket name (default: `pagepocket-pages`)       |
| `MTLS_ENABLED`         | all services              | Enable mTLS (`true`/`false`)                       |
| `*_SERVICE_ADDR`       | api-gateway               | gRPC addresses for each backend service            |
| `ARCHIVE_SERVICE_ADDR` | share-service, library-service | gRPC address for defense-in-depth page-ownership checks (share links / collection adds) |
| `SEARCH_SERVICE_ADDR`  | archive-service           | Address for search indexing (bounded retries + durable pending flag) |
| `LOG_LEVEL`            | all services, monolith    | Log level (default `INFO`)                         |
| `LOG_FORMAT`           | all services, monolith    | `json` for one-JSON-object-per-line logs (default: human-readable) |
| `CA_CERT`              | all (prod)                | Path to CA certificate                             |
| `SERVER_KEY`           | gRPC services (prod)      | Path to server private key                         |
| `SERVER_CERT`          | gRPC services (prod)      | Path to server certificate                         |
| `CLIENT_KEY`           | api-gateway (prod)        | Path to client private key                         |
| `CLIENT_CERT`          | api-gateway (prod)        | Path to client certificate                         |

## Proto Workflow

1. Edit `.proto` files in `proto/`
2. Run `make proto` to regenerate stubs in `shared/proto_generated/`
3. Generated stubs are tracked in git for reproducibility
4. Update affected services if message shapes change

## Make Targets

| Target         | Description                                      |
| -------------- | ------------------------------------------------ |
| `make proto`   | Generate gRPC Python stubs from `.proto` files   |
| `make build`   | Build all Docker images (creates `pagepocket_default` if missing) |
| `make dev`     | Build + start dev stack (`docker compose up -d`); network-guarded for fresh clones |
| `make up`      | Alias for `dev`                                  |
| `make down`    | Stop the stack                                   |
| `make migrate` | Run Alembic migrations for all 5 gRPC services   |
| `make test`    | Run pytest across all services + the compose-contract render test |
| `make test-integration` | Boot an ISOLATED compose stack (project `pagepocket-it`) and run the gateway + search-service MySQL integration suites against it |
| `make lint`    | Run ruff linter                                  |
| `make format`  | Run ruff (fix) + black formatter                 |
| `make certs`   | Generate CA + per-service mTLS certificates      |
| `make help`    | Print target descriptions                        |

## Production Deployment

On a single VM, manage the stack with Docker Compose + systemd.

```bash
# Deploy (uses production overrides: mTLS, resource limits, restart: always)
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### Production overrides (`docker-compose.prod.yml`)

- Enables mTLS on all services with mounted certificate volumes
- Sets `restart: always`
- Removes internal service port exposure (only the gateway `:8090` is published — and it must be bound to loopback so only nginx reaches it; see `scripts/prod/README.md` for the hardening runbook)
- Adds memory limits (512 MB per service, 1 GB for archive-service, 2 GB for MySQL)

### Production topology (verified Oct 2026)

- `server.pagepocket.app` → Cloudflare → nginx → `127.0.0.1:8000` (**the monolith**, not the gateway — the gateway has no public hostname; `:8090` answers only on the host)
- `pagepocket.app` and `app.pagepocket.app` → nginx → `127.0.0.1:3000` (Next.js frontend). `app.pagepocket.app` currently has **no dedicated nginx server block** — it resolves via nginx's default-server fallthrough; one explicit `server_name` block would make this intentional.
- nginx sets `X-Forwarded-For`/`X-Forwarded-Proto`, `X-Real-IP` and `Host`; `CF-Connecting-IP` comes from the Cloudflare edge. The gateway's `TRUSTED_PROXIES` compose default lists ONLY the docker bridge gateway addresses (`172.18.0.1,172.17.0.1`) that host→`127.0.0.1:8090` connections are source-NATed to — verify the real value on the host and override in `pagepocket/.env` if it differs (rollout caution in `scripts/prod/README.md`).
- **Monolith confinement (D12/2.17):** the monolith container attaches to the confined `pagepocket-monolith` network (archive-service + auth-service only). search-/library-/share-service are unreachable from it. Applying the switch to the running monolith is deploy-gated — see `scripts/prod/README.md` §Monolith network confinement.
- ⚠️ As of the Oct 2026 audit, monolith `:8000`, gateway `:8090` and monolith MySQL `:33060` are also reachable directly from the internet — closing them (loopback bind / firewall) is the first hardening step in `scripts/prod/README.md`.

### Systemd unit

Create `/etc/systemd/system/pagepocket.service`:

```ini
[Unit]
Description=PagePocket SaaS Backend
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/var/www/Web-Downloader-Extension/pagepocket
ExecStart=/usr/bin/docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
ExecStop=/usr/bin/docker compose -f docker-compose.yml -f docker-compose.prod.yml down
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable pagepocket
sudo systemctl start pagepocket
```

**Certificates are NOT rotated by restarting this unit.** The host PKI is
authoritative (live certs expire Jun 2036 and differ from anything in the
repo); `make certs` exists for LOCAL DEV only and its output must NEVER be
copied to the host — that would break every service's mTLS identity at
once. Real rotation, if ever needed before 2036, happens ON the host in a
coordinated sequence: see `scripts/prod/README.md` §Certificates.

## Frontend

The web UI lives in `frontend/` and is built with:

- **Next.js 16** with React 19 and Turbopack
- **TanStack Query** for server state management
- **shadcn/ui** + **Radix UI** component library
- **Tailwind CSS 4** for styling
- **react-hook-form** + **Zod** for form validation
- **dnd-kit** for drag-and-drop collection management
- **cmdk** for command palette
- **Playwright** for E2E tests

See `frontend/README.md` for frontend-specific setup.

## Testing

```bash
# Unit tests (per-service pytest) + the compose-contract render test
make test

# Integration tests: boots an ISOLATED compose stack (project
# `pagepocket-it`, own network + volumes so it can never touch the
# prod-named project) and runs the gateway suite (17 tests) AND the
# search-service MySQL FULLTEXT/CJK suite against it; tears the stack
# down (scoped to pagepocket-it) afterwards.
make test-integration
# NB: stop the dev/prod stack first — both bind 127.0.0.1:{3306,8090}.
# The search suite connects to the stack's MySQL via SEARCH_TEST_DB_URL
# (set by the make target; defaults to
# mysql+pymysql://root:pagepocket@127.0.0.1:3306/search_db).

# E2E tests (frontend)
cd frontend && pnpm exec playwright test
```

## Troubleshooting

| Issue                        | Fix                                                                     |
| ---------------------------- | ----------------------------------------------------------------------- |
| `ImportError` on proto stubs | Run `make proto` to regenerate                                          |
| Migration fails              | Ensure MySQL is healthy: `docker compose ps mysql`                      |
| mTLS handshake fails         | Verify cert paths match env vars, regenerate with `make certs`          |
| Quota exceeded (402)         | Check `user_quotas` table or upgrade plan                               |
| Presigned URL expired        | Re-request via `GET /pages/{id}/view`                                   |
| Search returns no results    | Ensure archive-service can reach search-service (`SEARCH_SERVICE_ADDR`) |
