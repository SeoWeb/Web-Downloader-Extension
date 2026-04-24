# Storage Specification

## Purpose

Persistent storage and ZIP generation for the Website Downloader extension. Covers the storage adapter abstraction, IndexedDB-based file storage, session management, blob storage, and multi-part ZIP generation for large downloads.

## Requirements

### Requirement: Storage Adapter Abstraction

The system SHALL provide a unified storage interface that supports multiple backends including a new ServerStorageAdapter for server mode.

#### Scenario: Adding a file to local storage (IndexedDB)

- GIVEN a file path, content, and optional MIME type
- WHEN the file is added to the IndexedDB storage adapter
- THEN the file is stored at the specified path in IndexedDB
- AND the content is normalized to a Blob

#### Scenario: Adding a file to server storage

- GIVEN a file path, content, and optional MIME type
- WHEN the file is added to the ServerStorageAdapter
- THEN the content is uploaded to the server as a resource
- AND the upload is tracked in the upload queue
- AND the content is not stored locally

#### Scenario: Storage adapter selection based on build configuration

- GIVEN the `VITE_SERVER_URL` env variable is set at build time
- WHEN a download session starts
- THEN the ServerStorageAdapter is used for all file storage operations
- AND when the env variable is not set, the IndexedDB adapter is used

#### Scenario: Retrieving a file from local storage

- GIVEN a file path that exists in local storage
- WHEN the file is requested from the IndexedDB adapter
- THEN the file content is returned as a Blob

#### Scenario: Retrieving a file from server storage

