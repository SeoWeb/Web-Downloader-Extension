## MODIFIED Requirements

### Requirement: Sequential Page Scraping

The system SHALL process queued pages sequentially in the same browser tab.

#### Scenario: Successful page scrape

- GIVEN a queued page URL
- WHEN the page is processed
- THEN the tab navigates to the URL and waits for the page to load
- AND the page is scrolled to trigger lazy loading
- AND the rendered DOM is captured
- AND resources are extracted from the captured DOM
- AND new assets are downloaded according to the press-time download options snapshot (images only when downloadImages is enabled, CSS/JS only when downloadAssets is enabled, documents only when downloadDocuments is enabled), skipping already-registered assets — a text/markdown-only run therefore fetches no assets at all
- AND the HTML is converted with relative paths using the `../` prefix
- AND the page is saved to the `pages/` folder

#### Scenario: Page navigation timeout

- GIVEN a queued page URL that takes longer than the configured timeout
- WHEN the tab navigates to the URL
- THEN a navigation timeout error is raised
- AND the page is marked as failed

#### Scenario: DOM capture failure

- GIVEN a page that cannot be captured via script execution
- WHEN the DOM capture is attempted
- THEN a capture failure error is raised
- AND the page is marked as failed

### Requirement: Scraper Pause, Resume, and Stop

The system SHALL support pausing, resuming, and stopping the scraping process. Pause SHALL be a true indefinite pause: a paused scraper SHALL wait for a Resume or Stop command and SHALL NOT self-stop — there is no bounded watchdog period that resolves the pause on its own, and a keepalive-port disconnect while paused SHALL NOT stop the scraper or finalize the download. Pausing SHALL release the scraping tab immediately by restoring the original page; Resume SHALL re-acquire a tab (recreating one if the original is gone) before scraping continues. While the service worker lives, the paused state SHALL remain controllable by a reopened panel. If the service worker dies while paused, the download SHALL enter a parked state: a checkpoint with phase `paused` plus a persisted scrape-queue snapshot SHALL remain in `chrome.storage.session`, and the reopened panel SHALL offer Resume (re-spawning the scraper from the snapshot against the same unfinalized server session) or Stop (finalizing the partial download). A held or parked pause SHALL never be surfaced as an interrupted download.

#### Scenario: Pausing the scraper

- GIVEN the scraper is actively processing pages
- WHEN the pause command is issued
- THEN the scraper stops processing new pages after the current page completes
- AND a pause status message is sent

#### Scenario: Resuming the scraper

- GIVEN the scraper is paused
- WHEN the resume command is issued
- THEN the scraper continues processing the remaining pages in the queue

#### Scenario: Stopping the scraper

- GIVEN the scraper is actively processing pages or paused
- WHEN the stop command is issued
- THEN the scraper stops processing immediately
- AND a stop status message is sent
- AND if the scraper was paused, the pause wait is resolved so the loop can exit

#### Scenario: Paused scraper waits indefinitely for Resume or Stop

- GIVEN the scraper is paused and no resume or stop command arrives
- WHEN any amount of time elapses (no bounded watchdog period exists)
- THEN the pause wait stays pending and the scraper neither exits nor self-stops
- AND the download does not finalize and the server session is not finalized

#### Scenario: Pausing releases the scraping tab

- GIVEN the pause has taken effect after the current page completes
- WHEN the scraper enters the paused state
- THEN the original page is restored in the browser tab immediately
- AND the tab is not left sitting on a scraped subpage for the duration of the pause
- AND on resume, a tab is re-acquired (recreated if the original is gone) before scraping continues

#### Scenario: Keepalive disconnect while paused parks instead of stopping

- GIVEN the scraper is paused awaiting resume
- WHEN the side panel closes and the keepalive port disconnects
- THEN the pause persists: the scraping loop does not exit and the download does not finalize
- AND if the service worker is gone (dies while the pause is held), the download parks — checkpoint phase `paused` plus queue snapshot — instead of stopping

#### Scenario: Worker death while paused parks the download

- GIVEN the scraper is paused
- WHEN the service worker dies
- THEN a checkpoint with phase `paused` and the persisted scrape-queue snapshot remain in `chrome.storage.session`
- AND the download is parked, with no interrupted declaration and no automatic finalization

#### Scenario: Resume from the parked state continues without re-scraping visited pages

- GIVEN a parked download and the panel reopened
- WHEN the user clicks Resume
- THEN the scraper is re-spawned seeded from the snapshot against the same unfinalized server session
- AND pages already visited (per the snapshot's visited set) are not re-scraped
- AND the remaining queue continues from the snapshot state

#### Scenario: Stop from the parked state finalizes the partial download

- GIVEN a parked download and the panel reopened
- WHEN the user clicks Stop
- THEN the partial download is finalized and the artifact is delivered

#### Scenario: Pause snapshot beyond the URL cap records truncation

- GIVEN more than 5,000 URLs remain queued when the pause is issued
- WHEN the queue snapshot is written
- THEN the snapshot is capped at 5,000 queued URLs
- AND an explicit truncation marker is recorded ("snapshot truncated; stop finalizes partial")
- AND a Stop on the truncated park still finalizes the partial download

#### Scenario: Reopened panel can control a paused scraper

- GIVEN the scraper was paused while its side panel was closed
- WHEN the user reopens the panel while the worker still lives
- THEN resume and stop commands still reach the scraper and take effect

## ADDED Requirements

### Requirement: Pause queue snapshot persistence

The system SHALL persist a scrape-queue snapshot to `chrome.storage.session` alongside the paused checkpoint whenever a pause is issued. The snapshot SHALL contain the remaining internal and external page queues, the visited/processed URL set, the current scraping phase (internal/external), and the scraping counters. The snapshot SHALL be frozen at the pause moment: pages completing afterwards while the pause is held are not required to update it, and resume-from-park continues from the frozen snapshot (completed pages are idempotent on re-upload or skipped by identity). The snapshot SHALL cap queued URLs at 5,000 entries and SHALL record an explicit truncation marker beyond the cap.

#### Scenario: Snapshot written on pause

- **WHEN** the pause is issued during linked-page scraping
- **THEN** a queue snapshot is written to `chrome.storage.session` alongside the `paused` checkpoint
- **AND** the snapshot contains the remaining internal and external queues, the visited URL set, the current phase (internal/external), and the counters

#### Scenario: Snapshot enables resume continuation

- **GIVEN** a parked download with a persisted queue snapshot
- **WHEN** the scraper is re-spawned from the snapshot
- **THEN** the remaining queues, visited set, phase, and counters are restored
- **AND** scraping continues without re-scraping visited pages and without losing queue order

#### Scenario: Truncation marker set beyond cap

- **GIVEN** more than 5,000 URLs remain queued
- **WHEN** the snapshot is written on pause
- **THEN** only 5,000 queued URLs are persisted
- **AND** a truncation marker is recorded so a Stop finalizes the partial download
