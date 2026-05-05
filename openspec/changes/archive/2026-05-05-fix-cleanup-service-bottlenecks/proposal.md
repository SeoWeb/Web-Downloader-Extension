## Why

Expired sessions accumulate on disk indefinitely because the periodic cleanup task stalls. The root cause is `_remove_expired_sessions` loading every `Resource` row and deleting them one-by-one (~6,800 rows for 4 sessions) — work that is completely redundant since the database has `ON DELETE CASCADE` on the foreign key. Synchronous file I/O (`shutil.rmtree`, `os.walk`) blocks the async event loop on large directories (1.7 GB), and the entire cleanup runs in a single transaction that only commits after everything finishes, so nothing is durable if the process is interrupted.

## What Changes

- Remove the redundant per-resource deletion loop in `_remove_expired_sessions` and `_aggressive_cleanup` — rely on `ON DELETE CASCADE` instead
- Replace ORM `db.delete(session)` with bulk `DELETE ... WHERE id IN (...)` statements
- Split the two-step expiry process into a bulk `UPDATE` pass (mark expired) followed by a batched bulk `DELETE` pass (remove records), with per-batch `commit()` for durability
- Offload all synchronous file I/O (`shutil.rmtree`, `os.walk`, `os.listdir`, `os.path.exists`) to `asyncio.to_thread` to avoid blocking the event loop
- Apply the same fixes to the API `DELETE /sessions/{id}` endpoint

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `server-session-storage`: Cleanup service now uses bulk DELETE with CASCADE and non-blocking file I/O instead of one-by-one ORM deletion and synchronous file operations

## Impact

- `server/app/services/cleanup.py` — primary file, all four cleanup methods rewritten
- `server/app/api/routes/sessions.py` — `delete_session` endpoint simplified
- Database: relies on existing `ON DELETE CASCADE` FK constraints on `resources.session_id` and `html_chunks.session_id`
