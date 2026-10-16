# PagePocket API Gateway Specification

## Purpose

The single internet-facing HTTP entry point for PagePocket cloud services: REST-to-gRPC routing, JWT authentication, per-identity rate limiting, quota error mapping, middleware ordering, and request validation.

## Requirements

### Requirement: Public REST Surface
The API Gateway SHALL expose all cloud functionality under `/api/v1/*` as the only internet-facing HTTP entry point and SHALL forward every authorised request to the appropriate internal gRPC service.

#### Scenario: Versioned routing
- **WHEN** a client sends any request to the API Gateway
- **THEN** the route MUST begin with `/api/v1/` (e.g. `/api/v1/auth/login`, `/api/v1/archive/pages`, `/api/v1/library/collections`, `/api/v1/search`, `/api/v1/share`)
- **AND** responses MUST include an `api_version` field in error bodies

#### Scenario: gRPC fan-out
- **WHEN** an authenticated REST request is received for a resource owned by an internal service
- **THEN** the gateway MUST open (or reuse) a gRPC channel to that service using the address from the `*_SERVICE_ADDR` env var
- **AND** translate the request into the corresponding protobuf message and return the service's protobuf response as JSON

### Requirement: JWT Authentication Middleware
The API Gateway SHALL require a valid bearer JWT on every route except `/api/v1/auth/register`, `/api/v1/auth/login`, `/api/v1/auth/refresh`, `/api/v1/share/public/{token}`, and `/api/v1/health`.

#### Scenario: Valid token
- **WHEN** a request includes `Authorization: Bearer <jwt>` and the JWT is valid and unexpired
- **THEN** the gateway MUST decode the payload, attach `user_id` to the request context, and forward the request
- **AND** the `user_id` MUST be propagated as a field in the downstream protobuf message

#### Scenario: Missing or malformed token
- **WHEN** a protected route is requested without an `Authorization` header, with a non-`Bearer` scheme, or with a malformed token
- **THEN** the gateway MUST return HTTP 401 with `{"detail": "Invalid token"}`

#### Scenario: Expired token
- **WHEN** the JWT signature is valid but `exp` is in the past
- **THEN** the gateway MUST return HTTP 401 and the client MUST refresh using `/api/v1/auth/refresh`

#### Scenario: Public share route bypasses auth
- **WHEN** a request to `/api/v1/share/public/{token}` arrives without `Authorization`
- **THEN** the gateway MUST forward to `ShareService.ValidateToken` without requiring a JWT

### Requirement: Rate Limiting
The API Gateway SHALL enforce per-route, per-identity rate limits to protect internal services, with unauthenticated public routes limited per client IP (derived per the spoof-proof rules of `client-identity-propagation`).

#### Scenario: Authenticated route limit
- **WHEN** a JWT-authenticated caller exceeds 600 requests per minute on any `/api/v1/*` route
- **THEN** the gateway MUST return HTTP 429 with a `Retry-After` header
- **AND** the request MUST NOT be forwarded to the internal service

#### Scenario: Unauthenticated route limit
- **WHEN** an unauthenticated IP exceeds 20 requests per minute on `/api/v1/auth/*`
- **THEN** the gateway MUST return HTTP 429 with a `Retry-After` header

#### Scenario: Public share route limit
- **WHEN** an unauthenticated IP exceeds the 20-per-minute class on `/api/v1/share/public/{token}`
- **THEN** the gateway MUST return HTTP 429 with a `Retry-After` header
- **AND** the request MUST NOT reach the share-service (no upstream DB write)

### Requirement: Archive REST Routes
The API Gateway SHALL expose REST routes that map 1:1 to `ArchiveService` RPCs for page listing, viewing, and deletion.

#### Scenario: List pages
- **WHEN** a client sends `GET /api/v1/archive/pages?page=<n>&page_size=<m>&sort_by=<archived_at|title>`
- **THEN** the gateway MUST call `ArchiveService.ListPages` with the authenticated `user_id`
- **AND** return `{ "pages": [...], "total": <int> }`

#### Scenario: View page (no presigned URL)
- **WHEN** a client sends `GET /api/v1/archive/pages/{page_id}/view`
- **THEN** the gateway MUST call `ArchiveService.GetPageContent` with the authenticated `user_id` and `page_id`
- **AND** the response MUST NOT contain any presigned or R2 URL field (the `url`/`signed_url` contract is removed; archived content is delivered exclusively via the sandboxed asset routes)

#### Scenario: Delete page
- **WHEN** a client sends `DELETE /api/v1/archive/pages/{page_id}`
- **THEN** the gateway MUST call `ArchiveService.DeletePage` with the authenticated `user_id`
- **AND** return `{ "success": true | false }`

### Requirement: Auth REST Routes
The API Gateway SHALL expose REST routes that map 1:1 to `AuthService` RPCs.

#### Scenario: Register
- **WHEN** a client sends `POST /api/v1/auth/register` with JSON `{ email, password, name }`
- **THEN** the gateway MUST call `AuthService.Register` and return `{ access_token, refresh_token, expires_at, user }`

#### Scenario: Login
- **WHEN** a client sends `POST /api/v1/auth/login` with JSON `{ email, password }`
- **THEN** the gateway MUST call `AuthService.Login` and return `{ access_token, refresh_token, expires_at, user }`
- **AND** return HTTP 401 if `AuthService` reports invalid credentials

#### Scenario: Refresh
- **WHEN** a client sends `POST /api/v1/auth/refresh` with JSON `{ refresh_token }`
- **THEN** the gateway MUST call `AuthService.Refresh` and return a new `{ access_token, refresh_token, expires_at }` pair

