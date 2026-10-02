## Why

The session size limit only counts uploaded resources, ignoring HTML chunk sizes entirely. A session can silently store 500MB of resources plus 500MB of HTML, doubling the intended limit. This is a disk exhaustion risk and causes unpredictable 413 errors for users — the limit triggers based on incomplete data, so downloads fail at arbitrary points.

## What Changes

- Add a `size` column (BigInteger) to the `html_chunks` table to track each chunk's byte size
- Record chunk byte size during HTML upload in `html.py`
- Update both `html.py` and `resources.py` size-check queries to sum across both `resources.size` and `html_chunks.size`
- Update `HtmlChunkResponse.total_size` to include HTML chunk sizes
- Raise the default `MAX_SESSION_SIZE_MB` from 500 to 1000 to accommodate real-world large downloads
- Add an Alembic migration for the new column

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `server-session-storage`: Session size tracking must include HTML chunks, not just resources. The `html_chunks` table gains a `size` column and the size-check queries are updated accordingly.
- `session-size-graceful-degradation`: The 413 threshold now accurately reflects total session usage (resources + HTML), so the graceful degradation triggers at the correct boundary.

## Impact

- **Database**: New Alembic migration adds `size` column to `html_chunks` table. Existing rows get a default of 0 (acceptable — old sessions are already assembled/cleaned).
- **API**: No breaking changes. `HtmlChunkResponse.total_size` now reflects the true total, which is more accurate.
- **Configuration**: Default `MAX_SESSION_SIZE_MB` changes from 500 to 1000. Deployments with explicit env overrides are unaffected.
- **Server routes**: `html.py` and `resources.py` — the session size query changes from a single-table SUM to a two-table SUM.
- **Client**: No changes required. The 413 handling already works correctly via the graceful degradation flow.
