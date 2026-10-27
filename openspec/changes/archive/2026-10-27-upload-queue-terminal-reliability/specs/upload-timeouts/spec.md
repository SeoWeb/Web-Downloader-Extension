## ADDED Requirements

### Requirement: Terminal failure of active uploads starts pending uploads

The upload queue SHALL guarantee that whenever a task is removed from the active set — by successful completion or by any terminal failure (user abort, authentication failure, 413 session-full including subsequent concurrent 413s, exhausted 429 retries, or a non-retryable/exhausted generic error) — the queue SHALL notify progress listeners and, if tasks remain pending, schedule processing so pending uploads start. A terminal outcome for the currently active uploads SHALL never leave pending tasks unstarted.

#### Scenario: All active tasks exhaust 429 retries while pending tasks remain

- **GIVEN** the maximum concurrency is N and more than N tasks are enqueued
- **WHEN** all N active uploads exhaust their 429 retry budget and fail terminally
- **THEN** the pending tasks are started and complete
- **AND** `waitForAll()` resolves instead of timing out

#### Scenario: Authentication failure with pending tasks does not stall the queue

- **GIVEN** multiple tasks are enqueued and several are active
- **WHEN** an active upload fails with `AuthenticationError` and every other active task also reaches a terminal outcome
- **THEN** the remaining pending tasks are started rather than stranded
- **AND** the queue drains and `waitForAll()` resolves

#### Scenario: Successful completion continues draining pending tasks

- **WHEN** an active upload completes successfully while tasks remain pending
- **THEN** the next pending upload starts without waiting for any other active upload

### Requirement: Bounded Retry-After backoff

When a 429 response supplies a `Retry-After` value, the queue SHALL honor it only up to a maximum of 60 seconds. A `Retry-After` value greater than 60 seconds SHALL fail the task terminally (with the same accounting and logging as exhausted retries) instead of sleeping, so a single task cannot park a concurrency slot for minutes or hours. Backoff sleeps SHALL be implemented in short chunks that re-check queue cancellation, so a cancel during backoff is honored promptly and the task is not retried after cancellation.

#### Scenario: Retry-After within the cap is honored

- **WHEN** a 429 response carries `Retry-After: 5` and the task has retry budget left
- **THEN** the task waits approximately 5 seconds and is retried

#### Scenario: Oversized Retry-After fails the task terminally

- **WHEN** a 429 response carries `Retry-After: 3600`
- **THEN** the task fails terminally without sleeping for an hour
- **AND** the concurrency slot is freed immediately and reflected in progress counters

#### Scenario: Cancellation during backoff prevents the retry

- **GIVEN** a task is sleeping in a 429 or 5xx backoff before its next attempt
- **WHEN** `cancel()` is called on the queue
- **THEN** the sleeping task is not retried when the sleep elapses
- **AND** the task is counted exactly once as failed

### Requirement: Upload progress accounting integrity

The upload queue SHALL ensure each task is counted exactly once — in `completedCount` or `failedCount`, never both — regardless of whether the `onProgress` callback throws. The queue SHALL guard its progress-callback invocation so a throwing callback cannot cause a completed task to be retried, corrupt counters, or skip processing of pending tasks. Counter updates, active-set cleanup, and rescheduling SHALL NOT be skipped by callback failure.

#### Scenario: Throwing onProgress does not double-count a completed task

- **GIVEN** the `onProgress` callback throws (e.g. the extension context is invalidated while sending a progress message)
- **WHEN** an upload completes successfully and the queue invokes the callback
- **THEN** the task is counted once in `completedCount` and not at all in `failedCount`
- **AND** the task is not retried and its blob is released

#### Scenario: Queue continues after a throwing progress callback

- **WHEN** the `onProgress` callback throws during any task state change
- **THEN** remaining pending tasks still start and finish
- **AND** `waitForAll()` waiters still resolve when the queue drains

### Requirement: Checkpoint resource manifest excludes non-uploadable resources

The queue's resource URL manifest (`getResourceUrls()`) SHALL exclude resources that can no longer be uploaded by a resumed session: tasks that failed terminally due to `AuthenticationError`, exhausted 429 retries, or another permanent failure, and tasks drained by a 413 session-full detection (both the task that received the 413 and every pending task fast-failed by it). Resources of successful uploads and of tasks aborted by a user-initiated queue cancel SHALL remain in the manifest so checkpoints stay resumable.

