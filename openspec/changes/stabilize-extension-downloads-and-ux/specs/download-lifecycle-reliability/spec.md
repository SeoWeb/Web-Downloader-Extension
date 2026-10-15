## ADDED Requirements

### Requirement: Cleanup uses chrome.alarms
Periodic cleanup and any delayed background work SHALL use `chrome.alarms` instead of `setInterval`, so cleanup survives service-worker termination and does not depend on long-lived timers.

#### Scenario: Cleanup runs after SW restart
- **WHEN** the service worker restarts after being idle
- **THEN** the periodic cleanup alarm is re-registered and its handler runs on schedule

#### Scenario: Cleanup never cancels active work
- **WHEN** the cleanup alarm fires while a download is active
- **THEN** the active download's state, uploads, and assembly polling are untouched

### Requirement: Single listener registration
Background event listeners (tabs, alarms, runtime, storage) SHALL be registered exactly once per service-worker lifetime. No deferred registration (e.g., `setTimeout`) SHALL duplicate a module-level registration.

#### Scenario: Tab-close handler runs once per event
- **WHEN** a tab with an active download is closed
- **THEN** cleanup logic executes exactly once

### Requirement: All panel notifications are enveloped and failure-tolerant
Every background-to-panel message SHALL carry the `target: "side-panel"` envelope, and every `sendMessage` SHALL have its rejection handled so a closed panel is a no-op.

#### Scenario: Interrupted-download push reaches an open panel
- **WHEN** a download is detected as interrupted while the panel is open
- **THEN** the panel receives the push and displays the resume affordance without requiring a reopen

#### Scenario: Closed panel does not produce unhandled rejections
- **WHEN** progress updates are sent while the panel is closed
- **THEN** the send failures are caught and logged, and the download continues unaffected

### Requirement: HTML chunk uploads are retried
HTML chunk uploads SHALL use the same retry policy as control-plane calls (bounded retries with backoff on network/5xx). A chunk that ultimately fails SHALL be surfaced as an error and SHALL mark the session incomplete rather than being silently skipped.

#### Scenario: Transient network blip during scrolling
- **WHEN** one HTML chunk upload fails with a network error and succeeds on retry
- **THEN** the archived page contains the chunk and no error is shown

#### Scenario: Persistently failing chunk is visible
- **WHEN** an HTML chunk exhausts its retries
- **THEN** the user sees an error state and the completion report reflects the missing content

### Requirement: Memory-pressure telemetry does not use external network
The throttling manager SHALL NOT make periodic requests to external hosts (e.g., google.com) to estimate congestion; congestion signals SHALL derive from the download's own request outcomes.

#### Scenario: No background pings to third parties
- **WHEN** a download runs for several minutes
- **THEN** no requests to unrelated third-party hosts originate from the throttling manager
