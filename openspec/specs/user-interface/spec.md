# User Interface Specification

## Purpose

User interface components and interactions for the Website Downloader extension. Covers the side panel, filter configuration, download triggering, status display, permission handling, and scrolling/scraping workflow.

## Requirements

### Requirement: Side Panel Activation

The extension SHALL operate through a Chrome side panel that opens when the extension action is clicked.

#### Scenario: Opening the side panel

- GIVEN the user clicks the extension action button
- WHEN the side panel opens
- THEN the current tab's URL and title are displayed
- AND the download filter options are shown
- AND the download button is available

#### Scenario: No active tab

- GIVEN no active tab is available
- WHEN the side panel loads
- THEN an appropriate error message is displayed

### Requirement: Filter Options Configuration

The system SHALL provide configurable filter options for controlling what content is downloaded. The filter panel, download button, and configuration accordion SHALL be hidden while any scraping or download is in progress (including linked page scraping).

#### Scenario: Default filter options

- GIVEN the side panel is first opened
- WHEN the filter options are displayed
- THEN the defaults are: HTML enabled, images enabled, assets enabled, links disabled, content-as-text disabled, documents enabled, single-file disabled

#### Scenario: Persistent filter options

- GIVEN the user has changed filter options in a previous session
- WHEN the side panel is opened again
- THEN the previously saved filter options are loaded from Chrome storage

#### Scenario: Changing a filter option

- GIVEN the user toggles a filter option
- WHEN the change is applied
- THEN the option is validated according to business rules
- AND the validated option is saved to Chrome storage
- AND the UI reflects the validated state

#### Scenario: Single-file mode overrides

- GIVEN the user enables single-file mode
- WHEN the filter options are validated
- THEN all other download options are disabled
- AND only the single-file option remains enabled

#### Scenario: HTML disabled disables dependent options

- GIVEN the user disables the HTML option
- WHEN the filter options are validated
- THEN links and assets are automatically disabled

#### Scenario: HTML enabled enables dependent options

- GIVEN the user enables the HTML option
- WHEN the filter options are validated
- THEN images and assets are automatically enabled

#### Scenario: No content selected enables defaults

- GIVEN the user disables all content options
- WHEN the filter options are validated
- THEN HTML, images, and assets are automatically enabled as defaults

#### Scenario: Reset to defaults

- GIVEN the user has modified filter options
- WHEN the reset action is triggered
- THEN all options are restored to their default values
- AND the defaults are saved to Chrome storage

#### Scenario: Filter hidden during main page scraping

- **GIVEN** the main page scraping is in progress (isScraping is true)
- **WHEN** the side panel renders
- **THEN** the filter panel, download button, and configuration accordion are hidden

#### Scenario: Filter hidden during linked page scraping

- **GIVEN** the main page scraping has completed but linked pages are still being scraped (isScrapingLinkedPages is true)
- **WHEN** the side panel renders
- **THEN** the filter panel, download button, and configuration accordion remain hidden

#### Scenario: Filter hidden during asset upload and processing

- **GIVEN** the initial page scraping has completed and assets are being uploaded to the server or processed locally (downloadResponse is non-null, download not yet complete)
- **WHEN** the side panel renders
- **THEN** the filter panel, download button, and configuration accordion remain hidden

#### Scenario: Filter shown after download completes

- **GIVEN** the download has completed or been cancelled or failed
- **WHEN** the side panel renders
- **THEN** the filter panel, download button, and configuration accordion are visible again

### Requirement: Filter Option Validation

The system SHALL validate filter option combinations to ensure logical consistency.

#### Scenario: Valid configuration

- GIVEN at least one content type is selected
- WHEN the configuration is validated
- THEN the configuration is considered valid

#### Scenario: Single-file is always valid

- GIVEN the single-file option is enabled
- WHEN the configuration is validated
- THEN the configuration is always valid regardless of other options

#### Scenario: Invalid configuration

- GIVEN no content types are selected and single-file is disabled
- WHEN the configuration is validated
- THEN the configuration is considered invalid

### Requirement: Download Trigger

The system SHALL initiate a download when the user clicks the download button.

#### Scenario: Starting a download

- GIVEN the user clicks the download button
- AND the configuration is valid
- WHEN the download is triggered
- THEN the page is scrolled to capture all content (including lazy-loaded content)
- AND the captured HTML is sent to the background for processing
- AND the status display shows the current progress

#### Scenario: Download with single-file mode

- GIVEN the single-file option is enabled
- WHEN the download is triggered
- THEN the page is captured and converted to a self-contained HTML file

#### Scenario: Download with linked pages

- GIVEN the downloadLinks option is enabled and full scraping is enabled
- WHEN the download is triggered
- THEN linked pages are scraped sequentially after the main page

### Requirement: Page Scrolling for Content Capture

The system SHALL scroll the page to capture all content including lazy-loaded elements.

#### Scenario: Scrolling captures content

- GIVEN a page with lazy-loaded content
- WHEN the scroll-and-scrape process runs
- THEN the page is scrolled from top to bottom
- AND the full HTML is captured at each scroll position

#### Scenario: Reaching the bottom of the page

- GIVEN the scroll position plus viewport height reaches the page height
- WHEN the bottom is detected
- THEN scrolling stops
- AND the download begins with the captured HTML

