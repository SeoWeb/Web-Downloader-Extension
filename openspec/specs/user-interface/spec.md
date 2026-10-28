# User Interface Specification

## Purpose

Governs the side panel UI: download status display routed by download identity (pinned origin tab/session, not the panel's live active tab) with terminal states always evaluated and hiding on completion, single-flow resume, the download liveness watchdog, panel push resilience, restarting the complete UI on a new download, server-retry session resets, the "Always ask where to save file" toggle, and Stop-button delegation to the scraping hook.

## Requirements

### Requirement: Download Status Display

The system SHALL display download progress showing server upload progress and assembly status. Messages SHALL be routed by the identity of the download they belong to — the origin tab and server session pinned when that download started — and SHALL NOT be filtered against the panel's live active tab. Progress-class messages SHALL apply only when they match the tracked download. Terminal download states (`DOWNLOAD_COMPLETE`, `DOWNLOAD_FAILED`, `DOWNLOAD_CANCELLED`, `DOWNLOAD_INTERRUPTED`, server error/timeout) SHALL always be evaluated against the tracked download and, when they match, SHALL resolve the in-progress UI regardless of which tab the user is currently viewing. Download controls (Pause/Resume/Stop) SHALL target the download's pinned origin tab. When the download is complete (`action === DOWNLOAD_DONE`), the DownloadStatus component SHALL hide regardless of the current `serverModeState.phase`. No mode-selection logic in the UI.

#### Scenario: DOWNLOAD_DONE hides uploading UI

- **GIVEN** server mode is active and `serverModeState.phase` is `uploading`
- **WHEN** `DOWNLOAD_COMPLETE` sets `action` to `DOWNLOAD_DONE`
- **THEN** the DownloadStatus component returns null (hides)
- **AND** no "Uploading resources..." UI is shown

#### Scenario: DOWNLOAD_DONE hides assembling UI

- **GIVEN** server mode is active and `serverModeState.phase` is `assembling`
- **WHEN** `DOWNLOAD_COMPLETE` sets `action` to `DOWNLOAD_DONE`
- **THEN** the DownloadStatus component returns null (hides)

#### Scenario: serverModeState reset on DOWNLOAD_COMPLETE

- **GIVEN** server mode is active and `serverModeState.phase` is `uploading`
- **WHEN** the `DOWNLOAD_COMPLETE` handler fires
- **THEN** `serverModeState.phase` is set to `ready`

#### Scenario: serverModeState reset on storage completion

- **GIVEN** server mode is active and `serverModeState.phase` is `uploading`
- **WHEN** the chrome.storage change handler detects download completion for the tracked download
- **THEN** `serverModeState.phase` is set to `ready`

#### Scenario: No duplicate completion messages from storage handler

- **GIVEN** the `DOWNLOAD_COMPLETE` message handler has already set `action` to `DOWNLOAD_DONE`
- **WHEN** the chrome.storage change handler fires for the same download
- **THEN** no additional messages are pushed to the messages array
- **AND** no duplicate state updates occur
- **AND** the `downloadComplete` storage entry is cleaned up

#### Scenario: Connected status

- **GIVEN** the extension has connected to the page
- **WHEN** the initial status is displayed
- **THEN** the "Connected" step is active

#### Scenario: Scraping status

- **GIVEN** the page is being scraped
- **WHEN** the scraping status is displayed
- **THEN** the "Scraping Content" step is active
- **AND** the current status message is shown

#### Scenario: Processing status

- **GIVEN** resources are being processed and packaged
- **WHEN** the processing status is displayed
- **THEN** the "Processing Files" step is active

#### Scenario: Complete status

- **GIVEN** the download has finished
- **WHEN** the complete status is displayed
- **THEN** the "Complete" step is active
- **AND** a success message is shown

#### Scenario: Upload progress during server mode

- **GIVEN** server mode is active and resources are being uploaded
- **WHEN** the upload progress changes
- **THEN** the status area shows the number of resources uploaded vs total
- **AND** a progress bar indicates overall upload completion

#### Scenario: Server assembly status

- **GIVEN** server mode is active and the session has been finalized
- **WHEN** the server is assembling the ZIP
- **THEN** the status area shows "Assembling on server..." with the current assembly phase and progress percentage
- **AND** the status is updated every 2 seconds via polling

#### Scenario: Assembly timeout notification

- **GIVEN** server mode is active and assembly polling has been running for more than 5 minutes
- **WHEN** the timeout is reached
- **THEN** the status area shows "Server assembly is taking too long"
- **AND** the user is offered a retry button

#### Scenario: Download ready from server

- **GIVEN** server mode is active and the server ZIP is ready
- **WHEN** the assembly completes
- **THEN** the status area shows "Download ready!"
- **AND** a "Download from server" button is displayed
- **AND** clicking the button triggers `chrome.downloads.download` with the server URL and the user's `saveAs` preference

#### Scenario: Progress updates follow the tracked download, not the active tab

- **GIVEN** the panel is tracking a download that started on tab A
- **WHEN** the user switches to tab B while the download is running
- **THEN** progress updates for the tracked download continue to be applied and displayed
- **AND** the panel's in-progress UI does not freeze due to the tab switch

#### Scenario: Progress messages from other downloads are ignored

- **GIVEN** the panel is tracking a download whose origin is tab A
- **WHEN** a progress message arrives belonging to a different download (different origin tab/session)
- **THEN** the panel ignores the message and the tracked download's state is unchanged

#### Scenario: Terminal state delivered after a tab switch

- **GIVEN** a download started on tab A is uploading or assembling
- **WHEN** the user switches to tab B and the download completes
- **THEN** the completion state resolves the in-progress UI (spinner dismissed, completion shown)
- **AND** `serverModeState.phase` is set to `ready`

#### Scenario: Failure and cancellation delivered after a tab switch

- **GIVEN** a download started on tab A is uploading or assembling
- **WHEN** the user switches to tab B and the download fails or is cancelled
- **THEN** the error/cancelled state resolves the in-progress UI with the corresponding card
- **AND** the panel does not remain stuck on the spinner or Stop card

#### Scenario: Controls target the download's origin tab

- **GIVEN** a download that started on tab A is in progress and the user is viewing tab B
- **WHEN** the user clicks Pause, Resume, or Stop
- **THEN** the corresponding control message (`SCRAPER_PAUSE`, `SCRAPER_RESUME`, `SCRAPER_STOP`) is sent with tab A's id
- **AND** tab B is never targeted

#### Scenario: Server error display

- **WHEN** a server-mode download fails
- **THEN** the UI shows an error card with retry button
- **AND** does NOT show a "Download locally" fallback button

#### Scenario: Server-mode state always active

- **WHEN** the side panel is open
- **THEN** server-mode state tracking is always active (no `IS_SERVER_MODE` conditional)

### Requirement: Download Complete UI Hides on New Download

When the download complete UI is displayed and the user initiates a new download by clicking "Start Download", the system SHALL hide the download complete UI and SHALL display the download progress UI.

#### Scenario: New download hides complete UI

- **GIVEN** a previous download has completed and `action` is `DOWNLOAD_DONE`
- **WHEN** the user clicks "Start Download" to begin a new download
- **THEN** `action` is reset to `null`
- **AND** the `DownloadComplete` component returns `null` (hides)
- **AND** the `DownloadStatus` component renders (shows)
- **AND** the `Actions` stepper component renders (shows)

#### Scenario: New download clears interrupt state

- **GIVEN** a previous download was interrupted and `interruptData` is set
- **WHEN** the user clicks "Start Download" to begin a new download
- **THEN** `interruptData` is reset to `null`
- **AND** the interrupt card in `DownloadStatus` does not render

### Requirement: Server Retry Resets Session State

When the user clicks "Retry" after a server-mode failure, the system SHALL reset all server session refs and create a fresh server session for the re-attempt.

#### Scenario: Retry creates new server session

- **GIVEN** a server-mode download has failed and the error UI is displayed
- **WHEN** the user clicks the "Retry" button
- **THEN** the system resets the server session ID ref, scroll index ref, session-created flag, and last-HTML ref
- **AND** sets the scraping state to active
- **AND** the scraping hook creates a new server session on the first scroll iteration
- **AND** the new download proceeds with a fresh session

#### Scenario: Retry does not reuse failed session

- **GIVEN** a server-mode download failed with session ID "abc-123"
- **WHEN** the user clicks "Retry"
- **THEN** the system clears the stored session ID "abc-123"
- **AND** creates a new session with a different ID
- **AND** the old session remains on the server for its retention period

### Requirement: Save As toggle in configuration UI

The system SHALL display an "Always ask where to save file" toggle checkbox in the Configuration section of the Filter component. The toggle SHALL reflect and update the `alwaysAskWhereToSave` setting in real-time.

#### Scenario: Toggle visible in configuration section

- **GIVEN** the user opens the Configuration section
- **WHEN** the Filter component renders
- **THEN** an "Always ask where to save file" checkbox is visible
- **AND** it is checked by default

#### Scenario: Toggle changes setting

- **GIVEN** the "Always ask where to save file" checkbox is checked
- **WHEN** the user unchecks it
- **THEN** `alwaysAskWhereToSave` is set to `false` in Chrome storage
- **AND** the next download will proceed automatically without a dialog

#### Scenario: Setting persists across sessions

- **GIVEN** the user has unchecked the toggle
- **WHEN** the side panel is reopened or the browser restarts
- **THEN** the checkbox remains unchecked
- **AND** downloads continue to auto-save

### Requirement: Stop Button Delegates to Scraping Hook

The Stop button in the DownloadStatus component SHALL delegate to an `onStopScraping` callback provided by `useScrapingDownloader` instead of directly calling `setIsScraping(false)`. The callback SHALL send the `SCRAPER_STOP` message to the background, set an internal stop flag, and then set `isScraping` to `false`.

#### Scenario: Stop button calls onStopScraping during first-page scrape

- **GIVEN** the user is viewing the download status during main page scrolling
- **WHEN** the user clicks the Stop button
- **THEN** `onStopScraping()` is called
- **AND** the `SCRAPER_STOP` message is sent to the background
- **AND** the internal stop flag is set in the scraping hook
- **AND** `setIsScraping(false)` is called
- **AND** the `useEffect` in the hook checks the stop flag and starts the download with linked-page processing disabled

#### Scenario: Stop button works during linked page scraping (unchanged behavior)

- **GIVEN** the extension is scraping linked pages
- **WHEN** the user clicks the Stop button
- **THEN** `onStopScraping()` is called
- **AND** the `SCRAPER_STOP` message stops the `LinkedPageScraper`
- **AND** `abortActiveDownload` is called
- **AND** the linked page scraper finalizes and creates the ZIP with completed pages

#### Scenario: Stop button visible during all scraping phases

- **GIVEN** the extension is in any scraping phase (main page, linked pages, uploading, assembling)
- **WHEN** the download status component renders
- **THEN** the Stop button is visible and functional
- **AND** clicking it calls `onStopScraping`

### Requirement: Single-Flow Resume

When the user clicks Resume/Restart on the interrupted-download card, the system SHALL drive exactly one download flow. The resume path SHALL NOT enter the scraping pipeline: it SHALL NOT set the scraping state active, SHALL NOT create a new server session, SHALL NOT scroll or stream the tab, and SHALL NOT trigger the hook's automatic `START_DOWNLOAD` effect. Only the resume-failure fallback (full restart) MAY start a scrape run, and it SHALL pass through the same single-run gate as a fresh press, so each user action produces at most one flow.

#### Scenario: One resume click starts exactly one flow

- **GIVEN** a download was interrupted and the Resume/Restart card is displayed
- **WHEN** the user clicks Resume
- **THEN** exactly one background flow runs (`RESUME_SERVER_DOWNLOAD` continuing the existing server session)
- **AND** no new server session is created and the tab is not scrolled

#### Scenario: Resume does not trigger the automatic download effect

- **GIVEN** the resume path has been started from the interrupt card
- **WHEN** the scraping state is not active and the hook's effects evaluate
- **THEN** no `START_DOWNLOAD` is fired for the resume action
- **AND** stale download options from the interrupted run do not re-arm the automatic download effect

#### Scenario: Resume failure fallback starts exactly one restart

- **GIVEN** a resume attempt failed (e.g. expired session or server unreachable)
- **WHEN** the panel falls back to a full restart
- **THEN** exactly one scrape run starts, gated by the same single-fire mechanism as a fresh press
- **AND** repeated fallback triggers do not stack additional concurrent runs

#### Scenario: Rapid repeated resume clicks do not duplicate

- **GIVEN** the user clicks Resume twice in quick succession
- **WHEN** the second click arrives while the first resume flow is in flight
- **THEN** no second resume flow or additional server session is created

### Requirement: Download Liveness Watchdog

While the panel is tracking a server-mode download whose phase is `uploading` or `assembling`, the panel SHALL arm a liveness watchdog. Any message belonging to the tracked download (progress push, 15-second heartbeat, assembly progress, or a terminal state) SHALL reset the watchdog. If no such message arrives for 45 seconds (three missed 15-second heartbeats), the panel SHALL transition to the interrupted-download state, presenting the same interrupted card (with Resume/Restart actions) used for `DOWNLOAD_INTERRUPTED`. The watchdog SHALL disarm on any terminal state, on a new download, and whenever no download is tracked, and SHALL NOT arm during scraping or idle phases. A terminal message that arrives for the tracked download SHALL always win over a concurrently expiring watchdog.

#### Scenario: Panel transitions to interrupted after missed heartbeats

- **GIVEN** a server-mode download is in the `uploading` phase and the service worker dies
- **WHEN** no message belonging to the tracked download arrives for 45 seconds
- **THEN** the panel shows the interrupted-download card with Resume/Restart actions
- **AND** the frozen spinner/progress card is dismissed

#### Scenario: Any tracked-download message resets the watchdog

- **GIVEN** the watchdog is armed during `uploading` or `assembling`
- **WHEN** a heartbeat or progress message for the tracked download arrives
- **THEN** the watchdog timer restarts without transitioning the UI

#### Scenario: Terminal message wins over the watchdog

- **GIVEN** the watchdog timer is about to expire
- **WHEN** a terminal message (complete, failed, cancelled) arrives for the tracked download
- **THEN** the terminal state resolves the UI normally and no interrupted card is shown

#### Scenario: Watchdog inactive when no download is in progress

- **GIVEN** the panel is idle or a download is in the scraping phase
- **WHEN** 45 seconds pass without messages
- **THEN** the watchdog does not fire and the UI is unchanged

### Requirement: Panel Push Resilience

Background push helpers that notify the panel SHALL catch and ignore (or log-and-ignore) delivery failures, such as the panel being closed ("Receiving end does not exist"), so that no unhandled promise rejections occur in the service worker and no download pipeline code path is affected by a failed push. Loss of a non-terminal push SHALL NOT affect the download; loss of a terminal push SHALL be recoverable through the storage-backed fallback or the interrupted-download discovery on panel open.

#### Scenario: Push with the panel closed does not produce unhandled rejections

- **GIVEN** a download is running in the background service worker
- **WHEN** a progress push or heartbeat is attempted after the side panel has been closed
- **THEN** the rejection is caught and logged at debug level
- **AND** no unhandled promise rejection is reported in the service worker
- **AND** the download continues unaffected

#### Scenario: Terminal state survives a lost push

- **GIVEN** a terminal download state occurs while the panel is closed or the push is lost
- **WHEN** the panel is reopened or the storage change is observed
- **THEN** the terminal state is surfaced through the storage fallback or interrupted-download discovery
- **AND** the panel does not show a stranded in-progress UI
