# Download Recovery Specification

## Purpose

Handles detection and recovery of downloads that were interrupted by service worker kills, enabling the user to restart interrupted downloads.

## Requirements

### Requirement: Interrupted download detected on service worker startup
The system SHALL check for an interrupt checkpoint in `chrome.storage.session` during `performStartupCleanup()`. If a checkpoint exists, the system SHALL send a `DOWNLOAD_INTERRUPTED` message to the sidepanel with the checkpoint data (phase, tabUrl, serverSessionId, timestamp).

#### Scenario: Service worker restarts with active checkpoint
- **WHEN** the service worker starts up and finds a checkpoint with `downloadInterrupted: true` in `chrome.storage.session`
- **THEN** a `DOWNLOAD_INTERRUPTED` message is sent to the sidepanel with `{ phase, tabUrl, serverSessionId, timestamp }`
- **AND** the checkpoint is cleared from `chrome.storage.session`
- **AND** `isDownloadInProgress` is reset to `false`

#### Scenario: Service worker starts with no checkpoint
- **WHEN** the service worker starts up and no checkpoint exists in `chrome.storage.session`
- **THEN** normal startup cleanup proceeds (existing behavior)

### Requirement: Sidepanel shows interrupted state
The sidepanel SHALL handle the `DOWNLOAD_INTERRUPTED` message by transitioning to an "interrupted" UI state that shows: (1) which phase was interrupted, (2) a "Restart download" button, and (3) a brief explanation that the download was interrupted.

#### Scenario: User sees interrupted message after returning
- **WHEN** the sidepanel receives a `DOWNLOAD_INTERRUPTED` message
- **THEN** the UI transitions to show an "interrupted" state with the interrupted phase name, a restart button, and an explanation message

#### Scenario: User restarts download from interrupted state
- **WHEN** the user clicks "Restart download" in the interrupted state
- **THEN** a new download is initiated for the same tab URL with the same download options
- **AND** a new server session is created (if server mode) rather than reusing the stale one

#### Scenario: User dismisses interrupted state
- **WHEN** the user dismisses or closes the interrupted state without restarting
- **THEN** the UI resets to the initial "Connected" state

### Requirement: Sidepanel checks for interrupted downloads on open
The sidepanel SHALL query the background service worker for any interrupted download state when the panel opens or reconnects, so the interrupt state is shown even if the panel was closed during the interruption.

#### Scenario: Panel opened after service worker restart
- **WHEN** the sidepanel is opened and the background has an uncleared interrupt checkpoint
- **THEN** the sidepanel shows the interrupted state immediately
