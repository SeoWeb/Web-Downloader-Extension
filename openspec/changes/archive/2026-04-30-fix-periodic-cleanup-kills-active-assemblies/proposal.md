## Why

The cleanup service marks ALL sessions in `assembling` status as failed with "Assembly was interrupted by server restart" — even during periodic cleanup, not just on startup. This kills actively assembling sessions. In practice this causes intermittent download failures (observed 1 in 5 test runs), because the server restarts while assembly is in progress and the startup cleanup correctly identifies the orphaned session.

Additionally, even without a restart, the periodic cleanup reuses `run_startup_cleanup` which includes `_mark_assembling_sessions_failed`, meaning any assembly running when the hourly periodic cleanup fires will be incorrectly killed.

## What Changes

- **Split startup-only vs periodic cleanup logic**: `_mark_assembling_sessions_failed` must only run on server startup (when in-process asyncio tasks are guaranteed lost). Periodic cleanup should instead check assembly age — only fail sessions that have been assembling longer than a timeout.
- **Add assembly age check**: During periodic cleanup, use the session's `updated_at` (set when transitioning to `assembling`) to detect truly stale assemblies, not blanket-fail all assembling sessions.
- **Add graceful recovery**: When periodic cleanup finds a stale assembling session, cancel its background task via `AssemblyTaskManager` before marking failed.

## Capabilities

### New Capabilities

_None_

### Modified Capabilities

- `server-session-storage`: cleanup logic for assembling sessions needs to distinguish startup recovery from periodic stale-session detection, and use age-based timeout for periodic runs

## Impact

- `server/app/services/cleanup.py` — main file to modify
- `server/app/services/assembly_manager.py` — may need to expose active task IDs for periodic cleanup to skip or cancel
- `server/tests/test_session_lifecycle.py` — test coverage for the new behavior
