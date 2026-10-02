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
