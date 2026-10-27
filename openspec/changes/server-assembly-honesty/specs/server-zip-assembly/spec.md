## ADDED Requirements

### Requirement: Honest partial-assembly reporting

The server SHALL keep partial archives valid — a missing, unreadable, or failed resource SHALL NOT fail assembly — and SHALL make partiality honest: it SHALL persist per-session resource-integrity counts (`resources_missing`: discovered resources absent from the delivered artifact, including assembly-time skips and post-snapshot late arrivals; `resources_failed`: capture-time fetch failures plus assembly-time write failures) in the session record at finalize and during assembly. The `/status` response SHALL include `resources_missing` and `resources_failed` (nullable until finalize) and an `archive_warning` message set whenever either count is non-zero; the finalize response payload SHALL include the finalize-known counts. A complete session SHALL report zero counts with no warning, and marking a session `ready` SHALL NOT clear recorded counts.

#### Scenario: Missing resource file is counted, not fatal

- **GIVEN** a finalized session with a resource whose file is missing from disk
- **WHEN** assembly completes
- **THEN** the archive is still produced and the session becomes `ready`
- **AND** the session's persisted `resources_missing` count is incremented
- **AND** `/status` reports `resources_missing` greater than 0 with `archive_warning` set

#### Scenario: Resource write failure is counted

- **GIVEN** a resource whose bytes cannot be added to the archive (write error)
- **WHEN** assembly completes
- **THEN** assembly does not fail because of the resource
- **AND** `resources_failed` is incremented and `archive_warning` mentions the resource

#### Scenario: Finalize payload surfaces the discovery deficit

- **GIVEN** a session whose client discovered more resources than were uploaded
- **WHEN** finalize accepts the session (202)
- **THEN** the finalize response includes `resources_discovered`, `resources_received`, and `resources_missing` reflecting the deficit
- **AND** the 202 outcome is unchanged (the deficit never blocks finalize)

#### Scenario: Complete session reports zero

- **WHEN** a session assembles with every discovered resource present in the archive
- **THEN** `/status` reports `resources_missing` = 0, `resources_failed` = 0, and `archive_warning` = null

### Requirement: Deterministic archive membership for uploads racing finalize

The server SHALL make archive membership deterministic relative to upload commits: session-mutating uploads SHALL commit before their success response is sent, so a resource the client counted as uploaded is always durably stored. Uploads that passed the request-time status pre-check SHALL NOT be rejected with 409 because a concurrent finalize transitioned the session; the assembler's start-of-pipeline resource snapshot SHALL define archive membership, and resources committing after the snapshot SHALL be recorded as late arrivals in the session's integrity counts. No uploaded resource may end up as an orphan blob without a database row, and no committed resource may disappear from accounting.

#### Scenario: Upload passing the pre-check survives a concurrent finalize

- **GIVEN** a resource upload whose status pre-check observed `uploading`
- **WHEN** finalize transitions the session to `assembling` before the upload commits
- **THEN** the upload still returns success and the resource row and file are stored
- **AND** the upload is not rejected with 409

#### Scenario: Late arrival is accounted, not silent

- **GIVEN** a resource that commits after the assembler's resource snapshot
- **WHEN** assembly completes
- **THEN** the archive does not silently claim completeness
- **AND** the late arrival is reflected in `resources_missing`/`archive_warning` while the resource row and file remain stored

#### Scenario: Commit failure cannot masquerade as success

- **GIVEN** an upload whose database commit fails (pool exhaustion, deadlock, server restart)
- **WHEN** the upload request completes
- **THEN** the client receives an error response, not a success
- **AND** no partial file is left in storage

### Requirement: Parallel conversion failure isolation

The server SHALL run parallel CSS and linked-page conversion fan-outs with exception collection (`return_exceptions=True`): every sibling exception SHALL be retrieved and logged with the identity of the resource or page that failed, the first failure SHALL be marshaled into the normal assembly failure path (which marks the session failed using a fresh database session), and no sibling coroutine SHALL mutate the shared assembly session after failure handling begins.

#### Scenario: Sibling failure does not corrupt the shared session

- **GIVEN** a CSS (or linked-page) conversion sibling raises during the parallel phase
- **WHEN** the fan-out completes
- **THEN** all siblings have finished before failure handling starts
- **AND** the shared assembly session is not flushed by any sibling afterwards
- **AND** the session is marked failed via a fresh database session

#### Scenario: Sibling exceptions are never abandoned

- **WHEN** one or more siblings raise during a conversion fan-out
- **THEN** each exception is retrieved and logged with its resource/page identity
- **AND** no "Task exception was never retrieved" warning is emitted
