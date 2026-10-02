## MODIFIED Requirements

### Requirement: Filter Options Configuration

The system SHALL provide configurable filter options for controlling what content is downloaded. A mode indicator SHALL be shown when server mode is active.

#### Scenario: Mode indicator in filter panel

- GIVEN server mode is active (VITE_SERVER_URL is configured at build time)
- WHEN the filter panel is displayed
- THEN a visual badge shows "Server mode" next to the download button
- AND when local mode is active (no VITE_SERVER_URL), no server badge is shown

### Requirement: Download Status Display

The system SHALL display download progress including server upload progress and assembly status when server mode is active.

#### Scenario: Upload progress during server mode

- GIVEN server mode is active and resources are being uploaded
- WHEN the upload progress changes
- THEN the status area shows the number of resources uploaded vs total
- AND a progress bar indicates overall upload completion

#### Scenario: Server assembly status

- GIVEN server mode is active and the session has been finalized
- WHEN the server is assembling the ZIP
- THEN the status area shows "Assembling on server..." with the current assembly phase and progress percentage
- AND the status is updated every 2 seconds via polling

#### Scenario: Assembly timeout notification

- **GIVEN** server mode is active and assembly polling has been running for more than 5 minutes
- **WHEN** the timeout is reached
- **THEN** the status area shows "Server assembly is taking too long"
- **AND** the user is offered a "Download locally" fallback option

#### Scenario: Download ready from server

- GIVEN server mode is active and the server ZIP is ready
- WHEN the assembly completes
- THEN the status area shows "Download ready!"
- AND a "Download from server" button is displayed
- AND clicking the button triggers `chrome.downloads.download` with the server URL

### Requirement: Download Complete Display

The system SHALL display a download complete view with a server download link when server mode is active.

#### Scenario: Server mode download complete

- GIVEN server mode is active and the download is complete
- WHEN the DownloadComplete component renders
- THEN it shows the server download URL
- AND a "Copy link" button allows copying the URL
- AND a "Download again" button triggers another download from the server
- AND if the output is a single HTML file, the download link has an `.html` extension

#### Scenario: Local mode download complete (unchanged)

- **GIVEN** local mode is active and the download is complete
- **WHEN** the DownloadComplete component renders
- **THEN** it shows the existing download complete view without server link

### Requirement: Server Error Display

The system SHALL display server-related errors with a fallback option when server mode is active.

#### Scenario: Server unreachable error

- **GIVEN** server mode is active and the server is unreachable
- **WHEN** a download attempt fails due to server unavailability
- **THEN** an error message is displayed: "Server is unavailable. Try again or download locally."
- **AND** two action buttons are shown: "Retry" and "Download locally"
- **AND** the "Download locally" button includes a warning: "This will re-scrape the page from scratch"

#### Scenario: Server error during download

- **GIVEN** server mode is active and a download fails due to a server error
- **WHEN** the error is received
- **THEN** an error message describes the specific failure (connection lost, server error, or assembly timeout)
- **AND** the user is offered the option to fall back to local mode
- **AND** a warning is displayed that local fallback requires re-scraping the page
- **AND** if the user chooses local mode, the download is restarted with the local pipeline after confirmation
