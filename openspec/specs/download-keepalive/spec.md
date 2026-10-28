# Download Keepalive Specification

## Purpose

Manages the Chrome extension service worker keepalive port during active downloads, preventing the service worker from being killed mid-download.

## Requirements

### Requirement: Keepalive port established at download start

The system SHALL create a `chrome.runtime.connect({ name: "download-keepalive" })` port in the background service worker immediately after the `setDownloadInProgress(true)` guard in `downloadResources()`, before any scraping or resource processing begins. The port SHALL listen for `keepalive-ping` messages from the service worker and respond with `keepalive-pong` messages to create bidirectional I/O.

#### Scenario: Keepalive created when download starts

- **WHEN** `downloadResources()` is called and passes the `getDownloadInProgress()` guard
- **THEN** a keepalive port connection is established before `executeDownload()` is invoked
- **AND** the port has an `onMessage` listener that responds to `keepalive-ping` with `keepalive-pong`

#### Scenario: Keepalive not duplicated if already active

- **WHEN** `downloadResources()` starts and a keepalive port already exists from a previous call in the same session
- **THEN** the existing port is reused and no second connection is created

#### Scenario: Bidirectional ping/pong keeps worker alive

- **WHEN** the service worker sends a `keepalive-ping` message on the keepalive port
- **THEN** the port responds with a `keepalive-pong` message
- **AND** this bidirectional I/O ensures Chrome considers the service worker active

### Requirement: Keepalive port closed on download end

The system SHALL disconnect the keepalive port in the `finally` block of `downloadResources()`, ensuring it closes whether the download succeeds, fails, or is cancelled.

#### Scenario: Keepalive closed on successful download

- **WHEN** a download completes successfully
- **THEN** the keepalive port is disconnected in the finally block

#### Scenario: Keepalive closed on download failure

- **WHEN** a download throws an error and the catch/finally blocks execute
- **THEN** the keepalive port is disconnected

#### Scenario: Keepalive closed on user-initiated stop

- **WHEN** the user presses Stop and `abortActiveDownload()` is called
- **THEN** the keepalive port is disconnected and the download-in-progress flag is cleared

### Requirement: Keepalive port tracks download lifecycle

The keepalive port created at download start SHALL replace the existing `trackDownload()` port creation in `server-download.ts`. The `trackDownload()` function SHALL NOT create a new port if one already exists from download start.

#### Scenario: trackDownload does not duplicate port

- **WHEN** `trackDownload()` is called during server download trigger
- **THEN** it reuses the existing keepalive port instead of creating a second one

### Requirement: Service worker keepalive port listener

The service worker (`background.js`) SHALL register a `chrome.runtime.onConnect` listener for ports named `"download-keepalive"`. When a port connects, the listener SHALL start a 25-second interval that sends `{ type: "keepalive-ping" }` messages. The interval SHALL be cleared on `port.onDisconnect`.

#### Scenario: Keepalive port connected during download

- **WHEN** the service worker receives a port connection with name `"download-keepalive"`
- **THEN** a 25-second interval is started that sends `keepalive-ping` messages on the port

#### Scenario: Keepalive interval cleared on disconnect

- **WHEN** the keepalive port disconnects (download ends or worker shutdown)
- **THEN** the ping interval is cleared

#### Scenario: Multiple downloads with separate ports

- **WHEN** multiple downloads are active simultaneously with separate keepalive ports
- **THEN** each port has its own independent ping interval

### Requirement: Dead-worker detection contract

During the upload-wait phase of a server-mode download, the background service worker SHALL emit a progress heartbeat every 15 seconds (a `status.uploadProgress` message), on both the fresh-download path and the resume path, as the liveness signal the panel's watchdog consumes. The heartbeat interval SHALL be cleared when the wait ends (success, failure, or cancellation). The panel SHALL treat 45 seconds without any message belonging to the tracked download (three missed 15-second heartbeats) as a dead service worker and SHALL transition to the interrupted-download state within that bounded time.

#### Scenario: Heartbeat emitted during upload wait

- **WHEN** a fresh server-mode download is waiting for resource uploads to complete
- **THEN** a `status.uploadProgress` heartbeat is emitted every 15 seconds until the wait ends

#### Scenario: Heartbeat emitted during resume upload wait

- **WHEN** a resumed server-mode download is waiting for resource uploads to complete
- **THEN** a `status.uploadProgress` heartbeat is emitted every 15 seconds until the wait ends

#### Scenario: Heartbeat stops when the wait ends

- **WHEN** the upload wait finishes (completed, failed, or cancelled)
- **THEN** the heartbeat interval is cleared and no further heartbeats are sent

#### Scenario: Dead worker detected within a bounded time

- **GIVEN** a download is in the upload-wait phase and the service worker is killed
- **WHEN** the panel has received no message belonging to the tracked download for 45 seconds
- **THEN** the panel has transitioned to the interrupted-download state
- **AND** the detection latency never exceeds 45 seconds plus one heartbeat period

### Requirement: Warm-restart startup cleanup

The service worker SHALL run startup cleanup — including interrupted-download handling (clearing the in-progress flag, reading checkpoints, and notifying a connected panel via `DOWNLOAD_INTERRUPTED`) — on its first wake after being killed, regardless of which event started the worker. This SHALL be achieved with an idempotent, once-per-worker-lifetime guard on the worker's module-initialization path; the `activate` lifecycle listener SHALL be retained for install/update but SHALL NOT be the only trigger. A panel that is open at wake time SHALL be told about the interrupted download without being reopened, and panel-open discovery (`CHECK_INTERRUPTED_DOWNLOAD`) SHALL continue to work for panels opened later.

#### Scenario: Warm wake runs startup cleanup

- **GIVEN** the service worker was killed while `isDownloadInProgress` was set
- **WHEN** the worker is woken by any event without an `activate` lifecycle event (warm restart)
- **THEN** startup cleanup runs: the in-progress flag is cleared and interrupted-download checkpoints are processed
- **AND** a connected panel receives `DOWNLOAD_INTERRUPTED` and shows the interrupted card without being reopened

#### Scenario: Cleanup runs once per worker lifetime

- **GIVEN** a service worker instance has already run startup cleanup
- **WHEN** additional lifecycle or wake events occur in the same worker lifetime
- **THEN** startup cleanup does not run again in that instance

#### Scenario: Install and update path preserved

- **WHEN** the extension is installed or updated and the worker activates
- **THEN** startup cleanup runs via the `activate` listener as before

#### Scenario: Cleanup is a no-op when nothing was interrupted

- **GIVEN** no download was in progress when the worker was killed
- **WHEN** the worker wakes and startup cleanup runs
- **THEN** no panel notification is sent and no checkpoint is cleared

#### Scenario: Browser-level restart still surfaces interrupted downloads

- **GIVEN** a download was interrupted and the browser is closed and reopened
- **WHEN** the panel opens
- **THEN** the existing `CHECK_INTERRUPTED_DOWNLOAD` discovery offers Resume/Restart as before
