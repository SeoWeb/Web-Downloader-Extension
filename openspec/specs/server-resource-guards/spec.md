# Server Resource Guards Specification

## Purpose

Governs host-resource protection on the server: a Docker memory limit with swap disabled, disk-space-aware cleanup that escalates to an aggressive pass past a configurable threshold, and read-only monitoring of the database connection pool.

## Requirements

### Requirement: Docker memory limit enforcement

The server container SHALL be configured with a memory limit to prevent unbounded RAM consumption from crashing the host system.

#### Scenario: Container memory is capped

- **WHEN** the Docker Compose configuration is applied
- **THEN** the app service has `mem_limit` set to 1GB (configurable via environment)

#### Scenario: OOM kill is disabled for diagnosis

- **WHEN** the container exceeds its memory limit
- **THEN** the container is not killed by the OOM killer; instead the application encounters MemoryError and logs the failure

#### Scenario: Swap is disabled

- **WHEN** the Docker Compose configuration is applied
- **THEN** the app service has `mem_swappiness` set to 0 to prevent masking memory issues with swap

### Requirement: Disk-space-aware cleanup

The cleanup service SHALL monitor disk usage and trigger aggressive cleanup when usage exceeds a configurable threshold.

#### Scenario: Normal cleanup when disk usage is below threshold

- **WHEN** disk usage is below the cleanup threshold (default 80%)
- **THEN** the cleanup service performs its normal time-based cleanup only

#### Scenario: Aggressive cleanup triggered by disk pressure

- **WHEN** disk usage exceeds the cleanup threshold
- **THEN** the cleanup service performs an aggressive pass that removes the oldest expired sessions first, then sessions within 10% of their expiry

#### Scenario: Cleanup threshold is configurable

- **WHEN** the `disk_cleanup_threshold_pct` config value is set to `90`
- **THEN** aggressive cleanup triggers when disk usage exceeds 90%

#### Scenario: Disk usage is logged after cleanup

- **WHEN** the cleanup service completes a run
- **THEN** the current disk usage percentage and bytes freed are logged at INFO level

### Requirement: Connection pool health monitoring

The server SHALL periodically log the database connection pool status for diagnostic purposes.

#### Scenario: Pool status logged periodically

- **WHEN** 5 minutes have elapsed since the last pool status log
- **THEN** the server logs pool size, checked-out connections, and overflow count at DEBUG level

#### Scenario: Pool exhaustion warning

- **WHEN** the number of checked-out connections exceeds 80% of `pool_size + max_overflow`
- **THEN** the server logs a WARNING with the current pool metrics

#### Scenario: Pool status does not change pool behavior

- **WHEN** pool monitoring is active
- **THEN** no pool configuration values are modified; monitoring is read-only

### Requirement: Registration rate limiting without dedup budget burn

Registration SHALL be rate-limited per client IP (5 requests/minute burst) and per extension instance id (default 10/day). A registration request resolved by the instance-id dedup lookup (the instance is already registered) SHALL NOT consume the per-instance daily budget; fresh registrations SHALL consume both budgets. The `Retry-After` emitted on a registration 429 SHALL be capped at `registration_retry_after_max_seconds` (default 300) instead of the raw hours-scale refill estimate.

#### Scenario: Dedup'd registration consumes no instance budget

- **GIVEN** an extension instance id that is already registered
- **WHEN** the instance registers repeatedly (more than the daily limit) within a day
- **THEN** every dedup'd registration returns the existing API key
- **AND** no 429 is produced for the dedup'd lookups

#### Scenario: Fresh registration still consumes budget

- **GIVEN** a never-before-registered instance id
- **WHEN** the daily per-instance limit is exhausted by fresh registrations
- **THEN** a further fresh registration is rejected with 429

#### Scenario: Retry-After is capped

- **WHEN** a registration 429 is emitted (per-IP or per-instance)
- **THEN** the `Retry-After` header value is at most `registration_retry_after_max_seconds` seconds

### Requirement: Proxy-aware limiter client keys

Client-IP limiter keys SHALL be resolved from the peer address by default; only when `TRUST_PROXY` is enabled SHALL the rightmost `X-Forwarded-For` entry be used, with the peer address as fallback when the header is absent or malformed. When `TRUST_PROXY` is disabled but requests arrive carrying `X-Forwarded-For` (proxy present but untrusted), the server SHALL log a rate-limited warning identifying that all such clients share one limiter bucket.

