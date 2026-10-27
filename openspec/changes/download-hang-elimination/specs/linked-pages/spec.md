## MODIFIED Requirements

### Requirement: Scraper Pause, Resume, and Stop

The system SHALL support pausing, resuming, and stopping the scraping process. A paused scraper SHALL be live: the pause wait SHALL always be resolvable without depending on the side panel that issued the pause. Losing the UI while paused (side panel closed, keepalive port disconnected) SHALL NOT leave the pause wait pending forever — the wait SHALL resolve within a bounded watchdog period, the scraping loop SHALL exit or continue, and the download SHALL reach finalization with the keepalive port released. While the worker lives, the paused state SHALL remain controllable: a reopened panel can resume or stop the scraper.

#### Scenario: Pausing the scraper

- **GIVEN** the scraper is actively processing pages
- **WHEN** the pause command is issued
- **THEN** the scraper stops processing new pages after the current page completes
- **AND** a pause status message is sent

#### Scenario: Resuming the scraper

- **GIVEN** the scraper is paused
- **WHEN** the resume command is issued
- **THEN** the scraper continues processing the remaining pages in the queue

#### Scenario: Stopping the scraper

- **GIVEN** the scraper is actively processing pages
- **WHEN** the stop command is issued
- **THEN** the scraper stops processing immediately
- **AND** a stop status message is sent
- **AND** if the scraper was paused, it is resumed first so the loop can exit

#### Scenario: Paused scraper survives side panel closure

- **GIVEN** the scraper is paused awaiting resume and the side panel that issued the pause is closed
- **WHEN** the keepalive port disconnects (no UI remains that could send resume or stop)
- **THEN** the pause wait resolves within the bounded watchdog period
- **AND** the scraping loop exits so the download reaches finalization
- **AND** the START_DOWNLOAD message channel is answered and the keepalive port does not hold the service worker alive indefinitely

#### Scenario: Watchdog bounds a stuck pause even without a disconnect event

- **GIVEN** the scraper is paused and no resume, stop, or disconnect event arrives
- **WHEN** the watchdog period elapses
- **THEN** the scraper stops so the download finalizes instead of hanging forever

#### Scenario: Reopened panel can control a paused scraper

- **GIVEN** the scraper was paused while its side panel was closed
- **WHEN** the user reopens the panel while the worker still lives
- **THEN** resume and stop commands still reach the scraper and take effect

## ADDED Requirements

### Requirement: Navigation completion matching

The linked-page navigation wait SHALL resolve only on a tab-completion event that belongs to the navigation it requested. A completion event belonging to the tab's previous page (a stale completion during the transition) SHALL NOT resolve the wait and SHALL NOT determine which DOM is captured. If no qualifying completion arrives within the configured page timeout, the existing timeout rejection path applies unchanged.

#### Scenario: Stale completion from the previous page is ignored

- **GIVEN** the scraper navigated a tab from page A to page B and is waiting for B to complete
- **WHEN** page A delivers a late `status === "complete"` event for the same tab before B finishes loading
- **THEN** the wait does not resolve on that event
- **AND** no DOM is captured from page A for this job

#### Scenario: Requested page's completion resolves the wait

- **WHEN** the requested URL's page reaches `complete`
- **THEN** the wait resolves with the tab's final URL and the DOM capture proceeds for the requested page

#### Scenario: Navigation timeout still applies

- **GIVEN** no qualifying completion event arrives for the requested navigation
- **WHEN** the configured page timeout elapses
- **THEN** the wait rejects with a navigation timeout error and the job is marked failed

### Requirement: DOM capture timer hygiene

DOM capture operations that race `executeScript` against a timeout SHALL clear the timeout timer when the race settles, regardless of which side wins, so no stray timers outlive the capture. A timed-out capture SHALL reject with the capture-timeout error exactly once and SHALL NOT leave a timer that re-fires after settlement.

#### Scenario: Winning capture clears the timeout

- **WHEN** `executeScript` completes before the capture timeout
- **THEN** the timeout timer is cleared and no pending timer remains for the finished capture

#### Scenario: Timed-out capture does not leak timers

- **WHEN** `executeScript` exceeds the capture timeout
- **THEN** the race rejects with the capture-timeout error exactly once
- **AND** the timeout side is cleared and does not re-fire after settlement
