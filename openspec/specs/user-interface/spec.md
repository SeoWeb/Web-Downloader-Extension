## MODIFIED Requirements

### Requirement: Download Status Display
The system SHALL display download progress including server upload progress and assembly status when server mode is active. Each side panel instance SHALL only display status for its own tab's download, filtering out messages from other tabs. When the download is complete (`action === DOWNLOAD_DONE`), the DownloadStatus component SHALL hide regardless of the current `serverModeState.phase`.

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
- **WHEN** the chrome.storage change handler detects download completion for the current tab
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
- **AND** the user is offered a "Download locally" fallback option

#### Scenario: Download ready from server
- **GIVEN** server mode is active and the server ZIP is ready
- **WHEN** the assembly completes
- **THEN** the status area shows "Download ready!"
- **AND** a "Download from server" button is displayed
- **AND** clicking the button triggers `chrome.downloads.download` with the server URL and the user's `saveAs` preference

#### Scenario: Panel ignores messages from other tabs
- **GIVEN** Tab A and Tab B both have active server-mode downloads
- **WHEN** Tab B sends a status update message (e.g., "Uploading 5/10 resources")
- **THEN** Tab A's side panel ignores the message (filtered by `tabId`)
- **AND** Tab B's side panel displays the message normally

#### Scenario: Panel accepts messages from own tab
- **GIVEN** Tab A has an active server-mode download
- **WHEN** a status update message arrives with Tab A's `tabId`
- **THEN** Tab A's side panel processes and displays the message

#### Scenario: Download completion message routed to correct tab
- **GIVEN** Tab A and Tab B both have active downloads
- **WHEN** Tab B's download completes and a `DOWNLOAD_COMPLETE` message is sent with Tab B's `tabId`
- **THEN** only Tab B's side panel shows the completion state
- **AND** Tab A's side panel continues showing its own download progress

#### Scenario: Download failure message routed to correct tab
- **GIVEN** Tab A and Tab B both have active downloads
- **WHEN** Tab A's download fails and a `DOWNLOAD_FAILED` message is sent with Tab A's `tabId`
- **THEN** only Tab A's side panel shows the error state
- **AND** Tab B's side panel continues showing its own download progress

## ADDED Requirements

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

### Requirement: Local Fallback Passes HTML and Options
When the user clicks "Download locally" after a server-mode failure, the system SHALL pass the scraped HTML content and download options to the local pipeline via the `SERVER_LOCAL_FALLBACK` message.

#### Scenario: Local fallback includes HTML content
- **GIVEN** a server-mode download has failed and the error UI is displayed
- **WHEN** the user clicks "Download locally"
- **THEN** the `SERVER_LOCAL_FALLBACK` message includes `html` containing the last scraped HTML from the page
- **AND** includes `downloadOptions` with all selected filter options
- **AND** the background handler calls `startDownload` with the provided HTML and options
- **AND** the local pipeline processes the download without crashing

#### Scenario: Local fallback without HTML returns error
- **GIVEN** a server-mode download has failed and no HTML is available (e.g., scraping never started)
- **WHEN** the user clicks "Download locally"
- **THEN** the `SERVER_LOCAL_FALLBACK` message handler returns a `{ success: false, error: "No HTML content available for local fallback" }` response
- **AND** no crash occurs

#### Scenario: Local fallback preserves download options
- **GIVEN** the user selected "Download HTML", "Download Images", and "Single File" options
- **WHEN** the user clicks "Download locally" after a server failure
- **THEN** the local download runs with the same options (downloadHTML=true, downloadImages=true, singleFile=true, downloadAssets/downloadLinks/downloadDocuments/downloadContentAsText as originally set)
- **AND** `_forceLocal` is set to `true` to bypass server mode

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
