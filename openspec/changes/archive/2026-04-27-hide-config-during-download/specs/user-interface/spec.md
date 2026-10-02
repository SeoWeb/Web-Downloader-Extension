## MODIFIED Requirements

### Requirement: Filter Options Configuration

The system SHALL provide configurable filter options for controlling what content is downloaded. A mode indicator SHALL be shown when server mode is active. The filter panel, download button, and configuration accordion SHALL be hidden while any scraping or download is in progress (including linked page scraping).

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

#### Scenario: Mode indicator in filter panel

- GIVEN server mode is active (VITE_SERVER_URL is configured at build time)
- WHEN the filter panel is displayed
- THEN a visual badge shows "Server mode" next to the download button
- AND when local mode is active (no VITE_SERVER_URL), no server badge is shown

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
- THEN a "Stop" button is displayed

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
