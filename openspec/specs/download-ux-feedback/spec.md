# Download UX Feedback Specification

## Purpose

Defines how the side panel communicates download outcomes: local fallback on server failure, a persistent per-category failure summary on completion, persistent announcement dismissal, explicit cancellation states, accessibility conformance, and distinct failure explanations instead of silent retry loops.

## Requirements

### Requirement: Local fallback on server failure

When server assembly or finalization fails, the completion/error state SHALL offer a translated "Download locally instead" action (in addition to Retry) when a fallback deliverable is obtainable. The action SHALL use the existing localized strings for label and warning.

#### Scenario: Server down offers local fallback

- **WHEN** assembly polling fails and a fallback path exists
- **THEN** the panel shows both Retry and "Download locally instead" with the localized warning text

#### Scenario: No fallback available shows retry only

- **WHEN** no fallback deliverable exists for the failed session
- **THEN** only Retry is offered

### Requirement: Persistent failure summary on completion

The completion screen SHALL display a persistent per-category report (succeeded / failed / skipped counts for images, styles, scripts, documents) aggregated from the download's status messages, so partial success is visible after the fact.

#### Scenario: Clean download shows a green report

- **WHEN** all assets succeed
- **THEN** the completion screen shows the report with zero failures

#### Scenario: Partial download is visible

- **WHEN** 200 images fail but the ZIP completes
- **THEN** the completion screen shows the failure counts prominently instead of only a success hero

### Requirement: Announcement dismissal persists

Dismissing the PagePocket announcement via "Maybe Later" or the close button SHALL persist the dismissal so the modal does not re-open on every panel open.

#### Scenario: Maybe-later sticks

- **WHEN** the user clicks "Maybe Later" and reopens the panel
- **THEN** the announcement modal is not shown again (until a new announcement version, if implemented)

### Requirement: Explicit cancellation states

Stopping a download SHALL present an explicit outcome: the partial-save path SHALL indicate "Saving what we captured…" and mark the completion report as partial; a full cancel SHALL show the localized cancelled state rather than resetting silently.

#### Scenario: Stop during scraping with partial save

- **WHEN** the user presses Stop mid-scrape and partial packaging proceeds
- **THEN** the panel communicates that a partial archive is being saved and the completion report marks it partial

#### Scenario: Full cancel resets with feedback

- **WHEN** the user cancels outright
- **THEN** the panel shows the cancelled state before returning to ready

### Requirement: Accessibility conformance fixes

Interactive UI SHALL have unique element IDs, expanded/collapsed disclosure controls SHALL expose `aria-expanded` and remove collapsed content from tab order, the language listbox SHALL support Arrow/Escape keys, and no user-facing English SHALL be hardcoded in shipped components.

#### Scenario: Duplicate IDs eliminated

- **WHEN** the download form renders
- **THEN** every form control has a unique `id` and associated label

#### Scenario: Collapsed section is not tabbable

- **WHEN** the advanced-config section is collapsed
- **THEN** its controls are not focusable and the toggle reports `aria-expanded="false"`

#### Scenario: Language picker is keyboard operable

- **WHEN** the language listbox is open and the user presses ArrowDown/Escape
- **THEN** focus moves between options / the listbox closes, without requiring a mouse

### Requirement: Server failure is never a silent retry loop

If every retry of session finalization fails, the panel SHALL surface a distinct failure explanation (with server-unavailable wording) rather than looping generic "Download failed" states.

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
