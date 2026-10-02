## 1. Database migration

- [x] 1.1 Create Alembic migration: add `size` column (BigInteger, not null, server_default=0) to `html_chunks` table
- [x] 1.2 Add `size` field to `HtmlChunk` SQLAlchemy model (`server/app/models/html_chunk.py`)

## 2. Update size tracking in upload routes

- [x] 2.1 Update `html.py`: store `chunk_size` in the new `HtmlChunk.size` field when creating chunk records
- [x] 2.2 Update `html.py` size-check query: change from `SUM(Resource.size)` to combined `(SUM resources + SUM html_chunks)` using the two-subquery pattern
- [x] 2.3 Update `resources.py` size-check query: change from `SUM(Resource.size)` to combined `(SUM resources + SUM html_chunks)` using the two-subquery pattern
- [x] 2.4 Update `HtmlChunkResponse.total_size` computation in `html.py` to include HTML chunk sizes

## 3. Configuration update

- [x] 3.1 Change default `MAX_SESSION_SIZE_MB` from 500 to 1000 in `server/app/config.py`

## 4. Verification

- [x] 4.1 Run Alembic migration against a test database and verify the `size` column exists
- [x] 4.2 Verify size-check queries return correct totals (resources + HTML) for a test session
