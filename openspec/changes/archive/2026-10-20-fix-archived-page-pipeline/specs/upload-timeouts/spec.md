## MODIFIED Requirements

### Requirement: Resource upload request timeout

The system SHALL apply a 5-minute timeout to every resource upload fetch call in `ServerClient.uploadResource()`. If the request does not complete within this time, it SHALL be aborted and treated as a network error eligible for retry. A timeout abort surfaces as a `DOMException` whose `name` is `TimeoutError` (not `AbortError`); the upload queue's retry classifier SHALL treat `TimeoutError` as retryable so a hung upload consumes the normal retry budget instead of failing permanently on its first attempt. User cancellation remains distinguishable and terminal: an `AbortError` (from the queue's cancellation controllers) SHALL NOT be classified as retryable.

#### Scenario: Resource upload completes within timeout

- **WHEN** `uploadResource()` sends a fetch request that completes in under 5 minutes
- **THEN** the upload proceeds normally without interruption

#### Scenario: Resource upload exceeds timeout

- **WHEN** `uploadResource()` sends a fetch request that does not complete within 5 minutes
- **THEN** the request is aborted via `AbortSignal.timeout()` and rejects with a `DOMException` named `TimeoutError`
- **AND** the error is classified as retryable by the upload queue and retried with backoff

#### Scenario: Timeout exhaustion is terminal and visible

- **WHEN** every retry attempt of an upload ends in `TimeoutError`
- **THEN** the task eventually becomes permanently failed after the retry budget is exhausted
- **AND** the terminal failure is logged once and reflected in the queue's failed count

#### Scenario: User cancellation is not mistaken for a timeout

- **WHEN** the user cancels a download and the in-progress upload aborts with `AbortError`
- **THEN** the queue does NOT retry the task
- **AND** the task is marked failed by the cancellation path, not by the timeout path

#### Scenario: Timeout combines with user cancellation signal

- **WHEN** `uploadResource()` is called with both a user-provided `AbortSignal` and a timeout
- **THEN** the fetch aborts if EITHER the user cancels OR the timeout fires
- **AND** `AbortSignal.any()` is used to combine both signals (with manual fallback for Chrome <116)
