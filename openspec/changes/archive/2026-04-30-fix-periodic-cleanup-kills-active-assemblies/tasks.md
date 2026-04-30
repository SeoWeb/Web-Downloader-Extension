## 1. Separate periodic from startup cleanup

- [x] 1.1 Add `_mark_stale_assembling_sessions_failed` method to `CleanupService` in `cleanup.py` that only marks sessions in `assembling` status where `updated_at` is older than `stale_session_timeout_minutes` AND no active task exists in `AssemblyTaskManager`
- [x] 1.2 Refactor `run_periodic_cleanup` to be its own method (not delegating to `run_startup_cleanup`) — replace `_mark_assembling_sessions_failed` call with `_mark_stale_assembling_sessions_failed`
- [x] 1.3 Import `assembly_task_manager` in `cleanup.py` and use `is_running(session_id)` as a guard before marking sessions as failed

## 2. Tests

- [x] 2.1 Add test: periodic cleanup does NOT mark an actively assembling session as failed when `AssemblyTaskManager` has a registered task
- [x] 2.2 Add test: periodic cleanup marks an assembling session as failed when it has been in `assembling` status for > 30 minutes and no task is registered
- [x] 2.3 Add test: startup cleanup still marks ALL assembling sessions as failed regardless of age or task registration
