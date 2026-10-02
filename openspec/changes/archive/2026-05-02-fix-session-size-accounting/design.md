## Context

The server enforces a `MAX_SESSION_SIZE_MB` limit per session to prevent disk exhaustion. Currently, both the HTML upload route (`html.py`) and the resource upload route (`resources.py`) check session size by querying only `SUM(Resource.size)`. HTML chunks stored in `html_chunks` have no `size` column and are completely invisible to the limit check. This means a session can silently occupy up to 2x the configured limit.

The current architecture uses aggregate `SUM()` queries rather than maintaining a running `total_size` on the sessions table — this avoids row-level locks that caused MySQL deadlocks with concurrent uploads. This design preserves that approach.

## Goals / Non-Goals

**Goals:**
- Accurately track total session size (resources + HTML chunks) in the size-check queries
- Preserve the deadlock-free aggregate query pattern
- Raise the default limit to 1000MB so real-world large downloads succeed
- Provide a clean database migration path

**Non-Goals:**
- Streaming/chunked assembly or incremental download delivery (out of scope — the current ZIP assembly pipeline works; the problem is the accounting, not the architecture)
- Client-side changes (the graceful degradation flow already handles 413 correctly)
- Changing the session status lifecycle or cleanup logic

## Decisions

### Decision 1: Add `size` column to `html_chunks` model

Add a `size` BigInteger column to the `HtmlChunk` model, matching the existing `Resource.size` column pattern. The value is computed as `len(body.html.encode("utf-8"))` — already calculated in `html.py` as `chunk_size`.

**Alternative considered**: Compute size from disk files on-the-fly via `os.path.getsize()`. Rejected because it adds filesystem I/O to every size check and would be inconsistent with the resource model which stores size in the DB.

### Decision 2: Two-subquery SUM pattern for size checks

Replace the single `SUM(Resource.size)` query with a combined query:
```sql
SELECT
  (SELECT COALESCE(SUM(size), 0) FROM resources WHERE session_id = :id) +
  (SELECT COALESCE(SUM(size), 0) FROM html_chunks WHERE session_id = :id)
```

**Alternative considered**: Maintaining a running total on `sessions.total_size`. Rejected — this was the previous approach and it caused MySQL deadlocks with concurrent uploads. The aggregate pattern is deadlock-free.

**Alternative considered**: Single query with UNION ALL + SUM. The two-subquery approach is equivalent and more readable; MySQL optimizes both the same way.

### Decision 3: Default limit raised from 500MB to 1000MB

The 500MB default was too low for many real-world sites with large images and embedded resources. 1000MB gives headroom while the Docker container's 1GB memory limit provides a natural cap on concurrent processing.

### Decision 4: Alembic migration with server_default=0

Existing `html_chunks` rows get `size=0` via `server_default="0"`. This is acceptable because all pre-existing sessions are already assembled or expired — their sizes are historical and don't affect active limit checks.

## Risks / Trade-offs

- **[Migration on large tables]** If there are millions of existing html_chunks rows, adding a column with a default is an online DDL operation in MySQL 8.0 (instant for most cases). Low risk.
- **[Slightly slower size queries]** Two subqueries instead of one. Mitigated by the existing `ix_html_chunks_session_id` index on `html_chunks.session_id`. The SUM aggregation on indexed column is fast.
- **[413 triggers sooner for some users]** After this fix, sessions that were previously "under the limit" (because HTML wasn't counted) may now trigger 413. Mitigated by raising the default to 1000MB, and the graceful degradation flow ensures users still get partial downloads.
