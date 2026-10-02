## MODIFIED Requirements

### Requirement: Sidepanel shows interrupted state
The sidepanel SHALL handle the `DOWNLOAD_INTERRUPTED` message by transitioning to an "interrupted" UI state that shows: (1) which phase was interrupted, (2) a "Resume download" button (when a server session exists) or "Restart download" button (when no server session), and (3) a brief explanation that the download was interrupted.

#### Scenario: User sees interrupted message after returning
- **WHEN** the sidepanel receives a `DOWNLOAD_INTERRUPTED` message
- **THEN** the UI transitions to show an "interrupted" state with the interrupted phase name, a resume/restart button, and an explanation message

#### Scenario: User resumes download from interrupted state with server session
- **WHEN** the user clicks "Resume download" in the interrupted state and the checkpoint contains a `serverSessionId`
- **THEN** a `RESUME_SERVER_DOWNLOAD` message is sent to the background
- **AND** the background queries the server session status and reconnects if the session is recoverable
- **AND** the UI shows "Reconnecting..." and "Resuming uploads..." progress messages

#### Scenario: User restarts download from interrupted state without server session
- **WHEN** the user clicks "Restart download" in the interrupted state and there is no `serverSessionId` in the checkpoint
- **THEN** a new download is initiated for the same tab URL with the same download options
- **AND** a new server session is created

#### Scenario: Resume falls back to full restart
- **WHEN** the user clicks "Resume download" but the server session is FAILED, expired, or not found
- **THEN** the system falls back to a full restart with a new download and new server session

#### Scenario: User dismisses interrupted state
- **WHEN** the user dismisses or closes the interrupted state without resuming
- **THEN** the UI resets to the initial "Connected" state

### Requirement: Sidepanel checks for interrupted downloads on open
The sidepanel SHALL query the background service worker for any interrupted download state when the panel opens or reconnects, so the interrupt state is shown even if the panel was closed during the interruption.

#### Scenario: Panel opened after service worker restart
- **WHEN** the sidepanel is opened and the background has an uncleared interrupt checkpoint
- **THEN** the sidepanel shows the interrupted state immediately

## ADDED Requirements

### Requirement: Guaranteed scrape-complete on error
The system SHALL track whether `scrapeComplete()` has been sent during `executeDownloadServerMode()`. If an error occurs before `scrapeComplete()` was sent, the system SHALL attempt a best-effort `scrapeComplete()` call in the catch block before re-throwing the error.

#### Scenario: scrapeComplete sent before error
- **WHEN** `executeDownloadServerMode()` errors after `scrapeComplete()` was already sent
- **THEN** the catch block does not attempt to send it again
- **AND** the error propagates normally

#### Scenario: scrapeComplete not sent before error
- **WHEN** `executeDownloadServerMode()` errors before `scrapeComplete()` was sent
- **THEN** the catch block attempts to call `scrapeComplete()` with the current resource count
- **AND** if the best-effort call also fails, the error is swallowed and the original error propagates
