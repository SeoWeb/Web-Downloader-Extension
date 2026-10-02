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

## ADDED Requirements

### Requirement: getResources HTML Input Validation
The `getResources` function SHALL validate its HTML input before passing it to `cheerio.load()`. When the input is not a valid string, the function SHALL return empty resource collections instead of throwing.

#### Scenario: Non-string HTML input returns empty collections
- **GIVEN** `getResources` is called with `undefined`, `null`, or a non-string value
- **WHEN** the function executes
- **THEN** it returns `{ css: [], js: [], documents: [], images: [], links: [], text: '' }` without calling `cheerio.load()`

#### Scenario: Empty string returns empty collections
- **GIVEN** `getResources` is called with an empty string
- **WHEN** the function executes
- **THEN** it returns `{ css: [], js: [], documents: [], images: [], links: [], text: '' }` without calling `cheerio.load()`

#### Scenario: Valid HTML string is processed normally
- **GIVEN** `getResources` is called with a valid HTML string
- **WHEN** the function executes
- **THEN** it parses the HTML with `cheerio.load()` and extracts resources as before
