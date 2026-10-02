## ADDED Requirements

### Requirement: Cloud-mode downloads use server pipeline
When PagePocket cloud mode is enabled and the user is authenticated, the extension SHALL route downloads through the normal server-mode pipeline instead of sending data directly to PagePocket. The extension SHALL pass the PagePocket user ID to the local server during session creation via the `pagepocketUserId` session option.

#### Scenario: Cloud mode enabled
- **WHEN** the PagePocket cloud toggle is ON and valid auth tokens exist in `chrome.storage.local`
- **THEN** the extension SHALL create a server session with `pagepocketUserId` set to the authenticated user's ID
- **AND** proceed with the full server-mode download pipeline (HTML chunks, resources, filename maps, linked pages, text content)
- **AND** NOT call `pagepocketClient.ingestPage()` directly

#### Scenario: Cloud mode disabled
- **WHEN** the PagePocket cloud toggle is OFF or no auth tokens exist
- **THEN** the extension SHALL create a server session without `pagepocketUserId`
- **AND** proceed with the normal server-mode download and ZIP assembly flow

### Requirement: Cloud session completion handled via server status
When the extension has created a cloud-mode session, it SHALL detect cloud success or failure from the server's session status response and display the appropriate UI.

#### Scenario: Cloud push succeeds
- **WHEN** the server session status becomes `ready` and the response includes `cloud_page_id`
- **THEN** the extension SHALL send `status.pagepocketUploadComplete` with the `pageId`
- **AND** send `status.complete` without triggering `chrome.downloads.download`

#### Scenario: Cloud push fails
- **WHEN** the server session status becomes `ready` and `cloud_status` is `"failed"`
- **THEN** the extension SHALL send `status.pagepocketUploadError` with the `cloud_error` message
- **AND** treat it as a failed download

### Requirement: Direct-to-cloud code path removed
The `executeDownloadCloudMode` function and `BlobCollector` class SHALL be removed. The `shouldUseCloudUpload` function SHALL be removed or simplified to only extract the user ID for passing to the server.

#### Scenario: No direct PagePocket upload
- **WHEN** a download starts in any mode
- **THEN** the extension SHALL NOT call `pagepocketClient.ingestPage()` during the download pipeline
- **AND** all cloud communication SHALL happen server-side via gRPC
