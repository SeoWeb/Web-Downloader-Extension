## ADDED Requirements

### Requirement: Terminal upload failures are logged

Every terminal failure class of the server-mode upload queue SHALL emit exactly one structured console warn/error at the moment the failure becomes terminal: `AuthenticationError` (after ServerClient's own re-registration attempts), per-task user-cancellation aborts, the 413 session-full fail-all drain (logged once for the session, not once per fast-failed task), and retries-exhausted (including timeout exhaustion). Retries that have not yet reached terminality SHALL NOT spam the log. Silence is a defect: a download whose uploads failed must leave evidence in the service-worker console.

#### Scenario: Hung upload times out and logs its terminal failure

- **WHEN** an upload exhausts its retry budget on repeated `TimeoutError` aborts
- **THEN** exactly one structured warn/error is logged naming the task path and the failure class
- **AND** intermediate retry attempts added no per-attempt log lines

#### Scenario: Session-full drain logs once

- **WHEN** a 413 session-full response triggers the fail-all drain of all pending tasks
- **THEN** exactly one structured warning is logged for the session (carrying the drained task count)
- **AND** each fast-failed pending task adds no additional log line

#### Scenario: Cancellation leaves evidence

- **WHEN** the user cancels a download with uploads in flight and pending
- **THEN** `UploadQueue.cancel()` logs one structured summary carrying the cancelled active and pending counts

#### Scenario: Authentication failure is attributed

- **WHEN** an upload fails terminally with `AuthenticationError`
- **THEN** exactly one structured error is logged identifying the authentication failure class (distinguishable from network or size failures)

### Requirement: Completed downloads report failed uploads

The `status.complete` payload SHALL carry the upload queue's `failedCount`, and the side panel's completion state SHALL consume it so a finished download with N failed uploads is visibly partial (never indistinguishable from a clean success). A clean download (failedCount 0) renders unchanged.

#### Scenario: Partial completion is visible

- **WHEN** a server-mode download finishes with 3 of 106 uploads permanently failed
- **THEN** the `status.complete` payload carries `failedCount: 3`
- **AND** the panel's completion state renders the download as completed-with-failures, showing the failed count

#### Scenario: Clean completion is unchanged

- **WHEN** a server-mode download finishes with all uploads succeeded
- **THEN** the `status.complete` payload carries `failedCount: 0`
- **AND** the panel renders the ordinary success state with no failure affordances

#### Scenario: Resume completion also reports failures

- **WHEN** a resumed download finishes and some re-fetched resources could not be uploaded
- **THEN** its `status.complete` payload carries the non-zero failedCount exactly as a first-attempt download would
