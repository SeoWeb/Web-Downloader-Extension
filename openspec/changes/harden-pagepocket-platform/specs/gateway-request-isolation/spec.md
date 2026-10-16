## ADDED Requirements

### Requirement: Non-Blocking Upstream Calls
The API Gateway SHALL NOT block its asyncio event loop on synchronous gRPC stub calls: every route handler SHALL dispatch stub invocations to a worker thread (e.g. Starlette's `run_in_threadpool`) so that one slow upstream call can never stall concurrent request handling, including `/api/v1/health`.

#### Scenario: Health stays responsive during a long ingest
- **WHEN** an `IngestPage`-class request is in flight against a slow upstream service (e.g. a 120 s deadline) and a client sends `GET /api/v1/health`
- **THEN** the health request MUST be answered promptly (well within the compose healthcheck's 5 s timeout) without waiting for the in-flight upstream call

#### Scenario: Every stub call is threadpool-dispatched (AST gate)
- **WHEN** the gateway test-suite parses all router modules under `pagepocket/services/api-gateway/routers/`
- **THEN** every synchronous gRPC stub call site MUST be wrapped in a `run_in_threadpool` dispatch
- **AND** a violation (a bare stub call inside an `async def` handler) MUST fail the test suite via the AST convention established in `pagepocket/services/api-gateway/tests/test_grpc_transport.py`

### Requirement: Multi-Worker Serving
The API Gateway SHALL run uvicorn with more than one worker process, configured via the `GATEWAY_WORKERS` environment variable with a default of 2, and this SHALL be safe because rate limiting and session state are backed by Redis (not in-process memory).

#### Scenario: Worker count honored
- **WHEN** the gateway container starts with `GATEWAY_WORKERS=4`
- **THEN** uvicorn MUST spawn 4 worker processes

#### Scenario: Default worker count
- **WHEN** the gateway starts without `GATEWAY_WORKERS` set
- **THEN** uvicorn MUST spawn 2 worker processes

#### Scenario: Multi-worker rate limiting stays correct
- **WHEN** two workers concurrently serve requests from the same identity
- **THEN** the shared Redis-backed limiter MUST count both toward the same bucket (no per-process double allowance)

### Requirement: Bounded Cumulative Ingest
The API Gateway SHALL enforce a cumulative upload bound on the ingest route: the sum of the HTML part plus all asset parts MUST NOT exceed `max_upload_bytes()`, the asset count MUST NOT exceed `MAX_INGEST_ASSETS` (default 200), and ingest requests without a declared `Content-Length` MUST be rejected.

#### Scenario: Cumulative bytes exceed the cap
- **WHEN** an ingest request's `html_bytes + Σ asset_bytes` exceeds `max_upload_bytes()` even though every individual multipart part is under the per-part cap
- **THEN** the gateway MUST reject the request with HTTP 413 immediately (before forwarding upstream)

#### Scenario: Too many assets
- **WHEN** an ingest request carries more than `MAX_INGEST_ASSETS` asset parts
- **THEN** the gateway MUST reject the request with HTTP 413

#### Scenario: Missing Content-Length on ingest
- **WHEN** an ingest request arrives with a chunked transfer encoding and no `Content-Length`
- **THEN** the gateway MUST reject it with HTTP 413 (or 400) and MUST NOT stream it upstream

#### Scenario: Within-bounds ingest proceeds
- **WHEN** an ingest request's total bytes and asset count are within the configured bounds and `Content-Length` is declared
- **THEN** the gateway MUST forward it to `ArchiveService.IngestPage` unchanged

### Requirement: Ingest Executor Capacity
The gateway SHALL bound the concurrency of long-running ingest-class upstream calls through a dedicated bounded executor (or an explicitly enlarged AnyIO threadpool capacity) so that concurrent large pushes cannot exhaust the default thread pool and starve all other routes.

#### Scenario: Concurrent ingests do not exhaust the pool
- **WHEN** more concurrent large ingest requests arrive than the executor's bounded capacity
- **THEN** excess ingests queue without preventing short-lived requests on other routes from being served

### Requirement: Transient Upstream Outage Semantics
The API Gateway SHALL translate transient gRPC failures into retryable HTTP responses: `UNAVAILABLE` and `DEADLINE_EXCEEDED` MUST both map to HTTP 503 with a `Retry-After` header, while non-transient status codes keep their existing mappings.

#### Scenario: Search service down
- **WHEN** the search-service is unreachable and a client calls `GET /api/v1/search`
- **THEN** the gateway MUST return HTTP 503 with a `Retry-After` header (not a bare 500)

#### Scenario: Deadline exceeded
- **WHEN** an upstream RPC raises `DEADLINE_EXCEEDED`
- **THEN** the gateway MUST return HTTP 503 with a `Retry-After` header

#### Scenario: Non-transient failures unchanged
- **WHEN** an upstream RPC fails with `NOT_FOUND` or `INVALID_ARGUMENT`
- **THEN** the gateway MUST keep its existing 404/400 mapping (503 is reserved for transient failures)
