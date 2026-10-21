# Concurrent Downloads Specification

## Purpose

Isolates download state per browser tab — abort controllers, keepalive ports, scrapers, and server sessions — with lifecycle cleanup on tab close and download-scoped mutable state, so simultaneous downloads in different tabs cannot interfere with each other.

## Requirements

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

### Requirement: Download-scoped shared mutable state

All mutable state used during asset processing SHALL be scoped to a single download (a per-download context created by `downloadResources`), not module-level globals. This includes the image filename map, dedup registries, and assembly-polling control. Existing per-tab state isolation requirements continue to apply.

#### Scenario: Concurrent tabs do not corrupt each other's filename maps

- **WHEN** Tab A and Tab B run linked-page downloads simultaneously
- **THEN** each download writes to and reads from its own filename map
- **AND** neither download's rewriting references the other's entries

#### Scenario: Assembly polling cancellation is scoped per download

- **WHEN** Tab A and Tab B are both polling assembly status and the user stops Tab A
- **THEN** only Tab A's polling loop is cancelled; Tab B's polling continues to completion

#### Scenario: No global state persists between downloads

- **WHEN** a download completes and a new one starts in the same tab
- **THEN** the new download's context starts empty (no stale filename entries or dedup keys)
