## ADDED Requirements

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
