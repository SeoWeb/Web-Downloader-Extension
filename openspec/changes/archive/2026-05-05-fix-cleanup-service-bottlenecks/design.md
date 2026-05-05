## Context

The cleanup service (`server/app/services/cleanup.py`) runs as an async background task every hour. It removes expired sessions by deleting their DB records and disk files. The current implementation loads every `Resource` row for a session into memory and deletes them one-by-one via `await db.delete(resource)` — a loop that produces thousands of sequential DB round-trips. This is entirely redundant because both `resources.session_id` and `html_chunks.session_id` have `ForeignKey(..., ondelete="CASCADE")`.

The file I/O (`shutil.rmtree`, `os.walk`, `os.listdir`) is synchronous, blocking the async event loop for the duration of large directory deletions (e.g. 1.7 GB). The entire periodic cleanup runs inside a single DB transaction that only commits after every method returns — so if the resource-deletion loop takes 30+ minutes, nothing is committed.

The same patterns exist in the API `DELETE /sessions/{id}` endpoint and the aggressive cleanup path.

## Goals / Non-Goals

**Goals:**
- Make expired-session deletion complete in seconds instead of stalling indefinitely
- Avoid blocking the async event loop during file I/O
- Ensure cleanup progress is durable per batch (survive process crash mid-cleanup)
- Fix the API delete endpoint to use the same efficient pattern

**Non-Goals:**
- Changing log levels (set externally via uvicorn/ENV)
- Adding new cleanup triggers or schedules
- Modifying the `session_manager.py` `delete_session_files` helper (not called from cleanup)
- Changing the two-step expiry protocol (mark expired → delete)

## Decisions

### 1. Rely on ON DELETE CASCADE instead of manual resource deletion

**Decision**: Remove all explicit `select(Resource)` / `delete(Resource)` calls. Delete the session record only — the database FK cascade removes associated resources and html_chunks automatically.

**Why**: The `ON DELETE CASCADE` constraint already exists in the DDL (migration 001) and ORM model (`ForeignKey("sessions.id", ondelete="CASCADE")`). The manual loop is pure redundancy that adds O(N) DB round-trips per session.

**Alternative**: Keep explicit deletion as a "safety net". Rejected — it's the cause of the stall and provides no additional safety.

### 2. Bulk DELETE statements instead of ORM delete()

**Decision**: Use `delete(Session).where(Session.id.in_(batch_ids))` instead of loading ORM objects and calling `db.delete(session)`.

**Why**: Bulk DELETE is a single SQL statement regardless of batch size. ORM `db.delete()` issues individual DELETE statements and requires loading the object first.

**Alternative**: Keep ORM deletion for individual sessions. Rejected for the batch paths — the bulk approach is strictly more efficient.

### 3. Two-pass expiry with per-batch commit

**Decision**: Split `_remove_expired_sessions` into:
- Pass 1: Bulk `UPDATE` to mark all expired sessions as `EXPIRED`
- Pass 2: Loop in batches of 100 — bulk `DELETE` sessions + file cleanup, `await db.commit()` per batch

**Why**: Per-batch commit ensures progress is durable even if the process crashes. The two-pass approach preserves the protocol where clients can observe the `EXPIRED` status before records are removed.

**Alternative**: Single-pass with commit per session. Rejected — bulk is faster and 100-per-batch is a reasonable granularity.

### 4. asyncio.to_thread for file I/O

**Decision**: Wrap all `shutil.rmtree`, `os.walk`, `os.listdir`, `os.path.exists`, `os.path.isdir`, and `os.remove` calls in `asyncio.to_thread()`.

**Why**: These are synchronous system calls that block the event loop. `asyncio.to_thread` is already the established pattern in this codebase (`zip_assembler.py` has 8 call sites).

**Alternative**: Use `run_in_executor`. Equivalent but `asyncio.to_thread` is the modern API and matches existing patterns.

## Risks / Trade-offs

- **CASCADE not actually in DDL** → Verified in migration 001 (`ON DELETE CASCADE` is present in the initial schema migration). If somehow missing, sessions would delete but resources would be orphaned. Existing orphan-directory cleanup would catch the disk files.

- **Per-batch commit commits stale-session marks early** → This is actually desirable. Stale sessions marked as failed in step 1 become visible to clients sooner.

- **Pass 2 queries by `status == EXPIRED`** → Sessions that expire between Pass 1 and Pass 2 are missed until the next cleanup cycle. Acceptable — same gap exists in the current code between the `expires_at` check and actual deletion.
