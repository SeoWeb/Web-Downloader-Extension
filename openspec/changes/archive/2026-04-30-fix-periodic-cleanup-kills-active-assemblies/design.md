## Context

The cleanup service (`cleanup.py`) has two cleanup modes: startup and periodic (every 1 hour). Currently, `run_periodic_cleanup` delegates directly to `run_startup_cleanup`, which includes `_mark_assembling_sessions_failed`. This method marks ALL sessions in `assembling` status as failed — appropriate on startup (when in-process asyncio tasks are lost), but destructive during periodic runs where assembly tasks are still active.

Observed failure: 1 in 5 downloads fails with "Assembly was interrupted by server restart" because either (a) the server actually restarted mid-assembly, or (b) the periodic cleanup fires while assembly is running.

Key files:
- `server/app/services/cleanup.py` — `CleanupService` with startup and periodic paths
- `server/app/services/assembly_manager.py` — `AssemblyTaskManager` tracks in-process tasks
- `server/app/services/session_manager.py` — `mark_failed()` transitions session state

## Goals / Non-Goals

**Goals:**
- Prevent periodic cleanup from killing actively assembling sessions
- Preserve startup behavior: mark all assembling sessions as failed on restart (correct — tasks are lost)
- Add an age-based timeout for periodic detection of truly stale assemblies (e.g., assembling for > 30 minutes)

**Non-Goals:**
- Assembly persistence across restarts (too complex; out of scope)
- Changing the stale session timeout for scraping/uploading sessions
- Changing the cleanup interval (stays at 1 hour)

## Decisions

### 1. Split `run_periodic_cleanup` from `run_startup_cleanup`

**Decision**: `run_periodic_cleanup` gets its own implementation that skips the blanket `_mark_assembling_sessions_failed` step. Instead it calls a new `_mark_stale_assembling_sessions_failed` that uses an age threshold.

**Rationale**: Startup and periodic cleanup have fundamentally different semantics for assembling sessions. On startup, ALL assembling sessions are orphans (tasks are gone). During periodic runs, most assembling sessions are actively being processed and must not be touched.

**Alternative considered**: Add a `is_startup` flag to `run_startup_cleanup`. Rejected — the methods have different enough logic to justify separate implementations.

### 2. Age threshold for stale assemblies = `stale_session_timeout_minutes` (30 min)

**Decision**: Use the same 30-minute threshold already configured for scraping/uploading stale detection.

**Rationale**: Assembly is typically fast (seconds to a few minutes). 30 minutes is a generous upper bound. Reuses existing config — no new settings needed.

### 3. Check `AssemblyTaskManager` before marking as failed

**Decision**: During periodic cleanup, skip sessions that have an active registered task.

**Rationale**: Even with the age check, a defensive lookup in `AssemblyTaskManager` prevents a race where cleanup reads a session that just entered assembling status.

## Risks / Trade-offs

- **[Genuinely stuck assemblies not detected until timeout]** → Mitigated by the 30-minute age threshold. This is the same timeout used for scraping/uploading sessions and is reasonable.
- **[Server restart + immediate periodic cleanup race]** → No impact: startup cleanup runs synchronously before periodic cleanup starts, so restarted assemblies are already handled.
