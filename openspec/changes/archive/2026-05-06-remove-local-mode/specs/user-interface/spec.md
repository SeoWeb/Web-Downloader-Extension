## REMOVED Requirements

### Requirement: Local Fallback Button
**Reason**: Local mode removed. Server error UI shows retry button only, no "Download locally" fallback.
**Migration**: Remove `onLocalFallback` prop from `DownloadStatus`, remove `SERVER_LOCAL_FALLBACK` message handling from sidepanel and message worker.

## MODIFIED Requirements

### Requirement: Download Status Display
The system SHALL always display server-mode download progress (upload progress, assembly progress, download-ready status). No mode-selection logic in the UI.

#### Scenario: Server error display
- **WHEN** a server-mode download fails
- **THEN** the UI shows an error card with retry button
- **AND** does NOT show a "Download locally" fallback button

#### Scenario: Server-mode state always active
- **WHEN** the side panel is open
- **THEN** server-mode state tracking is always active (no `IS_SERVER_MODE` conditional)
