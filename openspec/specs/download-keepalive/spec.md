# Download Keepalive Specification

## Purpose

Manages the Chrome extension service worker keepalive port during active downloads, preventing the service worker from being killed mid-download.

## Requirements

### Requirement: Keepalive port established at download start
The system SHALL create a `chrome.runtime.connect({ name: "download-keepalive" })` port in the background service worker immediately after the `setDownloadInProgress(true)` guard in `downloadResources()`, before any scraping or resource processing begins.

#### Scenario: Keepalive created when download starts
- **WHEN** `downloadResources()` is called and passes the `getDownloadInProgress()` guard
- **THEN** a keepalive port connection is established before `executeDownload()` is invoked

#### Scenario: Keepalive not duplicated if already active
- **WHEN** `downloadResources()` starts and a keepalive port already exists from a previous call in the same session
- **THEN** the existing port is reused and no second connection is created

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
