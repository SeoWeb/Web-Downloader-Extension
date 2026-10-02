## REMOVED Requirements

### Requirement: IndexedDB File Storage
**Reason**: Local mode removed. Files are uploaded to the server, not stored in IndexedDB.
**Migration**: Delete `file-store.ts`, `database.ts`. No replacement needed.

### Requirement: Blob Storage for Panel Delegation
**Reason**: Local mode removed. Server-mode downloads use `chrome.downloads.download({ url })` directly, no blob transfer to side panel needed.
**Migration**: Delete `blobStorage.ts`. Remove blob cleanup from cleanup handlers.

### Requirement: Multi-Part ZIP Generation
**Reason**: Local mode removed. ZIP assembly happens server-side. No client-side ZIP generation needed.
**Migration**: Delete `zip-stream-splitter.ts` and `JSZipAdapter`. No replacement needed.

### Requirement: Session Management
**Reason**: Local IndexedDB session management removed. Server manages sessions via API.
**Migration**: Delete `session-manager.ts`. Server session lifecycle managed via `serverClient`.

## MODIFIED Requirements

### Requirement: Storage Adapter Abstraction
The system SHALL provide a storage adapter interface (`IStorageAdapter`) used by the download pipeline. The only adapter SHALL be `ServerStorageAdapter`, which uploads files to the server microservice instead of storing locally.

#### Scenario: File upload to server
- **WHEN** a file is added via the storage adapter
- **THEN** the adapter enqueues the file for upload to the server session's resource endpoint

#### Scenario: Storage adapter is read-only for retrieval
- **WHEN** a file is requested via `getFile()`
- **THEN** the server adapter returns null (files are not stored locally)

### Requirement: Post-Download Storage Cleanup
The system SHALL clean up per-tab download state (abort controllers, keepalive ports, force-local flags) after a download completes or fails.

#### Scenario: Cleanup after download completes
- **WHEN** a download completes (success or failure)
- **THEN** the system resets per-tab download state, disconnects keepalive port, and clears the download checkpoint