#### Scenario: Scroll position unchanged

- GIVEN the scroll position has not changed between attempts
- WHEN the stuck condition is detected
- THEN scrolling stops
- AND the download begins with the captured HTML

#### Scenario: Maximum scroll attempts

- GIVEN the scroll attempts exceed 500
- WHEN the safety limit is reached
- THEN scrolling stops
- AND a max-scroll-attempts warning is displayed
- AND the download begins with the captured HTML

### Requirement: Download Status Display

The system SHALL display download progress including server upload progress and assembly status when server mode is active.

#### Scenario: Connected status

- GIVEN the extension has connected to the page
- WHEN the initial status is displayed
- THEN the "Connected" step is active

#### Scenario: Scraping status

- GIVEN the page is being scraped
- WHEN the scraping status is displayed
- THEN the "Scraping Content" step is active
- AND the current status message is shown

#### Scenario: Processing status

- GIVEN resources are being processed and packaged
- WHEN the processing status is displayed
- THEN the "Processing Files" step is active

#### Scenario: Complete status

- GIVEN the download has finished
- WHEN the complete status is displayed
- THEN the "Complete" step is active
- AND a success message is shown

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

### Requirement: Scraping Control Buttons

The system SHALL display pause, resume, and stop buttons continuously throughout the entire download lifecycle — from the moment scraping starts until the download completes, fails, or is cancelled.

#### Scenario: Pause button displayed during main page scraping

- GIVEN the scraper is actively scraping the main page
- WHEN the download status UI is shown
- THEN a "Pause" button is displayed

#### Scenario: Pause button displayed during asset upload and processing

- **GIVEN** the initial page scraping has completed and assets are being uploaded to the server or processed locally
- **WHEN** the download status UI is shown
- **THEN** pause and stop buttons remain visible

#### Scenario: Pause button displayed during linked page scraping

- **GIVEN** linked pages are being scraped
- **WHEN** the download status UI is shown
- **THEN** pause and stop buttons remain visible

#### Scenario: Resume button displayed

- GIVEN the scraper is paused
- WHEN the download status UI is shown
- THEN a "Resume" button replaces the "Pause" button
- AND the "Stop" button remains visible

#### Scenario: Stop button displayed during all phases

- **GIVEN** the download is in progress (scraping, uploading, processing, or paused)
- **WHEN** the download status UI is shown
- **THEN** a "Stop" button is displayed

#### Scenario: Buttons hidden after download completes

- **GIVEN** the download has completed, failed, or been cancelled
- **WHEN** the download status UI is shown
- **THEN** no pause, resume, or stop buttons are displayed

#### Scenario: Pause action

- GIVEN the user clicks the Pause button
- WHEN the action is executed
- THEN the UI immediately shows the paused state
- AND a pause message is sent to the background

#### Scenario: Resume action

- GIVEN the user clicks the Resume button
- WHEN the action is executed
- THEN the UI immediately shows the active state
- AND a resume message is sent to the background

#### Scenario: Stop action

- GIVEN the user clicks the Stop button
- WHEN the action is executed
- THEN a stop message is sent to the background
- AND the scraping state is cleared

### Requirement: Storage Permission Handling

The system SHALL handle the optional `storage` permission for users who need persistent storage.

#### Scenario: Storage permission banner

- GIVEN the user does not have the storage permission granted
- WHEN the side panel loads
- THEN a permission banner is displayed explaining the benefits

#### Scenario: Permission granted

- GIVEN the user grants the storage permission
- WHEN the permission is received
- THEN the banner is dismissed
- AND the page is reloaded to apply the permission

#### Scenario: Permission denied

- GIVEN the user dismisses the permission banner
- WHEN the denial is recorded
- THEN the banner is dismissed
- AND a dismissal flag is stored in localStorage to prevent repeated prompts

### Requirement: Cross-Tab Filter Synchronization

The system SHALL synchronize filter options across multiple side panel instances.

#### Scenario: Filter change in another tab

- GIVEN the user changes filter options in one side panel instance
- AND another side panel instance is open
- WHEN the Chrome storage change event fires
- THEN the other instance's filter options are updated

### Requirement: Storage Error Handling

The system SHALL handle Chrome storage errors gracefully.

#### Scenario: Storage write fails

- GIVEN a filter option change cannot be saved to Chrome storage
- WHEN the save operation fails
- THEN a storage error flag is set
- AND an error message is displayed

#### Scenario: Storage read recovery

- GIVEN the filter options cannot be loaded from Chrome storage
- WHEN the initialization fails
- THEN an error analysis is performed
- AND recovery is attempted
- AND the recovered or default options are used

### Requirement: Download Completion Notification

The system SHALL notify the user when a download completes or fails.

#### Scenario: Download completes successfully

- GIVEN a download finishes
- WHEN the completion message is received
- THEN a success state is displayed in the side panel

#### Scenario: Download cancelled by user

- GIVEN the user cancels the download from the browser
- WHEN the cancellation is detected
- THEN the side panel shows the cancelled state

#### Scenario: Download fails

- GIVEN a download encounters an error
- WHEN the failure message is received
- THEN an error message is displayed in the side panel

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
