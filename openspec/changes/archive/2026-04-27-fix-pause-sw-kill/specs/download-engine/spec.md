## MODIFIED Requirements

### Requirement: Download Concurrency Guard

The system SHALL prevent concurrent downloads. Only one download MAY be active at a time. When server mode is active, the concurrency guard applies to the combined upload + assembly pipeline.

#### Scenario: Download rejected when another is active

- GIVEN a download is already in progress
- WHEN the user initiates a new download
- THEN the system rejects the request with a "download in progress" error
- AND the existing download continues unaffected

#### Scenario: Download flag reset after completion

- GIVEN a download has completed (success or failure)
- WHEN the cleanup routine runs
- THEN the download-in-progress flag is cleared
- AND the interrupt checkpoint is cleared from `chrome.storage.session`
- AND the keepalive port is disconnected
- AND a new download can be initiated

#### Scenario: Server mode session creation at download start

- GIVEN server mode is active (VITE_SERVER_URL is configured at build time)
- WHEN the user initiates a download
- THEN a server session is created before any scrolling or resource downloading begins
- AND the session ID is used for all subsequent uploads

#### Scenario: Service worker restart during active download

- GIVEN a download was in progress when the service worker was killed
- WHEN the service worker restarts
- THEN the startup cleanup detects the interrupt checkpoint in `chrome.storage.session`
- AND sends a `DOWNLOAD_INTERRUPTED` message to the sidepanel with the checkpoint data
- AND resets `isDownloadInProgress` to false
- AND clears the checkpoint from `chrome.storage.session`