#### Scenario: Untrusted deployment keys limiters by peer address

- **GIVEN** `TRUST_PROXY` is disabled
- **WHEN** requests arrive through a proxy that appends `X-Forwarded-For`
- **THEN** limiter keys are derived from the peer address
- **AND** the server logs a warning (rate-limited) about the shared-bucket consequence

#### Scenario: Trusted proxy keys limiters by forwarded client

- **GIVEN** `TRUST_PROXY` is enabled
- **WHEN** a request arrives with `X-Forwarded-For: client, proxy`
- **THEN** the limiter key is derived from the rightmost entry the trusted proxy appended

#### Scenario: Missing forwarded header falls back to peer

- **GIVEN** `TRUST_PROXY` is enabled
- **WHEN** a request arrives without `X-Forwarded-For`
- **THEN** the limiter key is derived from the peer address

### Requirement: Bounded upload bodies

Content-text and filename-map upload bodies SHALL be size-capped: content text beyond `max_content_text_mb` and filename maps beyond `max_filename_map_bytes` or `max_filename_map_entries` SHALL be rejected with 413. Accepted content text SHALL count against the session size quota with the existing 413 quota semantics.

#### Scenario: Oversized content text is rejected

- **WHEN** a content-text upload exceeds `max_content_text_mb`
- **THEN** the server responds 413 with error `content_too_large`
- **AND** nothing is appended to the session's content file

#### Scenario: Content text counts against the session quota

- **GIVEN** a session whose stored size is near `max_session_size_mb`
- **WHEN** a within-cap content-text upload would push the session over the quota
- **THEN** the upload is rejected with 413 `session_size_exceeded`

#### Scenario: Oversized filename map is rejected

- **WHEN** a filename-map upload exceeds `max_filename_map_bytes` or `max_filename_map_entries`
- **THEN** the server responds 413 with error `filename_map_too_large`

### Requirement: Per-session resource count cap

The server SHALL cap the number of resource rows per session at `max_resources_per_session`; an upload that would exceed the cap SHALL be rejected with 413 `resources_count_exceeded` before any file is written. Deduplicated re-uploads (same URL hash) SHALL NOT count against the cap.

#### Scenario: Count cap rejects further uploads

- **GIVEN** a session already holding `max_resources_per_session` resource rows
- **WHEN** a new (non-duplicate) resource upload arrives
- **THEN** the server responds 413 with error `resources_count_exceeded`
- **AND** no file is written for the rejected upload

#### Scenario: Deduplicated uploads bypass the count cap

- **GIVEN** a session at the resource-count cap
- **WHEN** an upload for an already-stored URL hash arrives
- **THEN** the server returns the existing resource (deduplicated) without a 413

### Requirement: Accurate upload quota measurement

Session quota enforcement for resource uploads SHALL compare the actual decoded resource byte count against the remaining budget: the whole-multipart Content-Length of the request SHALL NOT be used as the quota measure, so legitimate uploads near the limit are not rejected for envelope overhead (boundaries, form fields). Non-gzip uploads SHALL be enforced mid-stream against the budget on bytes actually written, with the streamed file removed on rejection; the post-write aggregate check remains authoritative.

#### Scenario: Multipart overhead does not reject a legitimate upload

- **GIVEN** a session with remaining budget B and an upload whose decoded blob fits within B but whose whole multipart body (with boundaries and form fields) exceeds B
- **WHEN** the upload is streamed
- **THEN** the server accepts the upload based on the decoded byte count

#### Scenario: Oversized stream is rejected mid-stream

- **WHEN** a non-gzip upload's bytes written exceed the remaining session budget during streaming
- **THEN** the server aborts the write, removes the partial file, and responds 413

### Requirement: Rate limiter self-maintenance

The rate limiter SHALL increment its maintenance call counter exactly once per `is_allowed()` invocation so stale-bucket pruning runs at the documented interval (every ~100 calls), not twice as often.

#### Scenario: Cleanup cadence matches the documented interval

- **WHEN** `is_allowed()` is invoked 100 times
- **THEN** the internal call counter has advanced by exactly 100
- **AND** stale-bucket pruning executes once at that boundary
