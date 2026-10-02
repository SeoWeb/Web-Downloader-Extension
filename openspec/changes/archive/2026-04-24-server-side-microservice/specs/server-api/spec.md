## ADDED Requirements

### Requirement: Client Registration

The server SHALL provide a `POST /api/v1/auth/register` endpoint that allows extensions to register and obtain an API key automatically. The user never sees or manages API keys.

#### Scenario: Successful registration

- **WHEN** a client sends a POST request to `/api/v1/auth/register` with a unique client identifier (e.g., extension instance ID)
- **THEN** the server creates a new user record with a generated API key
- **AND** returns a 201 response with the API key

#### Scenario: Re-registration with existing client identifier

- **WHEN** a client sends a POST request to `/api/v1/auth/register` with a client identifier that already exists
- **THEN** the server returns the existing API key for that client
- **AND** does not create a duplicate user record

#### Scenario: Registration rate limiting

- **WHEN** a client sends more than 5 registration requests per minute from the same IP address
- **THEN** the server returns a 429 response with a retry-after header
- **AND** no new user records are created until the rate limit expires

### Requirement: Server Health Check

The server SHALL provide a `GET /api/v1/health` endpoint that returns server status without requiring authentication.

#### Scenario: Server is healthy

- **WHEN** a client sends a GET request to `/api/v1/health`
- **THEN** the server returns a 200 response with status `ok`
- **AND** includes the server version and storage capacity information (available space, total space) in the response

#### Scenario: Server is degraded

- **WHEN** a client sends a GET request to `/api/v1/health` and the server has issues (e.g., storage nearly full)
- **THEN** the server returns a 200 response with status `degraded` and a description of the issue
- **AND** the extension treats `degraded` as available but logs the reason internally

### Requirement: Session Creation

The server SHALL provide a `POST /api/v1/sessions` endpoint that creates a new download session and returns a session ID.

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
- **AND** if not specified, the default retention is 7 days

#### Scenario: Missing API key

- **WHEN** a client sends a POST request to `/api/v1/sessions` without an API key
- **THEN** the server returns a 401 response with an error message

#### Scenario: Invalid API key

- **WHEN** a client sends a POST request to `/api/v1/sessions` with an unrecognized API key
- **THEN** the server returns a 401 response with an error message

### Requirement: Scraping Completion Signal

The server SHALL provide a `POST /api/v1/sessions/{id}/scrape-complete` endpoint that signals all HTML chunks have been uploaded, transitioning the session from `scraping` to `uploading` status.

#### Scenario: Scraping completion signal accepted

- **WHEN** a client sends a POST request to `/api/v1/sessions/{id}/scrape-complete` for a session in `scraping` status
- **THEN** the server transitions the session status to `uploading`
- **AND** if the request body includes a `resourceCount` integer field, the server stores it as `resources_discovered` on the session record (used for UI progress display: "X/Y resources uploaded")
- **AND** returns a 200 response confirming the status transition

#### Scenario: Scraping complete for non-scraping session

#### Scenario: Scraping complete for non-scraping session

- **WHEN** a client sends a POST request to `/api/v1/sessions/{id}/scrape-complete` for a session not in `scraping` status
- **THEN** the server returns a 409 response indicating the session is not in the correct status
- **AND** the client MUST ensure all previously uploaded HTML chunks have received a 200 ACK before sending this signal

#### Scenario: Scraping complete for non-existent session

- **WHEN** a client sends a POST request to `/api/v1/sessions/{id}/scrape-complete` for a session that does not exist
- **THEN** the server returns a 404 response

### Requirement: Content Text Upload

The server SHALL provide a `POST /api/v1/sessions/{id}/content` endpoint that receives text content for inclusion as `content.txt` in the ZIP archive.

#### Scenario: Successful content text upload

- **WHEN** a client uploads a plain text string to the content endpoint for a session in `scraping` or `uploading` status
- **THEN** the server stores the text content associated with the session
- **AND** returns a 200 response confirming storage
- **AND** if called in `assembling` or `ready` status, returns a 409 response

