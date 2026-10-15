## ADDED Requirements

### Requirement: Accurate memory accounting
The memory manager SHALL track the actual size of in-flight allocations: usage SHALL increase when a request's response is received (by `Content-Length` or actual byte length) and SHALL decrease when that request completes, fails, or is cancelled. Accounting entries SHALL exist for every tracked allocation so that release operations always match an active record.

#### Scenario: Usage returns to baseline after a download
- **WHEN** a download completes and all its requests have settled
- **THEN** `currentUsage` returns to zero (or the level of unrelated in-flight downloads)

#### Scenario: Release of an unknown record is a no-op that cannot corrupt state
- **WHEN** `releaseResource` is called with an ID that has no active allocation
- **THEN** usage is unchanged and a warning is logged

#### Scenario: Force cleanup resets counters from live state
- **WHEN** `forceCleanup` runs
- **THEN** `currentUsage` is recomputed from the set of actually in-flight allocations, not left at a stale high-water mark

### Requirement: Ordered memory pressure levels
Memory pressure levels SHALL be compared using an explicit numeric rank (low < medium < high < critical), never lexicographically. Pressure-triggered actions SHALL fire only when the rank meets or exceeds the configured threshold.

#### Scenario: Low pressure does not trigger cleanup
- **WHEN** an allocation completes while pressure is `low`
- **THEN** no pressure handler fires and the queue is not paused or resumed

#### Scenario: Critical pressure triggers cleanup
- **WHEN** pressure reaches `critical`
- **THEN** force cleanup runs and the throttling callback is invoked exactly once per pressure transition

### Requirement: Recoverable memory gating
Any queue pause caused by memory pressure SHALL be resumable: the resume condition SHALL be evaluable from live state, and the per-download memory gate SHALL reflect real availability, not a stale cumulative counter.

#### Scenario: Queue resumes after pressure clears
- **WHEN** the queue was paused at `critical` pressure and in-flight allocations are released
- **THEN** pressure is re-evaluated from live usage and the queue resumes without a service worker restart

#### Scenario: Back-to-back downloads are not blocked by stale usage
- **WHEN** a first download completes and the user immediately starts a second download
- **THEN** the second download is not rejected with a memory error unless actual in-flight usage exceeds the real threshold
