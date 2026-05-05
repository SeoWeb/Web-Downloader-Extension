## MODIFIED Requirements

### Requirement: Session Auto-Expiry

The server SHALL automatically expire sessions after a configurable retention period.

#### Scenario: Session expires after retention period

- **WHEN** a session's `expires_at` timestamp is reached
- **THEN** the server marks the session as `expired` via a bulk UPDATE statement
- **AND** deletes the session record via a bulk DELETE statement (CASCADE automatically removes associated resource and html_chunk records)
- **AND** deletes all associated resource files and ZIP from disk
- **AND** no explicit per-resource DELETE queries are issued

#### Scenario: Default retention period

- **WHEN** a session is created without specifying a retention period
- **THEN** the `expires_at` is set to 1 day from creation

#### Scenario: Configurable retention period

- **WHEN** a session is created with a `retentionDays` parameter
- **THEN** the `expires_at` is set to `retentionDays` from creation

### Requirement: Cleanup Cron Job

The server SHALL run a cleanup job on startup and at a configurable interval (default 1 hour). The cleanup job removes expired sessions, marks stale assemblies as failed, AND monitors disk usage to trigger aggressive cleanup when storage capacity is under pressure.

#### Scenario: Normal hourly cleanup

- **WHEN** the cleanup interval elapses and disk usage is below the aggressive threshold
- **THEN** expired sessions are removed, stale assemblies are marked as failed, and disk usage is logged
- **AND** expired-session removal commits per batch of 100 sessions for crash durability
- **AND** file-system operations (directory deletion, directory listing, path existence checks) are executed via `asyncio.to_thread` to avoid blocking the async event loop

#### Scenario: Aggressive cleanup under disk pressure

- **WHEN** disk usage exceeds the configured threshold (default 80%)
- **THEN** the cleanup service removes the oldest expired sessions first, then removes sessions approaching expiry (within 10% of retention period), and logs the bytes freed
- **AND** session deletion relies on ON DELETE CASCADE for associated resource and html_chunk records
- **AND** directory-size calculation and directory deletion are executed via `asyncio.to_thread`

#### Scenario: Disk usage logged after every cleanup run

- **WHEN** any cleanup run completes
- **THEN** the current disk usage percentage and total bytes freed are logged at INFO level

#### Scenario: Cleanup on startup

- **WHEN** the server starts
- **THEN** a one-time cleanup runs to remove any sessions that expired while the server was down
- **AND** stale session recovery (see Server Restart Recovery) runs before expiry cleanup
- **AND** ALL sessions in `assembling` status are marked as failed (background tasks are lost on restart)
- **AND** an orphan scan is performed: any session directory under `<storage_root>/` whose UUID does not correspond to a session record in the database is deleted from disk, covering cases where a crash occurred between DB record deletion and disk file deletion
- **AND** file-system operations in the orphan scan are executed via `asyncio.to_thread`

### Requirement: File Storage on Local Filesystem

The server SHALL store uploaded resource files and assembled ZIPs on the local filesystem.

#### Scenario: Session deletion removes files

- **WHEN** a session is deleted via the API `DELETE /sessions/{id}` endpoint
- **THEN** the session's storage directory is removed from disk via `asyncio.to_thread`
- **AND** the session record is deleted via a bulk DELETE statement
- **AND** no explicit per-resource DELETE queries are issued (CASCADE handles resource records)
