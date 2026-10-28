## 1. Honest partial-assembly accounting (D1)

- [x] 1.1 `server/app/services/zip_assembler.py` — in `_assemble_zip` (and the images-only path), count the three silent skip classes into an accumulator instead of bare `continue`/warning: missing file on disk (`:719-726`), empty `local_path`/blank sanitized path (`:701-716`), `zf.write` failure (`:728-734`); never fail assembly for them
- [x] 1.2 `server/app/services/zip_assembler.py` — persist an `integrity` object on the session options JSON when marking `ready` (`:586-591`) with `assembly_missing`, `assembly_failed`, and an `archive_warning` summary string; keep counts when the session was already touched by finalize accounting (merge, don't overwrite)
- [x] 1.3 `server/app/api/routes/sessions.py` — in `finalize_session`, persist finalize-known counts into the same `integrity` object at the guarded transition: `discovered_deficit = max(0, resources_discovered - resource_count)` and `capture_failed` from the stashed `resourcesFailed`
- [x] 1.4 `server/app/api/routes/sessions.py` — extend `SessionStatusResponse` and `get_session_status` with `resources_missing`, `resources_failed` (nullable ints; `null` before finalize) and `archive_warning` (nullable string, set whenever either total is non-zero), sourced from the stored `integrity` object
- [x] 1.5 `server/app/api/routes/sessions.py` — extend `FinalizeResponse` with finalize-known `resources_discovered`, `resources_received`, `resources_missing`, `resources_failed`; the 202 semantics are unchanged (deficit never blocks)
- [x] 1.6 Verify cloud-push branch reports too: cloud-only assembly marks `ready` with `zip_path=None` — record the same integrity totals there (assets skipped / `CloudPayloadTooLargeError` paths already set `cloud_error`; add the missing/failed counts without changing `cloud_status` semantics)

## 2. Durable uploads — commit before the 200 (D2)

- [x] 2.1 `server/app/api/routes/resources.py` — replace the flush-only pattern (`:401-403`) with explicit `await db.commit()` before building the success response; on commit failure: rollback, remove the written file (`storage_path`), re-raise → 5xx, no orphan row/file
- [x] 2.2 `server/app/api/routes/html.py` — explicit `await db.commit()` before the response in `upload_html_chunk` (after the counter update and merger registration at `:199-242`); same rollback discipline (chunk file removal on failure)
- [x] 2.3 `server/app/api/routes/sessions.py` — explicit `await db.commit()` in `upload_filename_map` before the response (`:503-513`)
- [x] 2.4 Confirm `upload_content` needs no commit (no DB mutation; file write precedes response) and leave a comment documenting why it is exempt from D2

## 3. Upload-vs-finalize race closure (D3)

- [x] 3.1 `server/app/api/routes/resources.py` — keep the request-time status pre-check 409 (`:169-179`); ensure the insert+commit path never re-checks status (no mid-flight 409 for an upload that passed the pre-check)
- [x] 3.2 `server/app/services/zip_assembler.py` — after the ZIP/cloud asset build, compare the pipeline's resource snapshot count (`:189`) against a fresh live COUNT; record the delta as late arrivals in `integrity.assembly_missing` and fold into `archive_warning`
- [x] 3.3 Assert the no-orphan invariant: with D2 in place a 200 implies a committed row+file, so a late arrival is always stored and accounted — add a comment block in `resources.py` documenting the accept-and-account contract with `finalize`'s guarded transition

## 4. Registration limiter and Retry-After (D5)

- [x] 4.1 `server/app/api/routes/auth.py` — reorder `register()`: instance-id dedup lookup (`:112-120`) BEFORE the per-instance limiter check; dedup hit returns the existing key consuming no instance budget; fresh registrations consume both budgets as today; keep the per-IP limiter consuming per request
- [x] 4.2 `server/app/config.py` — add `registration_retry_after_max_seconds: int = 300`
- [x] 4.3 `server/app/api/routes/auth.py` — cap the emitted `Retry-After` at `registration_retry_after_max_seconds` in both 429 sites (`:79-87`, `:100-108`)
- [x] 4.4 `server/app/api/rate_limiter.py` — fix the counter double-increment: `cleanup_if_needed` must not increment `self._call_count` (`:85` vs `:101`); cleanup then fires every ~100 `is_allowed()` calls as documented

## 5. Shared-IP limiter guard — TRUST_PROXY (D6)

- [x] 5.1 `server/tests/` — tests for `get_client_ip`: peer address when `trust_proxy` off; rightmost `X-Forwarded-For` entry when on; peer fallback on absent/malformed header (fixture-mock `settings.trust_proxy`)
- [x] 5.2 `server/app/api/routes/auth.py` (or a small middleware/helper) — when `trust_proxy` is disabled and a request carries `X-Forwarded-For`, log a WARNING (rate-limited to once per 5 min) naming the shared-registration-bucket consequence
- [x] 5.3 `scripts/prod/README.md` — extend the `TRUST_PROXY` row: required not only for `download_url` but for per-IP registration limiting behind nginx (shared-bucket collapse otherwise)

## 6. Bounded request bodies and resource-count cap (D7)

- [x] 6.1 `server/app/config.py` — add `max_content_text_mb: int = 5`, `max_filename_map_bytes: int = 2_000_000`, `max_filename_map_entries: int = 20000`, `max_resources_per_session: int = 10000`
- [x] 6.2 `server/app/api/routes/sessions.py` — `upload_content`: reject `body.text` over `max_content_text_mb` with 413 `content_too_large`; count the appended bytes against `max_session_size_mb` (413 `session_size_exceeded`, consistent quota semantics)
- [x] 6.3 `server/app/api/routes/sessions.py` — `upload_filename_map`: reject maps over `max_filename_map_bytes` or `max_filename_map_entries` entries with 413 `filename_map_too_large`
- [x] 6.4 `server/app/api/routes/resources.py` — reject when the live resource COUNT for the session is at `max_resources_per_session` with 413 `resources_count_exceeded`, before any file write; dedup'd re-uploads bypass the check (they don't add rows)

