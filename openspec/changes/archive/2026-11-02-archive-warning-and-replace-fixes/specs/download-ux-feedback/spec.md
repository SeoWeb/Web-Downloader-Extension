## ADDED Requirements

### Requirement: Partial-archive retrieval on stopped downloads

When a tracked server download is stopped and the server has produced a download URL for its session, the side panel SHALL surface a server-archive affordance (download button for the partial archive) alongside the cancelled status. The stopped state SHALL present cancellation wording — never the success/complete presentation — and SHALL NOT render while the run is still live. When no URL was produced, the panel SHALL show the plain cancelled state as before.

#### Scenario: Stopped with a salvaged archive URL shows the download affordance

- **GIVEN** a server download was stopped and the salvage probe found the session `ready` with a download URL
- **WHEN** the panel processes `status.serverDownloadReady` followed by `status.cancelled`
- **THEN** the panel renders a stopped-with-partial-archive card carrying a download action for that URL
- **AND** the card uses cancellation wording, not the completion presentation

#### Scenario: Stopped without a URL shows plain cancellation

- **GIVEN** a download was stopped before the server produced any download URL
- **WHEN** the panel processes `status.cancelled`
- **THEN** the panel shows the localized cancelled state
- **AND** no server-archive affordance is rendered

#### Scenario: The affordance never renders mid-run

- **GIVEN** a `status.serverDownloadReady` message arrived while the download is still uploading or assembling
- **WHEN** the panel renders the server-mode state
- **THEN** the stopped-with-partial-archive card is not shown, because the run has not reached a terminal cancelled phase

### Requirement: Archive integrity warning is surfaced

The extension SHALL consume the server's archive integrity fields (`resources_missing`, `resources_failed`, `archive_warning`) from the session status response and display the warning message on the terminal download state when `archive_warning` is set: on the completed-with-warning card and on the stopped-with-partial-archive card. A complete session with no warning renders unchanged. Absent fields (older servers) SHALL be treated as no warning.

#### Scenario: Completed download with missing resources shows the warning

- **GIVEN** a session finalized with 3 resources missing from the archive
- **WHEN** the download completes and `/status` reports `archive_warning`
- **THEN** the completion card displays the warning alongside the download action

#### Scenario: Clean completion renders unchanged

- **GIVEN** a session assembled with every discovered resource present
- **WHEN** the download completes with `archive_warning` null
- **THEN** the completion card renders without any warning affordance

#### Scenario: Stopped partial archive shows its warning

- **GIVEN** a stopped download whose salvaged session status carries `archive_warning`
- **WHEN** the stopped-with-partial-archive card renders
- **THEN** the warning is displayed alongside the download action
