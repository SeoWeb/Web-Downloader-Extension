# Download Lifecycle Reliability Specification

## Purpose

Covers background lifecycle correctness for the extension: cleanup that survives service-worker termination via `chrome.alarms`, single event-listener registration, enveloped and failure-tolerant panel notifications, retried HTML chunk uploads, and memory-pressure telemetry that never contacts external hosts.

## Requirements

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

### Requirement: User stop is honored in every download phase

A user-issued stop (`SCRAPER_STOP` / `abortActiveDownload`) SHALL interrupt the active download's client-side work in EVERY phase — main-path scraping, resume resource re-fetching, upload draining, and assembly-status polling — on both the main and resume paths. The stop signal SHALL abort the upload queue and the download's assembly-polling signal, the resume re-fetch loop SHALL observe the stop signal (no further fetches after abort, and the abort SHALL NOT be swallowed as a per-resource failure), and assembly polling SHALL wake from its polling sleep immediately on abort. No phase SHALL deliver its archive and continue as if the stop had not happened.

#### Scenario: Stop during main-path scraping

- **GIVEN** a server-mode download is actively scraping and uploading resources
- **WHEN** the user presses Stop
- **THEN** in-flight fetches/uploads abort promptly and the flow exits without sending `status.complete`
- **AND** the terminal panel status indicates cancellation rather than a generic failure

#### Scenario: Stop during resume re-fetch loop

- **GIVEN** a resumed download is re-fetching checkpointed resource URLs one by one
- **WHEN** the user presses Stop while a fetch is in flight or more URLs remain
- **THEN** the in-flight fetch aborts immediately, no further URLs are fetched, and the loop exits within the current request rather than continuing for up to 60 seconds per remaining resource
- **AND** enqueue attempts after the stop do not keep the loop alive

#### Scenario: Stop during upload draining

- **GIVEN** resource uploads are still draining after scrape-complete
- **WHEN** the user presses Stop
- **THEN** the upload queue cancels immediately and remaining queued work is dropped
- **AND** the flow does not wait for the cancelled queue before continuing to the salvage step

#### Scenario: Stop during assembly polling interrupts promptly

- **GIVEN** a download (main or resume) is polling session status while the server assembles
- **WHEN** the user presses Stop
- **THEN** the polling sleep wakes immediately on the abort signal and the poll loop terminates
- **AND** at most one salvage status request follows instead of continued polling until a poll succeeds or the 35-minute cap

### Requirement: Stop never reports success with partial data

After a user-issued stop, the terminal panel status SHALL indicate cancellation (the `status.cancelled` status) and SHALL NEVER be `status.complete` — even when the flow finalizes the server session with the data that arrived before the stop. When the server has already produced a download URL for the stopped session, the extension SHALL surface that partial-archive URL (the `status.serverDownloadReady` affordance) alongside the cancellation; when it has not, the session is left to server-side retention. A stop during scraping SHALL be reported as a cancellation, not as a `failedWithError` failure.

#### Scenario: Stop during main-path upload finalizes partial but reports cancelled

- **GIVEN** a main-path download is stopped while uploads are draining
- **WHEN** the flow finalizes the session with the resources that arrived
- **THEN** the terminal message is `status.cancelled` with the session id and failed-upload count
- **AND** `status.complete` is not sent for the partially finalized archive

#### Scenario: Partial archive is surfaced when the server already produced it

- **GIVEN** a download was stopped and the salvage status probe finds the session `ready` with a download URL
- **WHEN** the cancellation status is reported
- **THEN** the partial-archive download URL accompanies it so the user can retrieve what was captured
- **AND** the status still reads cancelled, not complete

#### Scenario: Stop with nothing to salvage

- **GIVEN** a download is stopped during scraping before anything was finalized
- **WHEN** the flow tears down
- **THEN** the panel shows the cancellation status
- **AND** no Resume prompt is offered afterwards, because a deliberately stopped download is not an interrupted one

### Requirement: Resume upload waiting is failure-tolerant

During a resumed download, the wait for the re-upload queue (`waitForAll`) SHALL NOT fail the whole resume: a queue timeout OR a queue cancellation SHALL be caught and the flow SHALL proceed to finalize the session with whatever arrived, mirroring the main path's catch-and-continue. A non-stop timeout SHALL finalize the partial archive and report completion with the terminal failed-upload count; a user-stop cancellation SHALL finalize and report the cancelled status per the stop contract.

#### Scenario: Resume queue timeout finalizes partial instead of failing

- **GIVEN** a resumed download's re-upload queue cannot drain within its computed timeout
- **WHEN** `waitForAll` rejects with the timeout
- **THEN** the resume proceeds to finalize the session with the resources that arrived
- **AND** the completion report includes the failed-upload count instead of surfacing a resume-failure error

#### Scenario: Queue cancellation during resume wait maps to the stop contract

- **GIVEN** the user pressed Stop while the resumed download was draining its re-upload queue
- **WHEN** the wait rejects due to the queue cancellation
- **THEN** the resume finalizes what arrived and reports the cancelled status
- **AND** the rejection does not propagate as a failed resume