- **GIVEN** a file path requested from the ServerStorageAdapter
- **WHEN** the file is requested
- **THEN** null is returned (server storage is write-only from the extension's perspective)

#### Scenario: Listing files from server storage

- **GIVEN** the ServerStorageAdapter is used
- **WHEN** `getAllFiles()` is called
- **THEN** an empty array is returned
- **AND** consumers of the storage adapter MUST NOT depend on this method for resource enumeration in server mode (the server manages file enumeration during assembly)

#### Scenario: Resource count from server storage

- **GIVEN** the ServerStorageAdapter is used
- **WHEN** `getResourceCount()` is called
- **THEN** the method returns the current count of resources that have been submitted to the UploadQueue (including queued, in-progress, and completed uploads)
- **AND** this count is used by the UI for upload progress display ("X/Y resources uploaded")
- **AND** `getResourceCount()` is a method on `ServerStorageAdapter` only (not part of the base `IStorageAdapter` interface, which retains `getAllFiles()` for local mode)

#### Scenario: Clearing server storage

- **GIVEN** the ServerStorageAdapter is used
- **WHEN** `clear()` is called
- **THEN** a DELETE request is sent to the session endpoint
- **AND** the server removes all session data
- **AND** no local cleanup is needed

### Requirement: IndexedDB File Storage

The system SHALL store downloaded files in IndexedDB for persistence beyond the service worker lifecycle.

#### Scenario: Storing a file in IndexedDB

- GIVEN a download session ID, a file path, and content
- WHEN the file is stored
- THEN the file is saved with a composite key of `{downloadId}-{path}`
- AND the blob size and MIME type are recorded
- AND the timestamp is recorded

#### Scenario: Retrieving file metadata

- GIVEN a download session ID
- WHEN file metadata is requested
- THEN the file paths, sizes, and IDs are returned
- AND the actual blob content is not loaded

#### Scenario: Deleting all files for a download

- GIVEN a download session ID
- WHEN the download is deleted
- THEN all files associated with that session are removed
- AND the session record itself is removed

#### Scenario: Cleaning up old downloads

- GIVEN files older than 24 hours
- WHEN the cleanup routine runs
- THEN the old files are deleted
- AND the old sessions are deleted
- AND the count of deleted files is returned

#### Scenario: Storage statistics

- GIVEN files stored in IndexedDB
- WHEN storage statistics are requested
- THEN the total file count, total size, and active session count are returned

### Requirement: Session Management

The system SHALL support both local session management (IndexedDB) and remote session management (server API).

#### Scenario: Local session management

- GIVEN local mode is active
- WHEN a download session is created
- THEN the session is managed via SessionManager with IndexedDB persistence
- AND the session lifecycle follows the existing local flow

#### Scenario: Remote session management

- GIVEN server mode is active
- WHEN a download session is created
- THEN the session is created on the server via the API
- **AND** the session ID from the server is a UUIDv4
- **AND** the session starts in `scraping` status
- **AND** the extension calls scrape-complete after all HTML chunks are uploaded, transitioning to `uploading` status
- **AND** the session status transitions to `uploading` when the scrape-complete signal is received by the server
- **AND** session status is queried from the server rather than local IndexedDB
- **AND** valid server statuses are: `scraping`, `uploading`, `assembling`, `ready`, `failed`, `expired`

#### Scenario: Remote session status tracking

- GIVEN server mode is active and a session exists on the server
- WHEN the extension polls the session status
- THEN the server returns the current status (scraping, uploading, assembling, ready, failed)
- AND the extension updates its UI accordingly
- AND during `assembling` status, the assembly phase and progress percentage are included

### Requirement: Blob Storage for Panel Delegation

The system SHALL provide blob storage for delegating downloads to the side panel in local mode. In server mode, blob storage and panel delegation are not needed.

#### Scenario: Local mode blob storage

- GIVEN local mode is active and a ZIP file has been generated
- WHEN the download needs to be delegated to the side panel
- THEN the blob is stored in shared IndexedDB (blobStorage)
- AND the side panel reads the blob and creates a download URL

#### Scenario: Server mode skips blob storage

- GIVEN server mode is active and the server ZIP is ready
- WHEN the download is triggered
- THEN no blob storage or side panel delegation is needed
- AND the browser downloads directly from the server URL

### Requirement: Multi-Part ZIP Generation

The system SHALL generate multi-part ZIP archives when the total download size exceeds a threshold (25MB per part).

#### Scenario: Small download generates single ZIP

- GIVEN a download where the total content fits within the part size
- WHEN the ZIP is generated
- THEN a single `.zip` file is produced

#### Scenario: Large download generates split ZIP

- GIVEN a download where the total content exceeds the part size
- WHEN the ZIP is generated
- THEN the ZIP is split into parts of 25MB each
- AND the first part has a 4-byte spanning signature
- AND parts are named `.z01`, `.z02`, etc.
- AND the last part is named `.zip`
- AND the central directory and end-of-central-directory records reference the correct disk numbers and offsets

#### Scenario: Multi-part download requires side panel

- GIVEN a download that will produce multiple ZIP parts
- WHEN the ZIP generation begins
- THEN the side panel MUST be available for URL.createObjectURL
- AND if the panel is not available, an error is thrown

#### Scenario: Memory pressure check between ZIP parts

- GIVEN a multi-part ZIP is being generated
- WHEN a part is about to be downloaded
- THEN memory pressure is checked
- AND if pressure is critical, the system waits for cleanup and suggests garbage collection
- AND if the side panel becomes unavailable during generation, the download is aborted

#### Scenario: Delay between ZIP parts

- GIVEN a multi-part ZIP is being generated
- AND a part has just been downloaded
- WHEN the next part is ready
- THEN a 2-second delay is applied between parts
- AND garbage collection is suggested if available

### Requirement: Post-Download Storage Cleanup

The system SHALL clean up storage after a download completes.

#### Scenario: Successful download cleanup

- GIVEN a download that completed successfully
- WHEN the cleanup routine runs
- THEN the session status is set to "complete"
- AND all stored files for that download are deleted from IndexedDB
- AND download-specific blobs are cleaned up

#### Scenario: Failed download cleanup

- GIVEN a download that failed
- WHEN the cleanup routine runs
- THEN the session status is set to "failed" with the error message
- AND the stored files are preserved for potential debugging
