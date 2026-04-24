## MODIFIED Requirements

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
