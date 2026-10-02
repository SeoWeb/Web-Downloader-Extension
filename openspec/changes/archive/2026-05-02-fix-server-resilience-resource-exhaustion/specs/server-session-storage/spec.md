## MODIFIED Requirements

### Requirement: Cleanup Cron Job
The server SHALL run a cleanup job on startup and at a configurable interval (default 1 hour). The cleanup job removes expired sessions, marks stale assemblies as failed, AND monitors disk usage to trigger aggressive cleanup when storage capacity is under pressure.

#### Scenario: Normal hourly cleanup
- **WHEN** the cleanup interval elapses and disk usage is below the aggressive threshold
- **THEN** expired sessions are removed, stale assemblies are marked as failed, and disk usage is logged

#### Scenario: Aggressive cleanup under disk pressure
- **WHEN** disk usage exceeds the configured threshold (default 80%)
- **THEN** the cleanup service removes the oldest expired sessions first, then removes sessions approaching expiry (within 10% of retention period), and logs the bytes freed

#### Scenario: Disk usage logged after every cleanup run
- **WHEN** any cleanup run completes
- **THEN** the current disk usage percentage and total bytes freed are logged at INFO level
