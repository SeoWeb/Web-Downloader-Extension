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
                         │  api-gateway │  :8000 (FastAPI)
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

### API Gateway (`:8000`)

FastAPI application that exposes a REST API and translates HTTP requests into gRPC calls to backend services.

- **JWT authentication middleware** — validates `Authorization: Bearer <token>` on all non-public routes
- **Rate limiting middleware** — per-IP on auth routes (20 req/min), per-user on authenticated routes (600 req/min)
- **gRPC error translation** — maps gRPC status codes to HTTP errors (e.g., `UNAUTHENTICATED` → 401, `NOT_FOUND` → 404, `RESOURCE_EXHAUSTED` → 402)
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
7. Fire-and-forget gRPC call to search-service for indexing

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
- **JWT HS256**: Signed with a shared secret (`JWT_SECRET`). Tokens expire after 1 hour.
- **Refresh token rotation**: Old tokens are revoked on every refresh. Reuse detection revokes all user tokens.
- **Rate limiting**: Per-IP on auth routes (20/min), per-user on authenticated routes (600/min).
- **R2 presigned URLs**: Page content served via time-limited presigned URLs (1-hour expiry), not direct access.
- **CORS**: Configured with `allow_origins=["*"]` (restrict in production).
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
# Edit .env with your R2 credentials and JWT secret

# 2. Generate proto stubs
make proto

# 3. Generate mTLS certificates (dev uses plaintext; prod needs certs)
make certs

# 4. Start the stack
docker compose up -d

# 5. Run database migrations
make migrate

# 6. Verify
curl http://localhost:8000/api/v1/health
# {"status":"ok","api_version":"v1"}
```

## Environment Variables

| Variable               | Used by                   | Description                                        |
| ---------------------- | ------------------------- | -------------------------------------------------- |
| `MYSQL_ROOT_PASSWORD`  | mysql                     | Root password for MySQL                            |
| `JWT_SECRET`           | auth-service, api-gateway | HS256 signing key                                  |
| `DB_URL`               | all gRPC services         | SQLAlchemy connection string (auto-set in compose) |
| `R2_ENDPOINT_URL`      | archive-service           | Cloudflare R2 endpoint                             |
| `R2_ACCESS_KEY_ID`     | archive-service           | R2 API access key                                  |
| `R2_SECRET_ACCESS_KEY` | archive-service           | R2 API secret key                                  |
| `R2_BUCKET_NAME`       | archive-service           | R2 bucket name (default: `pagepocket-pages`)       |
| `BASE_URL`             | share-service             | Public base URL for generating short links         |
| `MTLS_ENABLED`         | all services              | Enable mTLS (`true`/`false`)                       |
| `*_SERVICE_ADDR`       | api-gateway               | gRPC addresses for each backend service            |
| `CA_CERT`              | all (prod)                | Path to CA certificate                             |
| `SERVER_KEY`           | gRPC services (prod)      | Path to server private key                         |
| `SERVER_CERT`          | gRPC services (prod)      | Path to server certificate                         |
| `CLIENT_KEY`           | api-gateway (prod)        | Path to client private key                         |
| `CLIENT_CERT`          | api-gateway (prod)        | Path to client certificate                         |
| `SEARCH_SERVICE_ADDR`  | archive-service           | Address for fire-and-forget search indexing        |

## Proto Workflow

1. Edit `.proto` files in `proto/`
2. Run `make proto` to regenerate stubs in `shared/proto_generated/`
3. Generated stubs are tracked in git for reproducibility
4. Update affected services if message shapes change

## Make Targets

| Target         | Description                                      |
| -------------- | ------------------------------------------------ |
| `make proto`   | Generate gRPC Python stubs from `.proto` files   |
| `make build`   | Build all Docker images                          |
| `make dev`     | Build + start dev stack (`docker compose up -d`) |
| `make up`      | Alias for `dev`                                  |
| `make down`    | Stop the stack                                   |
| `make migrate` | Run Alembic migrations for all 5 gRPC services   |
| `make test`    | Run pytest across all services                   |
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
- Removes internal port exposure (only gateway `:8000` is public)
- Adds memory limits (512 MB per service, 1 GB for archive-service, 2 GB for MySQL)

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
WorkingDirectory=/opt/pagepocket
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

Certificate rotation: regenerate with `make certs` then `sudo systemctl restart pagepocket`.

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
# Unit tests (per-service pytest)
make test

# Integration tests (top-level)
docker compose exec archive-service python -m pytest tests/ -v

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
