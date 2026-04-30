## MODIFIED Requirements

### Requirement: Download Status Display
The system SHALL display download progress including server upload progress and assembly status when server mode is active. Each side panel instance SHALL only display status for its own tab's download, filtering out messages from other tabs.

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
- **AND** clicking the button triggers `chrome.downloads.download` with the server URL

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