### Requirement: Library, Search, and Share REST Routes
The API Gateway SHALL expose REST routes for collections, tags, search, and share-link operations, each forwarding to the matching internal gRPC service.

#### Scenario: Library collections
- **WHEN** a client sends `GET|POST|PATCH|DELETE /api/v1/library/collections[/{id}]`
- **THEN** the gateway MUST forward to the corresponding `LibraryService` RPC with the authenticated `user_id`

#### Scenario: Search
- **WHEN** a client sends `GET /api/v1/search?q=<query>&page=<n>&page_size=<m>&collection_id=<id?>`
- **THEN** the gateway MUST call `SearchService.Search` and return `{ results: [...], total: <int> }`

#### Scenario: Create share link
- **WHEN** a client sends `POST /api/v1/share` with JSON `{ page_id, is_public, expires_at }`
- **THEN** the gateway MUST call `ShareService.CreateShareLink` and return `{ token, short_url, is_public, expires_at, view_count }`

#### Scenario: Validate share link (public, no presigned URL)
- **WHEN** an unauthenticated client sends `GET /api/v1/share/public/{token}`
- **THEN** the gateway MUST call `ShareService.ValidateToken` and, on `valid=true`, return the page reference metadata only
- **AND** the response MUST NOT contain a presigned R2 URL (the `url` field is removed; delivery is via the sandboxed proxy routes)
- **AND** return HTTP 404 if the token is invalid, revoked, or expired

### Requirement: Middleware Ordering (CORS Outermost)
The gateway SHALL register middleware so that CORS is the outermost layer (added last), guaranteeing that error responses produced by inner layers — including 401 authentication and 429 rate-limit rejections — carry `Access-Control-Allow-Origin` headers.

#### Scenario: 401 response carries CORS headers
- **WHEN** a browser request from an allowed origin arrives without a valid token
- **THEN** the 401 response MUST include `Access-Control-Allow-Origin` for that origin

#### Scenario: 429 response carries CORS headers
- **WHEN** a browser client exceeds a rate limit
- **THEN** the 429 response MUST include `Access-Control-Allow-Origin` so the frontend can read `Retry-After`

### Requirement: Logout Endpoint Contract
The gateway SHALL expose `POST /api/v1/auth/logout` as a request-bodied endpoint whose handler receives the FastAPI `Request` object (typed parameter), forwarding to `AuthService.Logout` so server-side refresh-token revocation executes, and returning success even when the caller sends no JSON body.

#### Scenario: Logout revokes refresh tokens
- **WHEN** an authenticated client sends `POST /api/v1/auth/logout` with no body (or an empty JSON body)
- **THEN** the gateway MUST call `AuthService.Logout`, which revokes all of the user's refresh tokens
- **AND** return HTTP 200 (never 422/500 caused by an untyped `request` query-param binding)

#### Scenario: Logout without valid session
- **WHEN** `POST /api/v1/auth/logout` is called without a valid bearer token
- **THEN** the gateway MUST return HTTP 401 per the JWT middleware rules

### Requirement: Malformed Request Body Handling
The gateway SHALL return HTTP 400 with an `api_version`-stamped error body for malformed or missing JSON bodies and SHALL NOT raise unhandled exceptions from direct dictionary indexing on request payloads in any router.

#### Scenario: Malformed JSON returns 400
- **WHEN** a client sends a non-JSON or syntactically invalid body to a JSON-expecting route (e.g. `POST /api/v1/share`)
- **THEN** the gateway MUST return HTTP 400 (not 500)

#### Scenario: Missing required field returns 400
- **WHEN** a client sends a valid JSON body that lacks required fields
- **THEN** the gateway MUST return HTTP 400 with a field-level detail (never an unguarded `KeyError` 500)

### Requirement: Structured Quota Error Mapping
The gateway SHALL map archive `RESOURCE_EXHAUSTED` errors to HTTP status codes using a machine-readable `exhausted:<reason>` prefix in the gRPC details (`quota` → 402, `size` → 413, `rate` → 429), falling back to the legacy English prose markers for monolith compatibility and logging whenever the fallback fires; marker constants SHALL be shared between gateway and archive-service from one source in `pagepocket/shared/`.

#### Scenario: Structured prefix wins
- **WHEN** the archive-service returns `RESOURCE_EXHAUSTED` with details beginning `exhausted:size`
- **THEN** the gateway MUST return HTTP 413 based on the prefix alone

#### Scenario: Legacy fallback still works
- **WHEN** the details carry only the legacy message (e.g. `"Storage limit reached"`)
- **THEN** the gateway MUST produce the same status via the legacy marker match and MUST log that the fallback path was used

#### Scenario: Shared constants
- **WHEN** gateway and archive-service are inspected for the marker strings
- **THEN** both MUST import them from a single shared module (no duplicated literals)

### Requirement: Ingest Parameter Validation
The gateway SHALL validate `extension_job_id` on ingest before forwarding: length MUST NOT exceed 36 characters and the value MUST match the accepted charset; violations return HTTP 400 (never a downstream 500 from DB column overflow).

#### Scenario: Oversized extension_job_id rejected
- **WHEN** an ingest request carries an `extension_job_id` longer than 36 characters
- **THEN** the gateway MUST return HTTP 400 without calling `ArchiveService.IngestPage`

#### Scenario: Illegal charset rejected
- **WHEN** an `extension_job_id` contains characters outside the accepted set
- **THEN** the gateway MUST return HTTP 400
