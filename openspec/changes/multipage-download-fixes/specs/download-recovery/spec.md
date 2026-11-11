## MODIFIED Requirements

### Requirement: Interrupted download detected on service worker startup

The system SHALL check for an interrupt checkpoint in `chrome.storage.session` during `performStartupCleanup()`. A `DOWNLOAD_INTERRUPTED` declaration SHALL require liveness evidence: before declaring, the system SHALL probe the download's liveness (ping the worker, e.g. via `CHECK_DOWNLOAD_LIVE`) and consult the persisted liveness record's freshness. A stale checkpoint alone SHALL NOT be declared an interruption while the download is proven live. A checkpoint whose phase is `paused` SHALL NOT be declared an interruption — it SHALL route to the paused card instead. Only a genuinely dead download (liveness probe fails and no fresh liveness heartbeat exists) SHALL produce a `DOWNLOAD_INTERRUPTED` message to the sidepanel with the checkpoint data (phase, tabUrl, serverSessionId, timestamp).

#### Scenario: Service worker restarts with active checkpoint

- **WHEN** the service worker starts up and finds a checkpoint with `downloadInterrupted: true` in `chrome.storage.session`
- **AND** the liveness probe fails (the download is genuinely dead, no fresh liveness heartbeat)
- **THEN** a `DOWNLOAD_INTERRUPTED` message is sent to the sidepanel with `{ phase, tabUrl, serverSessionId, timestamp }`
- **AND** the checkpoint is cleared from `chrome.storage.session`
- **AND** `isDownloadInProgress` is reset to `false`

#### Scenario: Service worker starts with no checkpoint

- **WHEN** the service worker starts up and no checkpoint exists in `chrome.storage.session`
- **THEN** normal startup cleanup proceeds (existing behavior)

#### Scenario: Paused checkpoint is routed to the paused card, not interrupted

- **WHEN** the service worker starts up and finds a checkpoint whose phase is `paused`
- **THEN** no `DOWNLOAD_INTERRUPTED` message is declared for it
- **AND** the checkpoint routes to the paused card (Resume/Stop) instead

#### Scenario: Liveness probe prevents false declaration during long silent server assembly

- **WHEN** the startup check finds a stale checkpoint for a download that is still live (liveness probe succeeds or the persisted heartbeat is fresh, e.g. during a long silent server merge)
- **THEN** no `DOWNLOAD_INTERRUPTED` message is declared
- **AND** the live download continues unaffected

#### Scenario: Genuinely dead download is still declared interrupted

- **WHEN** the startup check finds a checkpoint whose download is genuinely dead (liveness probe fails and no fresh heartbeat exists)
- **THEN** `DOWNLOAD_INTERRUPTED` is declared with the checkpoint data
- **AND** the download does not die silently

## ADDED Requirements

### Requirement: Completion declarations require liveness or terminal evidence

The sidepanel status poll SHALL NOT declare download completion from lost in-memory liveness alone: a service-worker restart wipes the in-memory liveness set, so the absence of a liveness signal SHALL be treated as unknown, not dead. Completion SHALL be declared only when the server session reports a terminal status (`ready`, `failed`, or `cancelled`), or when a recent persisted liveness heartbeat exists and the download flow has pushed a terminal completion message. Absence of both SHALL keep the poll waiting rather than declaring a completed headline.

#### Scenario: Service worker restart mid-run does not produce a completed headline while subpages are pending

- **WHEN** the service worker restarts mid-run, wiping the in-memory liveness set, and the poll observes no liveness signal while subpages are still pending and the server session is not terminal
- **THEN** completion is not declared and the poll keeps waiting

#### Scenario: Terminal server status declares completion normally

- **WHEN** the poll reads a terminal server session status (`ready`, `failed`, or `cancelled`)
- **THEN** the corresponding terminal state is declared normally, even without a liveness heartbeat

#### Scenario: Fresh heartbeat plus terminal message declares normally

- **WHEN** a recent persisted liveness heartbeat exists and the download flow has pushed a terminal completion message
- **THEN** completion is declared normally without delay

### Requirement: Paused checkpoint surfaces a paused card

A checkpoint with phase `paused` SHALL surface a Paused card in the sidepanel offering Resume and Stop actions — the interrupted wording SHALL never be used for phase `paused`. Resume SHALL re-spawn the scrape from the persisted snapshot against the same unfinalized server session; Stop SHALL finalize the partial download. When the server session has expired or is unrecoverable, Resume SHALL fall back to the full-restart offer per the existing session-expiry semantics.

#### Scenario: Resume from the paused card continues the scrape

- **WHEN** the user clicks Resume on the paused card and the server session is recoverable
- **THEN** the scraper is re-spawned from the persisted snapshot on the same unfinalized server session
- **AND** the scrape continues from the snapshot state

#### Scenario: Stop from the paused card finalizes the partial

- **WHEN** the user clicks Stop on the paused card
- **THEN** the partial download is finalized and its artifact is delivered

#### Scenario: Expired server session on resume falls back to restart offer

- **WHEN** the user clicks Resume on the paused card but the server session is expired, `FAILED`, or not found
- **THEN** the system falls back to a full restart with a new download and new server session, consistent with the existing "Resume falls back to full restart" semantics