#### Scenario: Permanently failed uploads are excluded from checkpoints

- **GIVEN** a task failed terminally with `AuthenticationError` or exhausted 429 retries
- **WHEN** the download checkpoint persists the queue's resource URLs
- **THEN** the failed task's URL is not included
- **AND** a resumed session does not re-fetch or re-upload it

#### Scenario: 413-drained resources are excluded so resume cannot re-trigger 413

- **GIVEN** a 413 session-full error drained all pending tasks
- **WHEN** the download checkpoint persists the queue's resource URLs
- **THEN** neither the 413-failed task's URL nor any drained pending task's URL is included
- **AND** a resumed session does not re-upload them and therefore does not re-trigger 413

#### Scenario: User-cancelled uploads remain resumable

- **GIVEN** the user pressed Stop and the queue was cancelled with tasks in flight or pending
- **WHEN** the checkpoint persists resource URLs for a later manual resume
- **THEN** the URLs of the cancelled tasks are still present in the manifest

### Requirement: Queue cancellation is silent when there is nothing to cancel

`UploadQueue.cancel()` SHALL emit its "Queue cancelled" warning only when it actually aborted at least one active or pending upload. Cancelling an already-drained queue (for example from a download-completion cleanup path) SHALL NOT log a cancellation warning.

#### Scenario: Successful download does not log a cancellation warning

- **GIVEN** all uploads completed successfully and the queue is empty
- **WHEN** the download flow's cleanup path calls `cancel()`
- **THEN** no "Queue cancelled: 0 active + 0 pending" warning is logged

#### Scenario: Cancelling with work in flight still warns

- **GIVEN** the queue has active or pending uploads
- **WHEN** `cancel()` is called
- **THEN** the single summary warning lists the aborted active and pending counts

## MODIFIED Requirements

### Requirement: Upload queue drain timeout

The system SHALL accept an optional `timeoutMs` parameter on `UploadQueue.waitForAll()`. If provided, the promise SHALL reject with a descriptive error if the queue has not drained within the specified time. Waiter settlement SHALL be guaranteed on every terminal path: when the queue drains (including via any terminal failure path such as a second concurrent 413 session-full error), registered waiters SHALL resolve; if the queue has been cancelled, `waitForAll()` SHALL reject with a cancellation error — both for waiters registered before `cancel()` (rejected by the cancellation itself) and for waiters registered after it (the cancelled check SHALL take precedence over the empty-queue early return). The queue SHALL NOT reach an empty active and pending state with waiters left unresolved.

#### Scenario: Queue drains before timeout

- **WHEN** `waitForAll(300000)` is called and all uploads complete within 5 minutes
- **THEN** the promise resolves normally

#### Scenario: Queue exceeds drain timeout

- **WHEN** `waitForAll(300000)` is called and uploads are still pending after 5 minutes
- **THEN** the promise rejects with an error message including completed/total counts
- **AND** the queue is NOT automatically cancelled (the caller decides how to handle the timeout)

#### Scenario: No timeout specified

- **WHEN** `waitForAll()` is called without a timeout parameter
- **THEN** the behavior is unchanged from current (waits indefinitely until queue drains)

#### Scenario: Waiter registered before cancellation rejects

- **GIVEN** `waitForAll()` is called while uploads are in flight
- **WHEN** `cancel()` is called on the queue
- **THEN** the promise rejects with a cancellation error

#### Scenario: Waiter registered on an already-cancelled queue rejects

- **GIVEN** the queue has been cancelled and its active and pending sets are empty
- **WHEN** `waitForAll()` is called
- **THEN** the promise rejects with a cancellation error instead of resolving via the empty-queue early return

#### Scenario: Last task terminal via concurrent 413 resolves waiters

- **GIVEN** multiple uploads are active and a first 413 has already set session-full mode
- **WHEN** a second concurrent 413 terminates the last active task
- **THEN** progress is notified and `waitForAll()` waiters resolve without waiting for the drain timeout
