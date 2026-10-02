## REMOVED Requirements

### Requirement: Local Fallback Passes HTML and Options
**Reason**: Local mode pipeline removed. Extension always uses server mode. Server failures present retry UI only.
**Migration**: Remove `SERVER_LOCAL_FALLBACK` message action, `onLocalFallback` UI callback, and `_forceLocal` download option. Server error UI shows retry button only.

## MODIFIED Requirements

### Requirement: Download Status Display
The system SHALL display download progress showing server upload progress and assembly status. Progress messages SHALL be filtered by tab ID to avoid cross-tab interference.

#### Scenario: Server-mode download progress
- **WHEN** a server-mode download is in progress
- **THEN** the UI displays upload progress (X/Y resources uploaded), assembly progress (phase, percentage), and download-ready status with a "Download from server" button

#### Scenario: Download progress filtered by tab
- **WHEN** a progress message arrives with a tabId
- **THEN** the UI only updates if the message's tabId matches the active panel's tabId

### Requirement: Download Concurrency Guard
The system SHALL prevent concurrent downloads using per-tab blocking. If a tab already has an active download, the system SHALL reject the new download with an "already in progress" error.

#### Scenario: Concurrent download rejected per tab
- **WHEN** a download is started for a tab that already has an active download
- **THEN** the system sends an error message and does not start the new download
