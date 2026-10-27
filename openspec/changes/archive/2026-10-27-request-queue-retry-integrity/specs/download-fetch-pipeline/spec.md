## ADDED Requirements

### Requirement: Retry owns the failure signal

The `RequestQueue` SHALL treat a retryable failure as a non-terminal outcome: when a request's attempt fails and a retry is scheduled, the queue SHALL NOT invoke the request's `onError` callback for that attempt. The request's failure callback SHALL fire at most once per request, and only after the final attempt is exhausted or the failure is terminal. A retried request that eventually succeeds SHALL be reported through `onComplete` exactly once and SHALL NOT be reported as failed. Pending retry timers SHALL be cancelled on teardown so no retry outlives its download.

#### Scenario: Transient 5xx retried to success is archived, not failed

- **GIVEN** an enqueued asset whose first attempt fails with an HTTP 5xx response and retries remain
- **WHEN** the detached retry fetch succeeds
- **THEN** the handler's `onComplete` fires exactly once with the result and `onError` never fires
- **AND** the asset is present in the archive and counted as successful (not in the failure tally)
- **AND** the URL is fetched exactly once per attempt of the retry schedule, with no duplicate fetch after the handler settled

#### Scenario: Retry exhaustion reports failure exactly once after the final attempt

- **GIVEN** an enqueued asset whose every attempt fails with a retryable 5xx response and `maxRetries` is N
- **WHEN** the final (N+1-th) attempt fails
- **THEN** the handler's `onError` fires exactly once, after the final attempt
- **AND** no retry is scheduled afterwards

#### Scenario: Permanent failure reports immediately without a retry

- **GIVEN** an enqueued asset whose first attempt fails with HTTP 404
- **WHEN** the queue classifies the failure as non-retryable
- **THEN** the handler's `onError` fires exactly once, immediately on the first attempt
- **AND** no retry fetch is started

#### Scenario: Teardown cancels a pending retry

- **GIVEN** a request whose detached retry timer is pending
- **WHEN** `clear()` or `clearDownload()` runs for that request
- **THEN** the retry timer is cancelled and the URL is not re-fetched

### Requirement: Teardown settles every dropped request

`RequestQueue.clear()` SHALL settle every dropped request: each in-flight request SHALL receive `onError` with a `cancelled`-category error and have its domain-limiter slot released before its tracking entry is dropped, and each still-queued request SHALL receive `onError` with a `cancelled`-category error. Every handler promise awaiting a dropped request SHALL settle, and no dropped request SHALL settle twice. `RequestScheduler.clear()` SHALL NOT silently drop active entries without a settlement owner.

#### Scenario: clear() with in-flight requests settles every handler promise

- **GIVEN** requests are in flight and others are still queued
- **WHEN** `clear()` aborts the in-flight requests and drops the queue
- **THEN** every awaiting handler promise settles exactly once with a `cancelled` error
- **AND** each in-flight request's domain-limiter connection slot is released
- **AND** the aborted fetches' later rejections cause no second settlement

#### Scenario: Teardown leaves no orphan work

- **GIVEN** `clear()` has dropped in-flight and queued requests
- **WHEN** the aborted fetches reject
- **THEN** no further fetch is started for any dropped request and no dropped request re-enters the scheduler

### Requirement: Queue liveness under internal errors

The `RequestQueue` processing loop SHALL reschedule itself after an internal error — for example an exception thrown while reading the adaptive concurrency, looking up a domain limiter, or dequeuing — whenever schedulable work remains. An internal error MAY delay a processing cycle but SHALL NOT strand a non-empty scheduler until an unrelated enqueue or completion.

#### Scenario: Internal throw before dispatch does not strand the queue

- **GIVEN** the scheduler holds queued requests and the dequeue loop throws before starting or deferring any request
- **WHEN** the processing cycle fails internally
- **THEN** the queue schedules another processing cycle
- **AND** the queued requests proceed without waiting for an unrelated enqueue or completion

### Requirement: Paused queue performs no busy work

Pausing the queue SHALL stop all self-rescheduling processing timers in the queue and its scheduler: while paused, no timer-driven processing cycle SHALL run for queued work. Resuming SHALL restart processing of already-queued work in both the queue and the scheduler.

#### Scenario: Paused queue consumes no timers

- **GIVEN** the queue is paused while requests are queued
- **WHEN** an observation window elapses
- **THEN** neither the queue nor the scheduler runs any timer-driven processing cycle for that work

#### Scenario: Resume restarts processing

- **GIVEN** the queue is paused with queued requests
- **WHEN** `resume()` is called
- **THEN** the queued requests are processed

## MODIFIED Requirements

### Requirement: Fair scheduling across rate-limited domains

The `RequestQueue` processing loop SHALL continue dispatching requests to non-limited domains when the head of the queue belongs to a saturated domain, and SHALL NOT busy-spin while all eligible requests are blocked. The wait before the next processing cycle SHALL be derived from the actual blocking condition — rate-window exhaustion, robots.txt crawl delay, or connection-pool saturation — so a saturated connection pool yields a real estimated wait instead of the minimum processing tick.

#### Scenario: Slow domain does not starve fast domains

- **WHEN** the queue head targets a domain whose limiter is cooling down and later queued requests target other ready domains
- **THEN** the ready requests start before the limited domain's cooldown expires

#### Scenario: Idle loop waits instead of spinning

- **WHEN** every queued request is blocked by its domain limiter
- **THEN** the processing loop waits for the nearest limiter availability instead of polling at a fixed 10 ms interval

#### Scenario: Saturated connection pool waits on a real estimate

- **WHEN** a domain's connection pool is full and every queued request targets that domain
- **THEN** `getWaitTime()` returns a non-zero estimated wait for that limiter
- **AND** the processing loop schedules its next cycle at that wait instead of the minimum tick
