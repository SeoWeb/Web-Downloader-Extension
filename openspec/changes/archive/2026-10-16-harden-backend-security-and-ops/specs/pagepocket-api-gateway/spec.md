## MODIFIED Requirements

### Requirement: Rate Limiting
The API Gateway SHALL enforce per-route, per-identity rate limits to protect internal services, using Redis-backed counters (shared across workers, bounded by short expiries — never an unbounded in-memory structure). The identity key for unauthenticated routes SHALL be the real client IP taken from `CF-Connecting-IP` (falling back to the trusted `X-Forwarded-For` value, then the peer address) because the gateway sits behind a proxy. If Redis is unavailable the limiter SHALL fail open and log an error, and the gateway healthcheck SHALL report limiter state.

#### Scenario: Authenticated route limit
- **WHEN** a JWT-authenticated caller exceeds 600 requests per minute on any `/api/v1/*` route
- **THEN** the gateway MUST return HTTP 429 with a `Retry-After` header
- **AND** the request MUST NOT be forwarded to the internal service

#### Scenario: Unauthenticated route limit uses the real client IP
- **WHEN** requests arrive through Cloudflare from many different client IPs
- **THEN** each client IP (`CF-Connecting-IP`) is limited independently on `/api/v1/auth/*` at 20 requests per minute
- **AND** one abusive client cannot exhaust a shared bucket for all users behind the proxy

#### Scenario: Counter storage is bounded
- **WHEN** the limiter runs indefinitely under arbitrary client IPs and user ids
- **THEN** Redis keys expire within the rate window
- **AND** no unbounded per-key memory growth occurs in the gateway process

#### Scenario: Redis unavailable fails open with signal
- **WHEN** Redis is unreachable and a request is rate-limited
- **THEN** the request is forwarded (fail open)
- **AND** the failure is logged and reflected in the gateway healthcheck

## ADDED Requirements

### Requirement: gRPC transport discipline
Every gateway → service gRPC call SHALL carry an explicit deadline, and gateway gRPC channels SHALL be configured with send/receive message-size limits matching the archive service's limits (256 MB), so large legitimate payloads are not rejected client-side. Error translation SHALL distinguish failure classes: `DEADLINE_EXCEEDED` → HTTP 503 with `Retry-After`; size-induced `RESOURCE_EXHAUSTED` → HTTP 413; quota exhaustion keeps 402 and rate exhaustion keeps 429.

#### Scenario: Hung service does not exhaust gateway workers
- **WHEN** an internal service accepts the connection but never responds
- **THEN** the gateway call fails at its deadline
- **AND** the client receives HTTP 503 with `Retry-After` rather than hanging

#### Scenario: Oversized ingest returns 413
- **WHEN** an ingest payload exceeds the message-size limit
- **THEN** the gateway maps the gRPC size failure to HTTP 413
- **AND** the client is not told it exceeded quota (no misleading 402)

#### Scenario: Channel limits match the service
- **WHEN** a payload of 100 MB is sent to the archive service through the gateway
- **THEN** the gateway channel accepts and delivers it (limit ≥ the service's 256 MB setting)

### Requirement: Bounded request buffering
The ingest route SHALL cap accepted request size (content-length check plus bounded reads) before buffering multipart bodies into memory, returning 413 for oversized uploads.

#### Scenario: Oversized multipart upload rejected before buffering
- **WHEN** a client sends an ingest request whose declared size exceeds the configured cap
- **THEN** the gateway returns 413 without reading the body into memory

### Requirement: Production configuration hygiene
The gateway SHALL pin CORS to an explicit allow-list of origins (never `*` in any environment), and SHALL refuse to start in production when `JWT_SECRET` is unset or equals the known development default.

#### Scenario: CORS is pinned
- **WHEN** a request arrives from an origin not on the configured allow-list
- **THEN** no permissive CORS headers are returned for it

#### Scenario: Default secret blocks startup in prod
- **WHEN** the gateway starts with a production configuration and `JWT_SECRET` is the dev default
- **THEN** startup fails with an explicit configuration error
