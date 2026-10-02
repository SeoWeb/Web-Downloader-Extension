# Storage Specification

## Purpose

Server-side storage for the Website Downloader extension. Covers the server storage adapter that uploads files to the server microservice and post-download cleanup of client-side state.

## Requirements

### Requirement: Storage Adapter Abstraction

The system SHALL provide a storage adapter interface (`IStorageAdapter`) used by the download pipeline. The only adapter SHALL be `ServerStorageAdapter`, which uploads files to the server microservice instead of storing locally.

#### Scenario: File upload to server

- WHEN a file is added via the storage adapter
- THEN the adapter enqueues the file for upload to the server session's resource endpoint

#### Scenario: Storage adapter is read-only for retrieval

- WHEN a file is requested via `getFile()`
- THEN the server adapter returns null (files are not stored locally)

#### Scenario: Resource count from server storage

- GIVEN the ServerStorageAdapter is used
- WHEN `getResourceCount()` is called
- THEN the method returns the current count of resources that have been submitted to the UploadQueue (including queued, in-progress, and completed uploads)
- AND this count is used by the UI for upload progress display ("X/Y resources uploaded")

#### Scenario: Clearing server storage

- GIVEN the ServerStorageAdapter is used
- WHEN `clear()` is called
- THEN a DELETE request is sent to the session endpoint
- AND the server removes all session data
- AND no local cleanup is needed

### Requirement: Post-Download Storage Cleanup

The system SHALL clean up per-tab download state (abort controllers, keepalive ports, force-local flags) after a download completes or fails.

#### Scenario: Cleanup after download completes

- WHEN a download completes (success or failure)
- THEN the system resets per-tab download state, disconnects keepalive port, and clears the download checkpoint
