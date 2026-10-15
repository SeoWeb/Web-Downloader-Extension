# API Gateway

The public-facing HTTP entry point for PagePocket. Translates REST requests into internal gRPC calls to backend services, handling authentication, rate limiting, and CORS.

Runs on **port 8000** via FastAPI + uvicorn.

## REST Endpoints

### Health

| Method | Path             | Auth | Description                                                   |
| ------ | ---------------- | ---- | ------------------------------------------------------------- |
| GET    | `/api/v1/health` | No   | Health check, returns `{"status": "ok", "api_version": "v1", "rate_limiter": "ok"\|"degraded"}` |

### Auth

| Method | Path                    | Auth | Description                                          |
| ------ | ----------------------- | ---- | ---------------------------------------------------- |
| POST   | `/api/v1/auth/register` | No   | Register a new user. Body: `{email, password, name}` |
| POST   | `/api/v1/auth/login`    | No   | Login. Body: `{email, password}`                     |
| POST   | `/api/v1/auth/refresh`  | No   | Refresh access token. Body: `{refresh_token}`        |
| POST   | `/api/v1/auth/logout`   | Yes  | Revoke all refresh tokens for the authenticated user |

### Archive

| Method | Path                                   | Auth | Description                                                       |
| ------ | -------------------------------------- | ---- | ----------------------------------------------------------------- |
| GET    | `/api/v1/archive/pages`                | Yes  | List archived pages. Query params: `page`, `page_size`, `sort_by` |
| GET    | `/api/v1/archive/pages/{page_id}/view` | Yes  | Get a presigned URL to view an archived page                      |
| DELETE | `/api/v1/archive/pages/{page_id}`      | Yes  | Delete an archived page                                           |

### Library

| Method | Path                                                          | Auth | Description                                                           |
| ------ | ------------------------------------------------------------- | ---- | --------------------------------------------------------------------- |
| POST   | `/api/v1/library/collections`                                 | Yes  | Create a collection. Body: `{name, description?, parent_id?, color?}` |
| GET    | `/api/v1/library/collections`                                 | Yes  | List collections. Query param: `parent_id`                            |
| GET    | `/api/v1/library/collections/{id}`                            | Yes  | Get collection details with page count                                |
| PATCH  | `/api/v1/library/collections/{id}`                            | Yes  | Update collection. Body: `{name?, description?, color?}`              |
| DELETE | `/api/v1/library/collections/{id}`                            | Yes  | Delete a collection                                                   |
| POST   | `/api/v1/library/collections/{collection_id}/pages/{page_id}` | Yes  | Add page to collection                                                |
| DELETE | `/api/v1/library/collections/{collection_id}/pages/{page_id}` | Yes  | Remove page from collection                                           |

### Search

| Method | Path             | Auth | Description                                                                    |
| ------ | ---------------- | ---- | ------------------------------------------------------------------------------ |
| GET    | `/api/v1/search` | Yes  | Search archived pages. Query params: `q`, `page`, `page_size`, `collection_id` |

### Share

| Method | Path                           | Auth | Description                                                     |
| ------ | ------------------------------ | ---- | --------------------------------------------------------------- |
| POST   | `/api/v1/share`                | Yes  | Create a share link. Body: `{page_id, is_public?, expires_at?}` |
| DELETE | `/api/v1/share/{token}`        | Yes  | Revoke a share link                                             |
| GET    | `/api/v1/share/public/{token}` | No   | Validate a public share token and get a presigned viewing URL   |

## Middleware

- **AuthMiddleware** — Validates JWT `Bearer` tokens on all non-public paths. Sets `request.state.user_id`, `email`, and `plan`.
- **RateLimitMiddleware** — Redis-backed fixed-window rate limiting (`INCR` + bounded `EXPIRE`; shared across workers):
  - Auth routes: 20 requests/minute per client IP (`CF-Connecting-IP`, falling back to trusted `X-Forwarded-For` when `TRUSTED_PROXIES` is configured, then the peer address)
  - Authenticated routes: 600 requests/minute per user
  - Fails **open** (with an error log and a `rate_limiter: degraded` health signal) when Redis is unreachable
