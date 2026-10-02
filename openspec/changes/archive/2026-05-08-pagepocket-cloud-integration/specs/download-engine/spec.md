## ADDED Requirements

### Requirement: Cloud upload branch in download pipeline
The download engine (`download-core.ts`) SHALL branch after resource scraping: when cloud mode is active, skip local ZIP generation and upload directly to PagePocket instead.

#### Scenario: Cloud mode skips ZIP creation
- **GIVEN** cloud storage is enabled and the user is authenticated
- **WHEN** resource scraping and processing completes (images, assets, documents gathered)
- **THEN** the pipeline skips `SplitZipGenerator` and `downloadViaPanelAndWait`
- **AND** instead gathers all files and calls `pagepocketClient.ingestPage()`
- **AND** sends `PAGEPOCKET_UPLOAD_COMPLETE` to the sidepanel on success

#### Scenario: Cloud mode sends progress messages
- **GIVEN** a cloud upload is in progress
- **WHEN** bytes are transferred
- **THEN** the pipeline sends `PANEL_MESSAGE` with `{ key: "status.pagepocketUploading", options: { progress } }`

#### Scenario: Cloud upload failure does not affect previous behavior
- **GIVEN** a cloud upload fails (network error, server error, quota)
- **WHEN** the error is caught
- **THEN** a `PAGEPOCKET_UPLOAD_ERROR` message is sent to the sidepanel with the error details
- **AND** the sidepanel shows the error with a retry option

#### Scenario: Local mode pipeline unchanged
- **GIVEN** cloud storage is disabled
- **WHEN** a download runs
- **THEN** the entire local download pipeline executes exactly as before
- **AND** no PagePocket-related code is invoked

### Requirement: Cloud upload uses download ID for idempotency
The cloud upload SHALL use the current download's ID as the `extension_job_id` parameter to ensure idempotent uploads even after service worker restarts.

#### Scenario: Download ID used as extension_job_id
- **GIVEN** a cloud mode download starts with download ID "dl-abc123"
- **WHEN** the upload request is sent to PagePocket
- **THEN** `extension_job_id` is set to "dl-abc123"

#### Scenario: Retry uses same extension_job_id
- **GIVEN** a cloud upload failed and the user clicks "Retry"
- **WHEN** the upload is retried
- **THEN** the same `extension_job_id` is used
- **AND** the backend returns the existing page if it was already created
