## ADDED Requirements

### Requirement: Per-tab download state isolation
The system SHALL maintain separate download state for each browser tab, including abort controller, keepalive port, scraper instance, and server session tracking. Each tab's state SHALL be independent and operable without affecting other tabs.

#### Scenario: Two tabs start server-mode downloads concurrently
- **WHEN** Tab A starts a server-mode download
- **AND** Tab B starts a server-mode download while Tab A is still active
- **THEN** both downloads proceed independently with separate abort controllers, keepalive ports, and server sessions
- **AND** Tab A's download state does not interfere with Tab B's download state

#### Scenario: Stopping one tab's download does not affect another
- **WHEN** Tab A and Tab B both have active server-mode downloads
- **AND** the user presses Stop on Tab A
- **THEN** Tab A's download is cancelled (abort controller triggered, keepalive port disconnected)
- **AND** Tab B's download continues unaffected

#### Scenario: Per-tab scraper isolation
- **WHEN** Tab A is scraping linked pages
- **AND** Tab B starts scraping linked pages
- **THEN** each tab has its own `LinkedPageScraper` instance
- **AND** pausing Tab A's scraper does not affect Tab B's scraper

#### Scenario: Tab closed mid-download
- **WHEN** a tab is closed while it has an active download
- **THEN** all per-tab state for that tab is cleaned up (abort controller, keepalive port, scraper, session state)
- **AND** other tabs' downloads are unaffected

### Requirement: Tab lifecycle cleanup
The system SHALL clean up all per-tab download state when a tab is closed, preventing memory leaks from per-tab Maps.

#### Scenario: Tab removed by browser
- **WHEN** `chrome.tabs.onRemoved` fires for a tab ID
- **THEN** the tab's abort controller is cleared from the map
- **AND** the tab's keepalive port is disconnected and removed from the map
- **AND** the tab's scraper instance is removed from the map
- **AND** the tab's server session state is removed from the map
- **AND** the tab's force-local-mode flag is removed from the map
- **AND** the tab is removed from the active downloads set

#### Scenario: Multiple tabs closed simultaneously
- **WHEN** multiple tabs are closed at the same time
- **THEN** each tab's state is cleaned up independently
- **AND** no state leaks between cleanup operations