#### Scenario: Content text replaces previous upload

- **WHEN** a client uploads content text when one already exists for the session
- **THEN** the server replaces the previous content with the new upload

### Requirement: HTML Chunk Upload

The server SHALL provide a `POST /api/v1/sessions/{id}/html` endpoint that receives an HTML chunk and appends it to the session's HTML content.

#### Scenario: First HTML chunk initializes the skeleton

- **WHEN** a client uploads the first HTML chunk to a session with `scrollIndex` 0 and `pageType` of `main`
- **THEN** the server stores it as the HTML skeleton with chunk index 0
- **AND** returns a 200 response with the current chunk count and total size

#### Scenario: Subsequent HTML chunks are appended

- **WHEN** a client uploads an additional HTML chunk to a session that already has a skeleton and is in `scraping` status
- **THEN** the server appends the chunk to the session's chunk list with the provided `scrollIndex`
- **AND** returns a 200 response with the updated chunk count and total size
- **AND** if the session is already in `assembling` or later status, returns a 409 response (uploads in `uploading` status are still accepted because linked-page HTML chunks may arrive after the scrape-complete signal)

#### Scenario: Duplicate chunk detection

- **WHEN** a client uploads an HTML chunk with identical content hash AND scrollIndex to a previously uploaded chunk for the same session and page
- **THEN** the server skips the duplicate chunk
- **AND** returns a 200 response indicating the chunk was deduplicated

#### Scenario: Linked page HTML chunk

- **WHEN** a client uploads an HTML chunk with `pageType` of `linked` and a `pageUrl` field
- **THEN** the server stores the chunk as part of the linked page's HTML content
- **AND** associates the chunk with the linked page URL for later assembly

#### Scenario: Chunk exceeds size limit

- **WHEN** a client uploads an HTML chunk larger than the configured maximum chunk size (25% of max total size)
- **THEN** the server returns a 413 response with the chunk size and maximum allowed size

#### Scenario: Upload to non-existent session

- **WHEN** a client uploads an HTML chunk to a session ID that does not exist
- **THEN** the server returns a 404 response

### Requirement: Resource File Upload

The server SHALL provide a `POST /api/v1/sessions/{id}/resources` endpoint that receives a resource file (image, CSS, JS, document, video) via multipart upload. The endpoint SHALL support pre-compressed payloads using a custom header.

#### Scenario: Successful resource upload

- **WHEN** a client uploads a resource file with `file` (blob), `path` (ZIP path), `originalUrl`, and `contentType` fields
- **THEN** the server stores the file on disk at a unique location
- **AND** records the resource metadata (original URL, local path, content type, size) in the database
- **AND** increments the session's `resources_received` counter
- **AND** the endpoint is idempotent: if the `originalUrl` already exists for this session, it returns 200 with the existing resource info without redundant storage
- **AND** returns a 200 response with the resource ID and storage confirmation

#### Scenario: Pre-compressed resource upload

- **WHEN** a client uploads a resource with `X-Content-Gzipped: true` header
- **THEN** the server decompresses the `file` field content before storing the file
- **AND** the stored file size reflects the uncompressed size

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

- **WHEN** a client sends more than 600 resource upload requests per minute for a single session
- **THEN** the server returns a 429 response with a retry-after header
- **AND** the limit uses a token bucket algorithm (rate: 10 tokens/second = 600/minute, burst capacity: 20) to allow for initial bursts during parallel uploads

### Requirement: Filename Map Upload

The server SHALL provide a `POST /api/v1/sessions/{id}/filename-map` endpoint that receives the extension's image filename map (URL to local filename mapping). Subsequent uploads merge with the existing map, allowing incremental updates as linked pages discover new images.

#### Scenario: Successful filename map upload

- **WHEN** a client uploads a JSON object mapping original URLs to local filenames
- **THEN** the server stores the mapping for use during HTML conversion
- **AND** returns a 200 response with the number of mappings stored

#### Scenario: Incremental filename map update