## 7. Same-index HTML chunk conflict — replace atomically (D4)

- [x] 7.1 `server/app/api/routes/html.py` — detect same `(page_url_hash, scroll_index)` with different `content_hash`: replace path — write new content to a temp file and `os.replace()` over `{scrollIndex}.html`; delete the superseded `HtmlChunk` row in the same transaction; do not increment `html_chunks`; return the response with `replaced: true`
- [x] 7.2 `server/app/services/html_merger.py` — add `replace_chunk(job, content_hash, scroll_index, storage_path, size_delta)`: swap the dedup key for that scroll index and net `total_size` by the size delta so merged output never contains the chunk twice
- [x] 7.3 Wire the merger update into the replace path in `html.py` (registration for the new content only; no double registration)

## 8. Memory and job hygiene (D9)

- [x] 8.1 `server/app/services/html_merger.py` — add `last_activity` to `AssemblyJob`, touch it in `get_or_create_job`/`register_chunk`; add `evict_stale_jobs(max_age_seconds) -> int` removing idle jobs
- [x] 8.2 `server/app/services/cleanup.py` — call `html_merger_service.evict_stale_jobs(settings.stale_session_timeout_minutes * 60)` in the periodic sweep (`run_periodic_cleanup`) and log the eviction count
- [x] 8.3 `server/app/services/html_merger.py` — ensure eviction never removes jobs for sessions with a registered active assembly task (cheap guard: skip when `assembly_task_manager` has the session registered)

## 9. I/O and failure-path hygiene (D8, D10)

- [x] 9.1 `server/app/api/routes/resources.py` — switch both write paths to `aiofiles` (gzip decompressed write `:327-329`, non-gzip stream `:336-341`); wrap file-write→commit in `try/finally` so any failure after creation removes the written file (covers the non-IntegrityError flush leak `:404-419`)
- [x] 9.2 `server/app/api/routes/html.py` — `aiofiles` for the chunk write (`:184-186`); `server/app/api/routes/sessions.py` — `aiofiles` for the content append (`:703-705`)
- [x] 9.3 `server/app/services/zip_assembler.py` — move `_convert_css_resource`'s read/rewrite file I/O into the existing `asyncio.to_thread` boundary
- [x] 9.4 `server/app/api/routes/resources.py` — remove the whole-multipart Content-Length quota pre-check (`:190-214`); enforce the remaining session budget mid-stream in the non-gzip loop on bytes actually written (abort + file cleanup + 413); keep the post-write aggregate check as authoritative
- [x] 9.5 `server/app/services/zip_assembler.py` — both `asyncio.gather` fan-outs (`:360-363` linked pages, `:389` CSS) use `return_exceptions=True`; collect + log each sibling exception with its resource/page identity; marshal the first failure into the existing mainline failure path (fresh session `_mark_failed`, `:603-614` pattern); no sibling may touch the shared session after failure handling begins

