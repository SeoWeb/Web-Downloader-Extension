## ADDED Requirements

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
The API Gateway SHALL enforce per-route, per-identity rate limits to protect internal services.

#### Scenario: Authenticated route limit
- **WHEN** a JWT-authenticated caller exceeds 600 requests per minute on any `/api/v1/*` route
- **THEN** the gateway MUST return HTTP 429 with a `Retry-After` header
- **AND** the request MUST NOT be forwarded to the internal service

#### Scenario: Unauthenticated route limit
- **WHEN** an unauthenticated IP exceeds 20 requests per minute on `/api/v1/auth/*`
- **THEN** the gateway MUST return HTTP 429 with a `Retry-After` header

### Requirement: Archive REST Routes
The API Gateway SHALL expose REST routes that map 1:1 to `ArchiveService` RPCs for page listing, viewing, and deletion.

#### Scenario: List pages
- **WHEN** a client sends `GET /api/v1/archive/pages?page=<n>&page_size=<m>&sort_by=<archived_at|title>`
- **THEN** the gateway MUST call `ArchiveService.ListPages` with the authenticated `user_id`
- **AND** return `{ "pages": [...], "total": <int> }`

#### Scenario: View page
- **WHEN** a client sends `GET /api/v1/archive/pages/{page_id}/view`
- **THEN** the gateway MUST call `ArchiveService.GetPageContent` with the authenticated `user_id` and `page_id`
- **AND** return `{ "url": <presigned_r2_url>, "expires_at": <unix_seconds> }`

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

#### Scenario: Validate share link (public)
- **WHEN** an unauthenticated client sends `GET /api/v1/share/public/{token}`
- **THEN** the gateway MUST call `ShareService.ValidateToken` and, on `valid=true`, call `ArchiveService.GetPageContent` using the returned `page_id`
- **AND** return `{ url: <presigned_r2_url>, expires_at: <unix_seconds> }`
- **AND** return HTTP 404 if the token is invalid, revoked, or expired
