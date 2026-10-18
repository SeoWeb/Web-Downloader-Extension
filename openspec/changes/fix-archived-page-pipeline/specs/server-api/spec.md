## MODIFIED Requirements

### Requirement: Resource File Upload

The server SHALL provide a `POST /api/v1/sessions/{id}/resources` endpoint that receives a resource file (image, CSS, JS, document, video) via multipart upload. The endpoint SHALL support pre-compressed payloads using a custom header, and SHALL bound decompression BEFORE decompressing: the inflated size is computed or capped first, and payloads that would exceed the per-resource/session limits are rejected with 413 without allocating the full inflated buffer (gzip-bomb guard). The endpoint SHALL NOT update the session row's `resources_received` column per upload (per-upload session-row writes are the documented deadlock pattern); the authoritative live count is the status endpoint's aggregate over `resources` rows, and the session-row column is reconciled at finalization (see "Session Finalization").

#### Scenario: Successful resource upload

- **WHEN** a client uploads a resource file with `file` (blob), `path` (ZIP path), `originalUrl`, and `contentType` fields
- **THEN** the server stores the file on disk at a unique location
- **AND** records the resource metadata (original URL, local path, content type, size) in the database
- **AND** the session's live `resources_received` (status endpoint aggregate) increases by one while the session-row column is left untouched mid-flight (no per-upload session-row updates)
- **AND** the endpoint is idempotent: if the `originalUrl` already exists for this session, it returns 200 with the existing resource info without redundant storage
- **AND** returns a 200 response with the resource ID and storage confirmation

#### Scenario: Pre-compressed resource upload

- **WHEN** a client uploads a resource with `X-Content-Gzipped: true` header
- **THEN** the server validates the inflated size against the remaining session budget and a hard per-resource ceiling BEFORE full decompression
- **AND** oversized payloads are rejected with 413 and never fully buffered
- **AND** accepted payloads are decompressed and stored with the uncompressed size recorded

#### Scenario: Gzip bomb is rejected

- **WHEN** a gzipped payload of a few kilobytes declares/inflates to gigabytes
- **THEN** the server rejects it with 413
- **AND** server memory is not exhausted by the decompression attempt

#### Scenario: Resource upload to assembling session

- **WHEN** a client uploads a resource to a session that is already in `assembling` status
- **THEN** the server returns a 409 response indicating that uploads are no longer accepted
- **AND** the resource is not stored

#### Scenario: Resource with duplicate original URL

- **WHEN** a client uploads a resource with an `originalUrl` that already exists in the session
- **THEN** the server skips the duplicate resource (the extension handles deduplication via AssetRegistry)
- **AND** returns a 200 response indicating the resource was deduplicated
- **AND** no new row is created, so the live and reconciled counts do not increase

#### Scenario: Upload exceeds total session size limit

- **WHEN** a client uploads a resource that would cause the session's total size to exceed the configured maximum (default 500MB)
- **THEN** the server returns a 413 response with the current size and maximum allowed size
- **AND** the finalization process will still succeed even if some resources fail with 413, resulting in a partial download (missing resources) rather than failing the entire session

#### Scenario: Resource upload rate limiting

- **WHEN** a client sends more than the configured rate of resource upload requests for a single session
- **THEN** the server returns a 429 response with a retry-after header
- **AND** the limit uses a token bucket (rate: 60 requests/second, burst capacity: 100 per session) sized for the extension's parallel upload workers

### Requirement: Session Finalization

The server SHALL provide a `POST /api/v1/sessions/{id}/finalize` endpoint that signals all uploads are complete and triggers HTML merging, URL conversion, and ZIP assembly. The status transition SHALL be race-safe: the transition check and write execute under a row lock (`SELECT ... FOR UPDATE`) or equivalent single-statement guard, so concurrent finalize calls cannot start two assembly pipelines. The client MUST ensure that both the `scrape-complete` signal and the final `filename-map` upload have been confirmed (received 200 ACK) before calling this endpoint. At finalization the server SHALL reconcile the session row's `resources_received` column to the exact count of stored `resources` rows within the transition commit (one write per session lifetime — never per upload), and when the client-reported `resources_discovered` exceeds that reconciled count, the server SHALL emit a loud structured warning carrying the session id and both counts. The warning is observability only: it SHALL NOT refuse finalization or change any status code (partial downloads remain valid).

#### Scenario: Successful finalization

- **WHEN** a client sends a finalize request for a session in `uploading` status that has HTML chunks and resources
- **THEN** the server sets the session status to `assembling`
- **AND** begins the assembly pipeline: merge HTML chunks, convert URLs in HTML, convert URLs in CSS files, assemble ZIP (or single HTML file)
- **AND** returns a 202 response indicating assembly has started
- AND the extension MUST ensure all resource uploads are complete (UploadQueue drained) before calling finalize

#### Scenario: Column reconciled at finalize

- **WHEN** finalization transitions a session whose `resources` table holds 103 rows
- **THEN** the session row's `resources_received` column reads exactly 103 after the transition commit
- **AND** a subsequent ops read of the column matches the status endpoint's live aggregate for the terminal session

#### Scenario: Discovery/received deficit is logged, not refused

- **WHEN** a client reported `resources_discovered = 105` but only 103 resources are stored at finalize
- **THEN** the server logs a structured warning naming the session id, `resources_discovered: 105`, and `resources_received: 103`
- **AND** finalization still proceeds and returns 202 (partial download semantics unchanged)

#### Scenario: Concurrent finalize calls start exactly one assembly

- **WHEN** two finalize requests for the same session race (e.g., a retry overlapping the original)
- **THEN** exactly one request performs the `uploading → assembling` transition and starts the pipeline
- **AND** the other receives the 409 "already assembling" response and no second assembly task exists

#### Scenario: Finalization rejected for scraping session

- **WHEN** a client sends a finalize request for a session still in `scraping` status
- **THEN** the server returns a 409 response indicating scraping must be completed first (call scrape-complete)

#### Scenario: Finalization with singleFile option

- **WHEN** a client sends a finalize request for a session created with `singleFile` option
- **THEN** the assembly pipeline produces a single `.html` file with all resources inlined as base64
- **AND** the session's output is served directly without ZIP

#### Scenario: Finalization of empty session

- **WHEN** a client sends a finalize request for a session with no HTML chunks and no resources
- **THEN** the server returns a 422 response indicating the session has no content

#### Scenario: Double finalization

- **WHEN** a client sends a finalize request for a session already in `assembling` status
- **THEN** the server returns a 409 response; the client MUST treat this as success and proceed to status polling

- **WHEN** a client sends a finalize request for a session already in `ready` status
- **THEN** the server returns a 409 response; the client MUST treat this as success and use the existing download URL from the status endpoint
