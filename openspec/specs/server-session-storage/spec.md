# Server Session Storage Specification

## Purpose

Server-side session persistence, file storage, lifecycle management, and cleanup for the Website Downloader microservice. Covers MySQL database storage, local filesystem operations, auto-expiry, restart recovery, and client isolation.

## Requirements

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

### Requirement: File Storage on Local Filesystem

The server SHALL store uploaded resource files and assembled ZIPs on the local filesystem.

#### Scenario: Resource file storage

- **WHEN** a resource file is uploaded
- **THEN** the file is stored under `<storage_root>/<session_id>/resources/<resource_id>`
- **AND** the file's storage_path in the database points to this location

#### Scenario: HTML chunk file storage

- **WHEN** an HTML chunk is uploaded
- **THEN** the raw HTML content is stored as a file under `<storage_root>/<session_id>/chunks/<page_type>/<page_url_hash>/<scroll_index>.html`
- **AND** the `<page_url_hash>` is the first 16 hex characters of the SHA-256 hash of the full `pageUrl` (or "main" for the primary page) to prevent directory path issues and collisions
- **AND** the HTML chunk record's storage_path points to this location

#### Scenario: ZIP file storage

- **WHEN** ZIP assembly is complete
- **THEN** the ZIP file is stored under `<storage_root>/<session_id>/output/<filename>.zip`
- **AND** the session's zip_path in the database points to this location

#### Scenario: Storage directory creation

- **WHEN** a session is created
- **THEN** the storage directory `<storage_root>/<session_id>/resources/` is created

#### Scenario: HTML chunk files cleaned up after merge

- **WHEN** the HTML merge step completes successfully during finalization
- **THEN** the server deletes all chunk files from `<storage_root>/<session_id>/chunks/` to reclaim disk space
- **AND** the HTML chunk records in the database are marked as merged (or deleted) so they are not re-processed
- **AND** the merged HTML content is retained as the session's final HTML (stored separately under `<storage_root>/<session_id>/output/`)

### Requirement: Session Auto-Expiry

The server SHALL automatically expire sessions after a configurable retention period.

#### Scenario: Session expires after retention period

- **WHEN** a session's `expires_at` timestamp is reached
- **THEN** the server marks the session as `expired`
- **AND** deletes all associated resource files and ZIP from disk
- **AND** deletes the session and resource records from the database

#### Scenario: Default retention period

- **WHEN** a session is created without specifying a retention period
- **THEN** the `expires_at` is set to 1 day from creation

#### Scenario: Configurable retention period

- **WHEN** a session is created with a `retentionDays` parameter
- **THEN** the `expires_at` is set to `retentionDays` from creation

### Requirement: Server Restart Recovery

The server SHALL recover gracefully from restarts by detecting stale sessions.

#### Scenario: Stale sessions marked as failed on startup

- **WHEN** the server starts
- **THEN** all sessions in `scraping` or `uploading` status that were last updated more than `STALE_SESSION_TIMEOUT_MINUTES` ago (default 30) are marked as `failed`
- **AND** an error message is stored indicating the server restarted
- **AND** the extension will detect the failed status and offer local fallback
- **AND** the timeout threshold is configurable to accommodate slow uploads of large sessions

#### Scenario: Assembling sessions on restart

- **WHEN** the server starts and a session is in `assembling` status
- **THEN** the session is marked as `failed` with an error indicating assembly was interrupted
- **AND** the partial ZIP file is cleaned up from disk

#### Scenario: Ready sessions preserved on restart

- **WHEN** the server starts and sessions are in `ready` status
- **THEN** those sessions remain available for download
- **AND** their ZIP files are expected to still exist on disk

#### Scenario: Periodic cleanup does not kill active assemblies

- **WHEN** the periodic cleanup runs
- **AND** a session is in `assembling` status
- **THEN** the cleanup SHALL NOT mark the session as failed if an active assembly task is registered in the `AssemblyTaskManager`
- **AND** the cleanup SHALL NOT mark the session as failed if it has been in `assembling` status for less than `STALE_SESSION_TIMEOUT_MINUTES`

#### Scenario: Periodic cleanup marks stale assemblies as failed

- **WHEN** the periodic cleanup runs
- **AND** a session has been in `assembling` status for longer than `STALE_SESSION_TIMEOUT_MINUTES`
- **AND** no active assembly task is registered for that session
- **THEN** the session is marked as `failed` with an error indicating assembly timed out
- **AND** the partial output file is cleaned up from disk

### Requirement: Cleanup Cron Job

The server SHALL run a periodic cleanup job that removes expired sessions.

#### Scenario: Cleanup runs periodically

- **WHEN** the server is running
- **THEN** a cleanup job runs every hour
- **AND** removes all sessions with `expires_at` in the past
- **AND** marks stale assembling sessions as failed (per "Periodic cleanup marks stale assemblies as failed" scenario)

#### Scenario: Cleanup on startup

- **WHEN** the server starts
- **THEN** a one-time cleanup runs to remove any sessions that expired while the server was down
- **AND** stale session recovery (see Server Restart Recovery) runs before expiry cleanup
- **AND** ALL sessions in `assembling` status are marked as failed (background tasks are lost on restart)
- **AND** an orphan scan is performed: any session directory under `<storage_root>/` whose UUID does not correspond to a session record in the database is deleted from disk, covering cases where a crash occurred between DB record deletion and disk file deletion

### Requirement: Session Size Limits

The server SHALL enforce configurable size limits on sessions to prevent abuse.

#### Scenario: Default session size limit

- **WHEN** a session is created
- **THEN** the maximum total session size is 500MB by default (configurable via `MAX_SESSION_SIZE_MB`)
- **AND** the maximum HTML chunk size is 25% of the total session limit

#### Scenario: Session size exceeded

- **WHEN** a resource upload would cause the session's total stored size to exceed the configured limit
- **THEN** the upload is rejected with a 413 response
- **AND** the session's current total size is tracked in the database

### Requirement: Client Isolation via API Key

The server SHALL isolate sessions and data between different registered clients (API keys).

#### Scenario: Client can only access own sessions

- **WHEN** a client queries sessions or downloads with their API key
- **THEN** only sessions created with that API key are returned or accessible

#### Scenario: Cross-client access denied

- **WHEN** a client attempts to access a session created by a different API key
- **THEN** the server returns a 403 response
