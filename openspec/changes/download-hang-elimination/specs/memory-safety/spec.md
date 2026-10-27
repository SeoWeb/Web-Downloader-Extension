## MODIFIED Requirements

### Requirement: Recoverable memory gating

Any queue pause caused by memory pressure SHALL be recoverable without a service-worker restart: the resume condition SHALL be evaluable from live state, and the per-download memory gate SHALL reflect real availability, not a stale cumulative counter. A queue paused by a `critical` delivery SHALL be resumed by the first pressure-callback delivery whose level is below `critical` — the consumer SHALL NOT require the level to be exactly `low` to resume. Because pressure callbacks are delivered only on high-zone boundary transitions (entering or leaving the high zone) and carry the boundary level, the transition that leaves the high zone (for example `critical` → `medium`) is itself the resume signal. After `forceCleanup` releases resources and recomputes usage, the memory manager SHALL re-evaluate memory pressure so recovery does not wait for the next periodic check.

#### Scenario: Queue resumes after pressure clears

- **GIVEN** the request queue was paused at `critical` pressure and in-flight allocations are released
- **WHEN** pressure is re-evaluated from live usage and drops below the high zone
- **THEN** the queue resumes without a service-worker restart

#### Scenario: Leaving the high zone resumes the paused queue

- **GIVEN** the queue was paused by a `critical` pressure delivery
- **WHEN** the next boundary transition delivers `medium` (leaving the high zone)
- **THEN** the queue resumes processing on that delivery
- **AND** it does not stay paused waiting for a `low` delivery that the boundary-only notification discipline never sends

#### Scenario: Force cleanup re-evaluates pressure

- **GIVEN** the queue was paused at `critical` pressure
- **WHEN** `forceCleanup` completes and the recomputed live usage is below the high threshold
- **THEN** memory pressure is re-evaluated immediately and the resume callback runs
- **AND** the queue resumes instead of waiting for the next periodic memory check

#### Scenario: Back-to-back downloads are not blocked by stale usage

- **WHEN** a first download completes and the user immediately starts a second download
- **THEN** the second download is not rejected with a memory error unless actual in-flight usage exceeds the real threshold