- **WHEN** a client uploads a filename map when one already exists for the session
- **THEN** the server merges the new mappings with the existing map
- **AND** new entries are added; existing entries are overwritten
- **AND** returns a 200 response with the total number of mappings after merge

#### Scenario: Filename map upload to assembling session

- **WHEN** a client uploads a filename map to a session in `assembling` status
- **THEN** the server returns a 409 response
- **AND** the existing map is not modified

### Requirement: Session Finalization

The server SHALL provide a `POST /api/v1/sessions/{id}/finalize` endpoint that signals all uploads are complete and triggers HTML merging, URL conversion, and ZIP assembly. The client MUST ensure that both the `scrape-complete` signal and the final `filename-map` upload have been confirmed (received 200 ACK) before calling this endpoint.

#### Scenario: Successful finalization

- **WHEN** a client sends a finalize request for a session in `uploading` status that has HTML chunks and resources
- **THEN** the server sets the session status to `assembling`
- **AND** begins the assembly pipeline: merge HTML chunks, convert URLs in HTML, convert URLs in CSS files, assemble ZIP (or single HTML file)
- **AND** returns a 202 response indicating assembly has started
- AND the extension MUST ensure all resource uploads are complete (UploadQueue drained) before calling finalize

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

### Requirement: Session Status Query

The server SHALL provide a `GET /api/v1/sessions/{id}/status` endpoint that returns the current state of a session.

#### Scenario: Session in scraping phase

- **WHEN** a client queries the status of a session in `scraping` status
- **THEN** the server returns the status, HTML chunk count, and resources received count

#### Scenario: Session in uploading phase

- **WHEN** a client queries the status of a session in `uploading` status
- **THEN** the server returns the status, resources received count, and resources discovered count (if pre-declared)
- **AND** the `uploading` status indicates HTML scraping is complete (scrape-complete signal received) but resource uploads are still in progress

#### Scenario: Session in assembly phase

- **WHEN** a client queries the status of a session in `assembling` status
- **THEN** the server returns the status, assembly phase (one of: `merging_html`, `converting_urls`, `converting_css`, `assembling_zip`), and a progress percentage for the current phase

#### Scenario: Session ready for download

- **WHEN** a client queries the status of a session in `ready` status
- **THEN** the server returns the status, output file size, download URL, and output type (`zip` or `html`)

#### Scenario: Session failed

- **WHEN** a client queries the status of a session in `failed` status
- **THEN** the server returns the status, assembly phase that failed, and an error message describing the failure

### Requirement: ZIP Download

The server SHALL provide a `GET /api/v1/sessions/{id}/download` endpoint that serves the completed ZIP file or single HTML file.

#### Scenario: Successful ZIP download

- **WHEN** a client requests the download for a session in `ready` status with output type `zip`
- **THEN** the server returns the ZIP file with `Content-Type: application/zip`
- **AND** sets `Content-Disposition` with the original filename derived from the URL

#### Scenario: Successful single HTML download

- **WHEN** a client requests the download for a session in `ready` status with output type `html`
- **THEN** the server returns the HTML file with `Content-Type: text/html; charset=utf-8`
- **AND** sets `Content-Disposition` with an `.html` filename

#### Scenario: Download before assembly complete

- **WHEN** a client requests the download for a session not in `ready` status
- **THEN** the server returns a 409 response indicating the ZIP is not yet ready

#### Scenario: Download with range request

- **WHEN** a client requests a byte range of the ZIP file
- **THEN** the server supports HTTP range requests for resumable downloads
- **AND** returns a 206 response with the requested byte range

### Requirement: Session Deletion

The server SHALL provide a `DELETE /api/v1/sessions/{id}` endpoint that cancels or deletes a session and its files.

#### Scenario: Delete a session in scraping or uploading status

- **WHEN** a client deletes a session that is still receiving uploads
- **THEN** the server removes all uploaded files and session directories from disk
- **AND** removes the session and resource records from the database
- **AND** returns a 200 response

#### Scenario: Delete a completed session

