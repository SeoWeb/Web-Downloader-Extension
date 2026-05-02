## ADDED Requirements

### Requirement: Resource upload request timeout
The system SHALL apply a 5-minute timeout to every resource upload fetch call in `ServerClient.uploadResource()`. If the request does not complete within this time, it SHALL be aborted and treated as a network error eligible for retry.

#### Scenario: Resource upload completes within timeout
- **WHEN** `uploadResource()` sends a fetch request that completes in under 5 minutes
- **THEN** the upload proceeds normally without interruption

#### Scenario: Resource upload exceeds timeout
- **WHEN** `uploadResource()` sends a fetch request that does not complete within 5 minutes
- **THEN** the request is aborted via `AbortSignal.timeout()`
- **AND** the error is classified as retryable by the upload queue

#### Scenario: Timeout combines with user cancellation signal
- **WHEN** `uploadResource()` is called with both a user-provided `AbortSignal` and a timeout
- **THEN** the fetch aborts if EITHER the user cancels OR the timeout fires
- **AND** `AbortSignal.any()` is used to combine both signals (with manual fallback for Chrome <116)

### Requirement: Control-plane API call timeout
The system SHALL apply a 60-second timeout to all control-plane API calls made via `ServerClient.authenticatedFetch()`. This includes session creation, scrape-complete, finalize, filename map upload, and content upload.

#### Scenario: API call completes within timeout
- **WHEN** `authenticatedFetch()` sends a request that completes in under 60 seconds
- **THEN** the request proceeds normally

#### Scenario: API call exceeds timeout
- **WHEN** `authenticatedFetch()` sends a request that does not complete within 60 seconds
- **THEN** the request is aborted and the error propagates to the caller

### Requirement: Upload queue drain timeout
The system SHALL accept an optional `timeoutMs` parameter on `UploadQueue.waitForAll()`. If provided, the promise SHALL reject with a descriptive error if the queue has not drained within the specified time.

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

### Requirement: Calculated queue timeout based on resource count
In `executeDownloadServerMode()`, the system SHALL calculate a dynamic timeout for `waitForAll()` based on the number of remaining resources: `min(remaining_resources * 30 seconds, 30 minutes)`. This provides sufficient time for large downloads while preventing infinite stalls.

#### Scenario: Small download uses short timeout
- **WHEN** there are 10 remaining resources to upload
- **THEN** `waitForAll()` is called with a timeout of 300 seconds (10 * 30s)

#### Scenario: Large download uses capped timeout
- **WHEN** there are 2000 remaining resources to upload
- **THEN** `waitForAll()` is called with a timeout of 1800 seconds (30 minute cap)

### Requirement: Upload heartbeat during queue drain
The system SHALL send upload progress messages to the UI every 15 seconds while `waitForAll()` is executing. This ensures the sidepanel can detect a dead service worker (no messages for 60+ seconds).

#### Scenario: Heartbeat fires during uploads
- **WHEN** `waitForAll()` is executing and 15 seconds have elapsed since the last progress message
- **THEN** a `status.uploadProgress` message is sent to the UI with current completed/total counts

#### Scenario: Heartbeat stops on queue completion
- **WHEN** `waitForAll()` resolves or rejects
- **THEN** the heartbeat interval is cleared and no further messages are sent