- **CORSMiddleware** — Explicit origin allow-list from `CORS_ALLOW_ORIGINS` (never `*`).

## Configuration

| Variable               | Required | Default                                           | Description                                                                                          |
| ---------------------- | -------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `AUTH_SERVICE_ADDR`    | Yes      | —                                                 | gRPC address of the auth service                                                                     |
| `ARCHIVE_SERVICE_ADDR` | Yes      | —                                                 | gRPC address of the archive service                                                                  |
| `LIBRARY_SERVICE_ADDR` | Yes      | —                                                 | gRPC address of the library service                                                                  |
| `SEARCH_SERVICE_ADDR`  | Yes      | —                                                 | gRPC address of the search service                                                                   |
| `SHARE_SERVICE_ADDR`   | Yes      | —                                                 | gRPC address of the share service                                                                    |
| `JWT_SECRET`           | Yes      | —                                                 | Secret used to verify JWT access tokens. Must not be the dev default when `ENVIRONMENT=production` (startup fails fast) |
| `ENVIRONMENT`          | No       | `development`                                     | `production` enables the secret fail-fast check                                                      |
| `REDIS_URL`            | No       | —                                                 | Redis for the rate limiter; unset → limiter fails open and health reports `degraded`                 |
| `CORS_ALLOW_ORIGINS`   | No       | `https://pagepocket.app,https://app.pagepocket.app` | Comma-separated origin allow-list (never `*`); add `chrome-extension://<id>` entries here          |
| `TRUSTED_PROXIES`      | No       | —                                                 | Comma-separated proxy IPs/CIDRs; required before `X-Forwarded-For` is honored for rate limiting      |
| `MAX_UPLOAD_BYTES`     | No       | `268435456`                                       | Ingest request body cap (413 above the cap; see `validation.py`)                                     |
| `MTLS_ENABLED`         | No       | `false`                                           | Enable mutual TLS for gRPC channels                                                                  |

## Dependencies

**Python packages:** `fastapi`, `uvicorn`, `grpcio`, `grpcio-tools`, `protobuf`, `PyJWT`

**Internal services:** Calls all 5 backend services via gRPC (auth, archive, library, search, share).

**Shared utilities:** `shared/jwt_utils.py` (token verification), `shared/grpc_mtls.py` (mTLS credentials), `shared/proto_generated/` (protobuf stubs).

## Local Development

```bash
cd pagepocket/services/api-gateway
pip install -r requirements.txt

# Set required environment variables
export AUTH_SERVICE_ADDR=localhost:50051
export ARCHIVE_SERVICE_ADDR=localhost:50052
export LIBRARY_SERVICE_ADDR=localhost:50053
export SEARCH_SERVICE_ADDR=localhost:50054
export SHARE_SERVICE_ADDR=localhost:50055
export JWT_SECRET=your-secret

python main.py
# Server starts at http://localhost:8000
```

## Service Communication

The gateway is the only service exposed to clients. It opens gRPC channels (lazily, memoised, 256 MB send/receive limits) to each backend service. Every call carries an explicit `timeout=` deadline (30 s default; 120 s for ingest/push-class calls). Error translation maps gRPC status codes to HTTP responses:

| gRPC Code            | HTTP Status                                                  |
| -------------------- | ------------------------------------------------------------ |
| `UNAUTHENTICATED`    | 401                                                          |
| `ALREADY_EXISTS`     | 409                                                          |
| `INVALID_ARGUMENT`   | 400                                                          |
| `NOT_FOUND`          | 404                                                          |
| `PERMISSION_DENIED`  | 403                                                          |
| `DEADLINE_EXCEEDED`  | 503 (with `Retry-After`)                                     |
| `RESOURCE_EXHAUSTED` | 413 (size) / 402 (quota) / 429 (rate)                        |
