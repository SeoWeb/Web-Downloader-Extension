## ADDED Requirements

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

## MODIFIED Requirements

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
