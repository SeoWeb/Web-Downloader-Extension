## MODIFIED Requirements

### Requirement: Server Restart Recovery

The server SHALL recover gracefully from restarts by detecting stale sessions.

#### Scenario: Stale sessions marked as failed on startup

- **WHEN** the server starts
- **THEN** all sessions in `scraping` or `uploading` status that were last updated more than `STALE_SESSION_TIMEOUT_MINUTES` ago (default 30) are marked as `failed`
- **AND** an error message is stored indicating the server restarted
- **AND** the extension will detect the failed status and offer local fallback
- **AND** the timeout threshold is configurable to accommodate slow uploads of large sessions

#### Scenario: Assembling sessions on restart

- **WHEN** the server starts and a session is in `assembling` status
- **THEN** the session is marked as `failed` with an error indicating assembly was interrupted
- **AND** the partial ZIP file is cleaned up from disk

#### Scenario: Ready sessions preserved on restart

- **WHEN** the server starts and sessions are in `ready` status
- **THEN** those sessions remain available for download
- **AND** their ZIP files are expected to still exist on disk

#### Scenario: Periodic cleanup does not kill active assemblies

- **WHEN** the periodic cleanup runs
- **AND** a session is in `assembling` status
- **THEN** the cleanup SHALL NOT mark the session as failed if an active assembly task is registered in the `AssemblyTaskManager`
- **AND** the cleanup SHALL NOT mark the session as failed if it has been in `assembling` status for less than `STALE_SESSION_TIMEOUT_MINUTES`

#### Scenario: Periodic cleanup marks stale assemblies as failed

- **WHEN** the periodic cleanup runs
- **AND** a session has been in `assembling` status for longer than `STALE_SESSION_TIMEOUT_MINUTES`
- **AND** no active assembly task is registered for that session
- **THEN** the session is marked as `failed` with an error indicating assembly timed out
- **AND** the partial output file is cleaned up from disk

### Requirement: Cleanup Cron Job

The server SHALL run a periodic cleanup job that removes expired sessions.

#### Scenario: Cleanup runs periodically

- **WHEN** the server is running
- **THEN** a cleanup job runs every hour
- **AND** removes all sessions with `expires_at` in the past
- **AND** marks stale assembling sessions as failed (per "Periodic cleanup marks stale assemblies as failed" scenario)

#### Scenario: Cleanup on startup

- **WHEN** the server starts
- **THEN** a one-time cleanup runs to remove any sessions that expired while the server was down
- **AND** stale session recovery (see Server Restart Recovery) runs before expiry cleanup
- **AND** ALL sessions in `assembling` status are marked as failed (background tasks are lost on restart)
- **AND** an orphan scan is performed: any session directory under `<storage_root>/` whose UUID does not correspond to a session record in the database is deleted from disk, covering cases where a crash occurred between DB record deletion and disk file deletion
