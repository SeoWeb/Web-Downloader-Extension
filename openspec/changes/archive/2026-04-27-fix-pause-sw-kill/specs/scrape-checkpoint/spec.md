## ADDED Requirements

### Requirement: Checkpoint written at download start
The system SHALL persist an interrupt checkpoint to `chrome.storage.session` immediately after the keepalive port is established in `downloadResources()`. The checkpoint SHALL contain: `downloadInterrupted: true`, `serverSessionId` (if server mode), `tabId`, `tabUrl`, `timestamp`, and `phase` (initially "scraping").

#### Scenario: Checkpoint written in local mode
- **WHEN** a download starts in local mode
- **THEN** a checkpoint is written to `chrome.storage.session` with `phase: "scraping"`, `tabId`, `tabUrl`, `timestamp`, and no `serverSessionId`

#### Scenario: Checkpoint written in server mode
- **WHEN** a download starts in server mode
- **THEN** a checkpoint is written to `chrome.storage.session` with `phase: "scraping"`, `tabId`, `tabUrl`, `timestamp`, and the active `serverSessionId`

### Requirement: Checkpoint phase updated during download lifecycle
The system SHALL update the checkpoint's `phase` field as the download progresses through phases: "scraping" → "uploading" → "assembling" (server mode) or "scraping" → "packing" (local mode).

#### Scenario: Phase updated when entering upload phase
- **WHEN** the download flow sends `status.waitingForUploads` or `status.sendingScrapeComplete`
- **THEN** the checkpoint phase is updated to "uploading"

#### Scenario: Phase updated when entering assembly phase
- **WHEN** the download flow sends `status.assemblingServer` or `status.finalizingServer`
- **THEN** the checkpoint phase is updated to "assembling"

### Requirement: Checkpoint cleared on download completion or failure
The system SHALL clear the checkpoint from `chrome.storage.session` in the `finally` block of `downloadResources()`.

#### Scenario: Checkpoint cleared on success
- **WHEN** a download completes successfully
- **THEN** the checkpoint entry is removed from `chrome.storage.session`

#### Scenario: Checkpoint cleared on failure
- **WHEN** a download fails with an error
- **THEN** the checkpoint entry is removed from `chrome.storage.session`

#### Scenario: Checkpoint cleared on user stop
- **WHEN** the user presses Stop during a download
- **THEN** the checkpoint entry is removed from `chrome.storage.session`
