## MODIFIED Requirements

### Requirement: Session Creation
The server SHALL provide a `POST /api/v1/sessions` endpoint that creates a new download session and returns a session ID. The session's cloud identity SHALL be sourced from the server-side client binding (see `cloud-push-authorization`): a client-supplied `pagepocketUserId` option is accepted only when it matches the authenticated client's stored binding, and is otherwise rejected with 403. Unbound clients get local-only sessions.

#### Scenario: Successful session creation
- **WHEN** a client sends a POST request to `/api/v1/sessions` with a valid API key, a `url` field, and an optional `options` object
- **THEN** the server creates a new session with status `scraping`
- **AND** returns a 201 response with the session ID, upload endpoint URLs, and status

#### Scenario: Session creation with singleFile option
- **WHEN** a client sends a POST request to `/api/v1/sessions` with `options.singleFile` set to `true`
- **THEN** the server creates a session flagged for single-file HTML output
- **AND** the session record stores the `singleFile` option for use during finalization

#### Scenario: Session creation with retention period
- **WHEN** a client sends a POST request to `/api/v1/sessions` with `options.retentionDays` set to a positive integer
- **THEN** the server sets the session's `expires_at` to the specified number of days from creation
- **AND** the value is clamped to a server-configured range (e.g., 1-30 days)
- **AND** if not specified, the default retention is 1 day

#### Scenario: Client-sent pagepocketUserId must match the binding
- **WHEN** a client sends `options.pagepocketUserId` equal to its stored cloud binding
- **THEN** the session is created with that cloud identity

#### Scenario: Forged pagepocketUserId is rejected
- **WHEN** a client sends `options.pagepocketUserId` with another user's ID (or any value while unbound)
- **THEN** the server returns 403 and creates no session
- **AND** finished assemblies of that foreign user's sessions can never be targeted

#### Scenario: Missing API key
- **WHEN** a client sends a POST request to `/api/v1/sessions` without an API key
- **THEN** the server returns a 401 response with an error message

#### Scenario: Invalid API key
- **WHEN** a client sends a POST request to `/api/v1/sessions` with an unrecognized API key
- **THEN** the server returns a 401 response with an error message

### Requirement: Filename Map Upload
The server SHALL provide a `POST /api/v1/sessions/{id}/filename-map` endpoint that receives the extension's image filename map (URL to local filename mapping). Subsequent uploads merge with the existing map, and the merged result SHALL be durably persisted: the ORM change MUST be tracked by the session (copy-before-mutate or explicit dirty marking), never assigned in place on an already-persistent JSON object, which commits nothing.

#### Scenario: Successful filename map upload
- **WHEN** a client uploads a JSON object mapping original URLs to local filenames
- **THEN** the server stores the mapping for use during HTML conversion
- **AND** returns a 200 response with the number of mappings stored

#### Scenario: Incremental filename map update persists
- **WHEN** a client uploads a filename map when one already exists for the session
- **THEN** the server merges the new mappings with the existing map
- **AND** the merged map is actually committed (a follow-up read returns the union, not the original)
- **AND** returns a 200 response with the total number of mappings after merge

#### Scenario: Linked-page download gets complete mappings
- **WHEN** linked pages uploaded after the first filename map reference images recorded only in later map uploads
- **THEN** assembly resolves those images because the incremental merges were persisted

#### Scenario: Filename map upload to assembling session
- **WHEN** a client uploads a filename map to a session in `assembling` status
- **THEN** the server returns a 409 response
- **AND** the existing map is not modified

### Requirement: Resource File Upload
The server SHALL provide a `POST /api/v1/sessions/{id}/resources` endpoint that receives a resource file (image, CSS, JS, document, video) via multipart upload. The endpoint SHALL support pre-compressed payloads using a custom header, and SHALL bound decompression BEFORE decompressing: the inflated size is computed or capped first, and payloads that would exceed the per-resource/session limits are rejected with 413 without allocating the full inflated buffer (gzip-bomb guard).

#### Scenario: Successful resource upload
- **WHEN** a client uploads a resource file with `file` (blob), `path` (ZIP path), `originalUrl`, and `contentType` fields
- **THEN** the server stores the file on disk at a unique location
- **AND** records the resource metadata (original URL, local path, content type, size) in the database
- **AND** increments the session's `resources_received` counter
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

#### Scenario: Upload exceeds total session size limit
- **WHEN** a client uploads a resource that would cause the session's total size to exceed the configured maximum (default 500MB)
- **THEN** the server returns a 413 response with the current size and maximum allowed size
- **AND** the finalization process will still succeed even if some resources fail with 413, resulting in a partial download (missing resources) rather than failing the entire session

#### Scenario: Resource upload rate limiting
- **WHEN** a client sends more than the configured rate of resource upload requests for a single session
- **THEN** the server returns a 429 response with a retry-after header
- **AND** the limit uses a token bucket (rate: 60 requests/second, burst capacity: 100 per session) sized for the extension's parallel upload workers

### Requirement: Session Finalization
The server SHALL provide a `POST /api/v1/sessions/{id}/finalize` endpoint that signals all uploads are complete and triggers HTML merging, URL conversion, and ZIP assembly. The status transition SHALL be race-safe: the transition check and write execute under a row lock (`SELECT ... FOR UPDATE`) or equivalent single-statement guard, so concurrent finalize calls cannot start two assembly pipelines. The client MUST ensure that both the `scrape-complete` signal and the final `filename-map` upload have been confirmed (received 200 ACK) before calling this endpoint.

#### Scenario: Successful finalization
- **WHEN** a client sends a finalize request for a session in `uploading` status that has HTML chunks and resources
- **THEN** the server sets the session status to `assembling`
- **AND** begins the assembly pipeline: merge HTML chunks, convert URLs in HTML, convert URLs in CSS files, assemble ZIP (or single HTML file)
- **AND** returns a 202 response indicating assembly has started
- AND the extension MUST ensure all resource uploads are complete (UploadQueue drained) before calling finalize

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

### Requirement: Content Text Upload
The server SHALL provide a `POST /api/v1/sessions/{id}/content` endpoint that receives text content for inclusion as `content.txt` in the ZIP archive. Repeated uploads SHALL append to the session's stored text (implementation behavior), with the assembled `content.txt` reflecting all received text.

#### Scenario: Successful content text upload
- **WHEN** a client uploads a plain text string to the content endpoint for a session in `scraping` or `uploading` status
- **THEN** the server stores the text content associated with the session
- **AND** returns a 200 response confirming storage
- **AND** if called in `assembling` or `ready` status, returns a 409 response

#### Scenario: Repeated content uploads accumulate
- **WHEN** a client uploads content text when text already exists for the session
- **THEN** the new upload is appended to the stored content (both server implementations behave this way)
- **AND** the assembled `content.txt` contains the accumulated text
