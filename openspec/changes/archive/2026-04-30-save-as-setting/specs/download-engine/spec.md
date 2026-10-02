## MODIFIED Requirements

### Requirement: Download Concurrency Guard
The system SHALL prevent concurrent downloads with a mode-aware guard. In server mode, the guard SHALL be per-tab (each tab may have one active download). In local mode, the guard SHALL be global (only one download across all tabs). When server mode is active, the concurrency guard applies to the combined upload + assembly pipeline.

#### Scenario: Download rejected when another is active (local mode)
- **GIVEN** local mode is active and any tab has a download in progress
- **WHEN** the user initiates a new download on any tab
- **THEN** the system rejects the request with a "download in progress" error
- **AND** the existing download continues unaffected

#### Scenario: Download rejected when same tab already downloading (server mode)
- **GIVEN** server mode is active and Tab A already has a download in progress
- **WHEN** the user initiates a second download on Tab A
- **THEN** the system rejects the request with a "download in progress" error

#### Scenario: Concurrent downloads allowed in server mode (different tabs)
- **GIVEN** server mode is active and Tab A has a download in progress
- **WHEN** the user initiates a download on Tab B
- **THEN** the download on Tab B is allowed to proceed
- **AND** both downloads run concurrently with independent state

#### Scenario: Download flag reset after completion
- **GIVEN** a download has completed (success or failure)
- **WHEN** the cleanup routine runs
- **THEN** the tab is removed from the active downloads set
- **AND** the interrupt checkpoint is cleared from `chrome.storage.session`
- **AND** the tab's keepalive port is disconnected
- **AND** the tab's abort controller is cleared
- **AND** a new download can be initiated on that tab

#### Scenario: Server mode session creation at download start
- **GIVEN** server mode is active (VITE_SERVER_URL is configured at build time)
- **WHEN** the user initiates a download
- **THEN** a server session is created for that tab before any scrolling or resource downloading begins
- **AND** the session ID is stored in the per-tab session state map

#### Scenario: Service worker restart during active download
- **GIVEN** a download was in progress when the service worker was killed
- **WHEN** the service worker restarts
- **THEN** the startup cleanup detects the interrupt checkpoint in `chrome.storage.session`
- **AND** sends a `DOWNLOAD_INTERRUPTED` message to the sidepanel with the checkpoint data
- **AND** resets `isDownloadInProgress` to false
- **AND** clears the checkpoint from `chrome.storage.session`
- **AND** per-tab Maps are empty (rebuilt from scratch after restart)

### Requirement: Download State Tracking
The system SHALL track active downloads using per-tab state management. Each tab SHALL have its own abort controller, keepalive port, and scraper instance stored in Maps keyed by `tabId`.

#### Scenario: Download starts tracking
- **GIVEN** a download is initiated
- **WHEN** the Chrome download API starts
- **THEN** the download ID and filename are stored in the active downloads map
- **AND** a keepalive port connection is established for that tab

#### Scenario: Download completes
- **GIVEN** a tracked download
- **WHEN** Chrome reports the download state as complete
- **THEN** the completion info is stored in chrome.storage.local
- **AND** a completion message is sent to the side panel with the tab's ID
- **AND** the download is removed from the active downloads map
- **AND** the tab's keepalive port is disconnected when no downloads remain for that tab

#### Scenario: Download interrupted by error
- **GIVEN** a tracked download
- **WHEN** Chrome reports the download state as interrupted with a non-user error
- **THEN** a failure message is sent to the side panel with the tab's ID
- **AND** the download is removed from tracking

#### Scenario: Download cancelled by user
- **GIVEN** a tracked download
- **WHEN** Chrome reports the download as interrupted with USER_CANCELED
- **OR** the download is erased from Chrome history
- **THEN** a cancellation message is sent to the side panel with the tab's ID
- **AND** blob URLs are revoked
- **AND** the download is removed from tracking

## ADDED Requirements

### Requirement: Save As parameter propagation in download pipeline
The system SHALL propagate the `alwaysAskWhereToSave` option from `FilterOptions` through the download pipeline to all `chrome.downloads.download()` calls. The `initiateDownload()` function SHALL accept a `saveAs` parameter. Server-mode download functions (`triggerServerDownload`, `waitForDownload`, `downloadWithFallback`) SHALL accept and propagate a `saveAs` parameter.

#### Scenario: Local mode respects saveAs preference
- **GIVEN** `alwaysAskWhereToSave` is `false`
- **WHEN** a local-mode download completes ZIP generation
- **THEN** `initiateDownload()` passes `saveAs: false` to `downloadViaPanel()`
- **AND** the side panel triggers `chrome.downloads.download` with `saveAs: false`

#### Scenario: Server mode respects saveAs preference
- **GIVEN** `alwaysAskWhereToSave` is `false`
- **WHEN** a server-mode download completes assembly
- **THEN** `downloadWithFallback()` passes `saveAs: false` to `triggerServerDownload()`
- **AND** `chrome.downloads.download` is called with `saveAs: false`

#### Scenario: Manual server download button respects preference
- **GIVEN** `alwaysAskWhereToSave` is `false`
- **WHEN** the user clicks "Download from server" button in the side panel
- **THEN** the setting is read from storage and `chrome.downloads.download` is called with `saveAs: false`
