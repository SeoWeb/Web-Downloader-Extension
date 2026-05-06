## MODIFIED Requirements

### Requirement: Download Concurrency Guard
The system SHALL prevent concurrent downloads using per-tab blocking. If a tab already has an active download, the system SHALL reject the new download with an "already in progress" error.

#### Scenario: Download rejected when same tab already downloading
- **GIVEN** Tab A already has a download in progress
- **WHEN** the user initiates a second download on Tab A
- **THEN** the system rejects the request with a "download in progress" error

#### Scenario: Concurrent downloads allowed (different tabs)
- **GIVEN** Tab A has a download in progress
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

#### Scenario: Session creation at download start
- **GIVEN** a download is initiated
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

### Requirement: Parallel Asset Processing

The system SHALL process independent asset categories (images, CSS/JS, documents) concurrently instead of sequentially. Images, CSS/JS assets, and documents have no dependencies on each other and their uploads can proceed in parallel, subject to the UploadQueue's concurrency limit.

#### Scenario: Parallel image and asset processing
- **GIVEN** the download includes images and CSS/JS assets
- **WHEN** the server-mode download flow begins processing resources
- **THEN** `processImages`, `processAssets`, and `processDocuments` are started concurrently
- **AND** all three categories enqueue uploads into the shared UploadQueue simultaneously
- **AND** the UploadQueue manages concurrency across all categories

#### Scenario: Image filename map upload ordering preserved
- **GIVEN** parallel asset processing is active
- **WHEN** the images promise resolves with the `imageFilenameMap`
- **THEN** the filename map is uploaded to the server via `uploadFilenameMap`
- **AND** the CSS/JS and document promises may still be in progress during this upload

#### Scenario: Error in one category does not block others
- **GIVEN** parallel asset processing is active and image processing fails
- **WHEN** the images promise rejects
- **THEN** CSS/JS and document processing continue to completion
- **AND** the overall download reports the error after all promises settle

### Requirement: Adaptive Assembly Polling

The system SHALL use adaptive polling intervals when waiting for server-side assembly completion, instead of a fixed interval. Faster assemblies benefit from shorter intervals, while longer assemblies reduce unnecessary HTTP requests.

#### Scenario: Fast assembly gets quick polling
- **GIVEN** assembly polling has just started (elapsed < 6 seconds)
- **WHEN** the client polls for assembly status
- **THEN** the poll interval is 1 second

#### Scenario: Normal assembly gets moderate polling
- **GIVEN** assembly has been running for 6-30 seconds
- **WHEN** the client polls for assembly status
- **THEN** the poll interval is 2 seconds

#### Scenario: Long assembly gets slower polling
- **GIVEN** assembly has been running for more than 30 seconds
- **WHEN** the client polls for assembly status
- **THEN** the poll interval is 3 seconds

#### Scenario: Very long assembly gets conservative polling
- **GIVEN** assembly has been running for more than 60 seconds
- **WHEN** the client polls for assembly status
- **THEN** the poll interval is 5 seconds

#### Scenario: Assembly timeout unchanged
- **GIVEN** adaptive polling is in use
- **WHEN** the total elapsed time exceeds 5 minutes
- **THEN** an `AssemblyTimeoutError` is thrown regardless of poll interval

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
The system SHALL propagate the `alwaysAskWhereToSave` option from `FilterOptions` through the download pipeline to all `chrome.downloads.download()` calls. Server-mode download functions (`triggerServerDownload`, `waitForDownload`, `downloadWithFallback`) SHALL accept and propagate a `saveAs` parameter.

#### Scenario: Server mode respects saveAs preference
- **GIVEN** `alwaysAskWhereToSave` is `false`
- **WHEN** a server-mode download completes assembly
- **THEN** `downloadWithFallback()` passes `saveAs: false` to `triggerServerDownload()`
- **AND** `chrome.downloads.download` is called with `saveAs: false`

#### Scenario: Manual server download button respects preference
- **GIVEN** `alwaysAskWhereToSave` is `false`
- **WHEN** the user clicks "Download from server" button in the side panel
- **THEN** the setting is read from storage and `chrome.downloads.download` is called with `saveAs: false`
