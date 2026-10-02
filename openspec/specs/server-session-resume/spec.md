# Server Session Resume Specification

## Purpose

Enables resuming an interrupted server-mode download by reconnecting to the existing server session and re-uploading resources without re-scraping the page.

## Requirements

### Requirement: Server session resume from checkpoint
The system SHALL provide a `resumeServerDownload()` function that reconnects to an existing server session after service worker restart, using the checkpoint's `serverSessionId` and `resourceUrls` to resume uploads without re-scraping the page. When the checkpoint has no `resourceUrls`, the system SHALL query the server's `resources_received` count to determine if resources are already present and recoverable.

#### Scenario: Resume session in UPLOADING status
- **WHEN** `resumeServerDownload()` is called and the server session is in `uploading` status
- **THEN** the system re-extracts resource blobs from the page using the checkpoint's `resourceUrls`
- **AND** uploads all resources to the server (server deduplicates by URL hash)
- **AND** calls `scrapeComplete()` (idempotent — no-op if already called)
- **AND** calls `finalizeSession()` (idempotent — no-op if already in progress)
- **AND** polls for assembly completion

#### Scenario: Resume session in SCRAPING status with resourceUrls
- **WHEN** `resumeServerDownload()` is called and the server session is in `scraping` status with `resourceUrls` in the checkpoint
- **THEN** the system calls `scrapeComplete()` to transition the session
- **AND** re-extracts and uploads resources from the checkpoint's `resourceUrls`
- **AND** calls `finalizeSession()` and polls for completion

#### Scenario: Resume session in SCRAPING status without resourceUrls but server has resources
- **WHEN** `resumeServerDownload()` is called and the server session is in `scraping` status
- **AND** the checkpoint has no `resourceUrls` (or the array is empty)
- **AND** the server's `resources_received` count is greater than 0
- **THEN** the system sends `scrapeComplete()` with the server's `resources_received` count
- **AND** skips resource re-upload entirely
- **AND** calls `finalizeSession()` and polls for assembly completion

#### Scenario: Resume session in SCRAPING status without resourceUrls and server has no resources
- **WHEN** `resumeServerDownload()` is called and the server session is in `scraping` status
- **AND** the checkpoint has no `resourceUrls` (or the array is empty)
- **AND** the server's `resources_received` count is 0
- **THEN** the system throws an error indicating a full restart is required
- **AND** the error message includes both the checkpoint and server state for diagnostics

#### Scenario: Resume session already in ASSEMBLING status
- **WHEN** `resumeServerDownload()` is called and the server session is in `assembling` status
- **THEN** the system skips resource uploads and proceeds directly to polling for assembly completion

#### Scenario: Resume session already READY
- **WHEN** `resumeServerDownload()` is called and the server session is in `ready` status
- **THEN** the system retrieves the download URL from the session status
- **AND** triggers the download immediately without re-uploading

#### Scenario: Resume session FAILED or expired
- **WHEN** `resumeServerDownload()` is called and the server session is in `failed` status or does not exist
- **THEN** the system falls back to a full restart (re-scrape and new session)

### Requirement: Resume message action
The system SHALL provide a `RESUME_SERVER_DOWNLOAD` message action that reads the checkpoint, validates the server session status, and calls `resumeServerDownload()`.

#### Scenario: Sidepanel requests resume
- **WHEN** the sidepanel sends a `RESUME_SERVER_DOWNLOAD` message
- **THEN** the background reads the checkpoint and queries server session status
- **AND** calls `resumeServerDownload()` if a valid session exists
- **AND** falls back to a full restart if the session is not recoverable

### Requirement: Resource re-fetch for resume
The system SHALL re-fetch resource blobs directly from their original URLs using `fetch()` and the checkpoint's `resourceUrls` list. Direct fetching is used instead of the content script because the content script may not be available after a service worker restart. For each URL in the list, the system SHALL fetch the resource with a 60-second timeout and create a blob for upload.

#### Scenario: Resource re-fetch succeeds
- **WHEN** `resumeServerDownload()` processes the checkpoint's `resourceUrls`
- **THEN** each resource is fetched directly from its original URL (not via content script) and enqueued in the upload queue
- **AND** the content type and path from the checkpoint metadata are used

#### Scenario: Some resources fail to fetch during re-fetch
- **WHEN** a resource URL in the checkpoint is no longer available (404, network error, timeout)
- **THEN** the failed resource is skipped and the upload continues with remaining resources
- **AND** the failure is logged but does not abort the resume process
