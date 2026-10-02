## MODIFIED Requirements

### Requirement: Session Persistence with MySQL

The server SHALL persist session and resource metadata in a MySQL 8.0+ database using SQLAlchemy async with aiomysql driver.

#### Scenario: Session record creation

- **WHEN** a new session is created via the API
- **THEN** a session record is stored with fields: id (UUIDv4), client_id (from registration), url, status, options (JSON column including singleFile flag and retentionDays), html_chunks count, resources_discovered (populated from the scrape-complete signal payload), resources_received, created_at, expires_at
- **AND** the session id is a UUIDv4 primary key
- **AND** valid status values are: `scraping`, `uploading`, `assembling`, `ready`, `failed`, `expired`

#### Scenario: Resource record creation

- **WHEN** a resource is uploaded to a session
- **THEN** a resource record is stored with fields: id (UUIDv4), session_id (FK), original_url, local_path, storage_path, content_type, size, uploaded_at
- **AND** a unique constraint exists on `(session_id, url_hash)` where `url_hash` is the SHA-256 hex digest of `original_url` — this avoids MySQL's TEXT index limitation while preserving deduplication semantics; hash collisions are astronomically unlikely (256-bit)
- **AND** the database insert uses an "upsert" pattern (e.g., `ON DUPLICATE KEY UPDATE` or catching `IntegrityError`) to gracefully handle concurrent uploads of the same resource URL without failing the request

#### Scenario: HTML chunk record creation

- **WHEN** an HTML chunk is uploaded to a session
- **THEN** an HTML chunk record is stored with fields: id (UUIDv4), session_id (FK), page_type, page_url, scroll_index, content_hash, storage_path, uploaded_at
- **AND** this record allows grouping and ordering chunks for the main page and linked pages during assembly

#### Scenario: Database initialization on startup

- **WHEN** the server starts and the MySQL database is accessible
- **THEN** the server runs schema migrations to ensure all required tables exist
- **AND** creates necessary indexes on session.client_id, session.status, session.expires_at, and resource.session_id
- **AND** uses InnoDB engine with row-level locking for concurrent access
- **AND** uses utf8mb4 character set for proper Unicode support

#### Scenario: Orphaned API key cleanup

- **WHEN** the cleanup job runs
- **AND** an API key (client_id) has no sessions and was created more than 30 days ago
- **THEN** the client record is deleted to prevent unbounded key accumulation

## ADDED Requirements

### Requirement: Local Fallback Input Validation
The `SERVER_LOCAL_FALLBACK` message handler SHALL validate that required data (HTML content) is present before attempting to start a local download.

#### Scenario: Fallback with missing HTML returns error
- **GIVEN** a `SERVER_LOCAL_FALLBACK` message is received
- **WHEN** the `html` field is missing, undefined, or empty
- **THEN** the handler returns `{ success: false, error: "No HTML content available for local fallback" }`
- **AND** does not call `startDownload`

#### Scenario: Fallback with valid HTML proceeds
- **GIVEN** a `SERVER_LOCAL_FALLBACK` message is received
- **WHEN** the `html` field contains a non-empty string
- **THEN** the handler clears the active server session for the tab
- **AND** calls `startDownload` with the provided HTML, URL, options with `_forceLocal: true`, and tab ID
