## MODIFIED Requirements

### Requirement: Upload Queue Concurrency

The UploadQueue SHALL support up to 12 concurrent uploads by default. This replaces the previous limit of 5. The concurrency limit ensures the server's rate limiter (60 requests/second with burst of 100) is not overwhelmed while maximizing upload throughput.

#### Scenario: Default concurrency allows 12 simultaneous uploads
- **GIVEN** an UploadQueue is created without explicit concurrency override
- **WHEN** 15 resources are enqueued simultaneously
- **THEN** the first 12 uploads start immediately
- **AND** the remaining 3 start as earlier uploads complete

#### Scenario: Custom concurrency is respected
- **GIVEN** an UploadQueue is created with `{ maxConcurrency: 3 }`
- **WHEN** resources are enqueued
- **THEN** at most 3 uploads run concurrently

### Requirement: Promise-Based Queue Completion

The `waitForAll()` method SHALL use promise-based notification instead of polling. When the queue is empty and all tasks are finished, any waiting caller is notified immediately without a polling delay.

#### Scenario: waitForAll resolves immediately when queue is empty
- **GIVEN** all uploads have completed and the queue is empty
- **WHEN** `waitForAll()` is called
- **THEN** it resolves immediately without delay

#### Scenario: waitForAll resolves promptly when last upload completes
- **GIVEN** one upload is still in progress and `waitForAll()` is waiting
- **WHEN** the last upload completes
- **THEN** `waitForAll()` resolves within 1ms (no 100ms polling delay)

#### Scenario: waitForAll rejects on queue cancellation
- **GIVEN** `waitForAll()` is waiting and the queue is cancelled
- **WHEN** `cancel()` is called on the queue
- **THEN** `waitForAll()` rejects with an error