- **WHEN** a client deletes a session in `ready` status
- **THEN** the server removes the ZIP/HTML file and all resource files from disk
- **AND** removes the session and resource records from the database

#### Scenario: Delete a session in assembling status

- **WHEN** a client deletes a session currently in `assembling` status
- **THEN** the server cancels the background assembly task first
- **AND** once the task is confirmed stopped, removes the session and resource records from the database
- **AND** then deletes any partial output files and all resource files from disk (best-effort; orphaned session directories without a DB record are also cleaned on server startup)
- **AND** returns a 200 response

### Requirement: Session Listing

The server SHALL provide a `GET /api/v1/sessions` endpoint that lists sessions for the authenticated user.

#### Scenario: List user sessions

- **WHEN** a client requests the session list with a valid API key
- **THEN** the server returns all sessions belonging to that API key, ordered by creation date descending
- **AND** each entry includes session ID, URL, status, creation date, output file size (if ready), and output type

#### Scenario: Pagination

- **WHEN** a client requests sessions with `limit` and `offset` query parameters
- **THEN** the server returns the requested page of sessions
- **AND** includes a total count in the response

### Requirement: API Versioning

The server SHALL prefix all API routes with `/api/v1` and include the API version in error responses.

#### Scenario: Versioned endpoint

- **WHEN** a client accesses any API endpoint
- **THEN** the route is prefixed with `/api/v1`

#### Scenario: Version in error response

- **WHEN** the server returns an error response
- **THEN** the response includes an `api_version` field with the current version string

### Requirement: Session Status Transition

The server SHALL enforce valid session status transitions. Valid statuses are: `scraping`, `uploading`, `assembling`, `ready`, `failed`, `expired`.

#### Scenario: Status transitions from scraping

- **WHEN** a session is in `scraping` status
- **THEN** the session can transition to `uploading` (when scrape-complete is called) or `failed`

#### Scenario: Status transitions from uploading

- **WHEN** a session is in `uploading` status
- **THEN** the session can transition to `assembling` (when finalize is called) or `failed`

#### Scenario: Status transitions from assembling

- **WHEN** a session is in `assembling` status
- **THEN** the session can transition to `ready` or `failed`

#### Scenario: Invalid status transition

- **WHEN** an operation would cause an invalid status transition
- **THEN** the server returns a 409 response with the current and requested status

### Requirement: CORS Configuration

The server SHALL configure CORS to allow requests from Chrome extension origins.

#### Scenario: Extension origin allowed

- **WHEN** a request is received with an `Origin` header matching `chrome-extension://`
- **THEN** the server allows the request with appropriate CORS headers
- AND allowed methods are: GET, POST, DELETE, OPTIONS
- AND allowed headers are: Content-Type, X-API-Key, X-Content-Gzipped

#### Scenario: Non-extension origin

- **WHEN** a request is received with an `Origin` header that does not match `chrome-extension://`
- **THEN** the server may still allow the request (for health checks and direct API access)
- **AND** the CORS policy is configurable via server settings

### Requirement: Session Size Limits

The server SHALL enforce configurable size limits on sessions to prevent abuse.

#### Scenario: Default session size limit

- **WHEN** a session is created
- **THEN** the maximum total session size is 500MB by default
- **AND** the maximum HTML chunk size is 25% of the total session limit

#### Scenario: Configurable session size limit

- **WHEN** the server is configured with a custom `MAX_SESSION_SIZE_MB` setting
- **THEN** sessions respect the configured limit
- **AND** uploads exceeding the limit return a 413 response

### Requirement: UUIDv4 Session Identifiers

The server SHALL use UUIDv4 for all session identifiers to ensure they are non-guessable.

#### Scenario: Session ID generation

- **WHEN** a new session is created
- **THEN** the session ID is a UUIDv4 (cryptographically random, 122 bits of entropy)
- **AND** the ID cannot be predicted or enumerated

#### Scenario: Resource ID generation

- **WHEN** a new resource record is created
- **THEN** the resource ID is a UUIDv4