## 10. Extension — honor Retry-After on register (D11)

- [x] 10.1 `src/background/server-client.ts` — in `register()` (`:1031-1060`): on 429 parse `Retry-After`, wait `min(value, 60)` seconds before the next attempt; the wait does not count as a failed attempt; absent/invalid header keeps the existing 1 s/2 s backoff
- [x] 10.2 `tests/unit/server-client.test.ts` — unit tests: 429+`Retry-After: 5` waits (fake timers) then succeeds on attempt 2; `Retry-After: 9999` clamped to 60; 429 without header falls back to exponential backoff; attempts still bounded at `MAX_REGISTRATION_ATTEMPTS`

## 11. Tests (pytest, `server/tests/`)

- [x] 11.1 Partial assembly honesty: session with a resource whose file is missing from disk (and one whose `zf.write` fails) assembles to `ready`; `/status` reports `resources_missing`/`resources_failed` > 0 with `archive_warning` set; finalize payload carries the discovered/received deficit; complete session reports `0/0` and no warning (new `test_assembly_integrity.py`, extending `test_zip_assembler.py` fixtures)
- [x] 11.2 Commit-before-respond: simulate a commit failure on the upload path (patch `AsyncSession.commit` to raise once) → the route returns 5xx (not 200), no resource row and no file remain, and `total_size` accounting is unchanged; happy-path upload commits before the response (row visible to a fresh session) — extend `test_resource_upload.py`
- [x] 11.3 Late upload after finalize per D3: upload passes the pre-check, finalize's guarded transition commits, upload then commits → 200 (never 409), row+file present, assembler snapshot delta lands in `integrity.assembly_missing` and `archive_warning` — extend `test_finalize_race.py`
- [x] 11.4 Dedup registration consumes no limiter budget: 15 consecutive registrations of an already-registered instance id all return 201/200 with the same key and the instance limiter bucket is untouched; a fresh id still consumes; `Retry-After` on a 429 is ≤ `registration_retry_after_max_seconds` — extend `test_auth_security.py` / `test_rate_limiter.py`
- [x] 11.5 Body caps return 413: content text over `max_content_text_mb` and counting against `max_session_size_mb`; filename map over bytes/entries; resource count at `max_resources_per_session`; near-limit non-gzip upload whose multipart envelope would have breached the old Content-Length pre-check now succeeds — extend `test_session_lifecycle.py`, `test_resource_upload.py`
- [x] 11.6 Same-index-different-content per D4: upload chunk (index N), upload different content at index N → single row, single file with new content, `html_chunks` counter unchanged, merged HTML contains the chunk once, `total_size` nets the delta — extend `test_html_merger.py`
- [x] 11.7 Stale `AssemblyJob` eviction: jobs idle beyond the age are removed by `evict_stale_jobs` and by the periodic sweep; jobs for sessions with an active assembly task survive — extend `test_html_merger.py` + cleanup test
- [x] 11.8 Gather sibling isolation: one CSS sibling (and one linked-page sibling) raising during assembly → session fails via the fresh-session path, remaining siblings complete and their exceptions are logged (no "never retrieved"), shared session untouched after failure — extend `test_zip_assembler.py`
- [x] 11.9 Limiter counter: `is_allowed` increments the call counter exactly once; cleanup fires at the documented ~100-call cadence — extend `test_rate_limiter.py`
- [x] 11.10 Full suite green: `cd server && python -m pytest` (all existing suites included)

## 12. Validation and docs

- [x] 12.1 Update `scripts/prod/README.md` TRUST_PROXY documentation (task 5.3) and verify the production env checklist calls it out for the registration limiter
- [x] 12.2 `openspec validate server-assembly-honesty --strict` passes from the repo root
