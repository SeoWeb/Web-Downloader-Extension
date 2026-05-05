## 1. Cleanup Service — Helper Methods

- [x] 1.1 Add `update` to the `sqlalchemy` import in `cleanup.py` (line 29)
- [x] 1.2 Add `_remove_dir_async(path)` helper — wraps `os.path.exists` + `shutil.rmtree` in `asyncio.to_thread`
- [x] 1.3 Add `_dir_size_async(path)` helper — wraps `_dir_size` in `asyncio.to_thread`

## 2. Cleanup Service — Expired Session Removal

- [x] 2.1 Rewrite `_remove_expired_sessions`: Pass 1 — bulk `UPDATE` to mark all expired sessions as `EXPIRED`
- [x] 2.2 Rewrite `_remove_expired_sessions`: Pass 2 — batched loop collecting session IDs, deleting files via `_remove_dir_async`, bulk `DELETE ... WHERE id IN (...)`, `await db.commit()` per batch
- [x] 2.3 Remove the `select(Resource)` + per-resource `db.delete(resource)` loop entirely

## 3. Cleanup Service — Aggressive Cleanup

- [x] 3.1 Rewrite `_aggressive_cleanup` pass 1: remove `delete(Resource).where(...)` calls, use `_dir_size_async` and `_remove_dir_async`, bulk `DELETE ... WHERE id IN (...)`
- [x] 3.2 Rewrite `_aggressive_cleanup` pass 2: same — remove redundant resource deletion, use async helpers, bulk DELETE per session

## 4. Cleanup Service — Other Methods

- [x] 4.1 Wrap `os.path.exists` / `os.remove` in `_mark_assembling_sessions_failed` with `asyncio.to_thread`
- [x] 4.2 Wrap `os.path.exists` / `os.remove` in `_mark_stale_assembling_sessions_failed` with `asyncio.to_thread`
- [x] 4.3 Rewrite `_cleanup_orphaned_directories`: wrap `os.path.exists`, `os.listdir`, `os.path.isdir` in `asyncio.to_thread`, use `_remove_dir_async` for deletion

## 5. API Delete Endpoint

- [x] 5.1 Add `delete` to `sqlalchemy` import in `sessions.py`
- [x] 5.2 Rewrite `delete_session`: remove `select(Resource)` + loop, replace with `delete(Session).where(Session.id == session_id)`, wrap `shutil.rmtree` in `asyncio.to_thread`
