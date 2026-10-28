## Context

The Website Downloader server (`server/`) assembles downloaded pages into ZIP/single-file artifacts after the extension uploads HTML chunks and resources. A 2026-10 multi-agent audit verified 14 defects in this pipeline. All line references below were re-verified against the current source.

**The honesty chain.** `_assemble_zip` skips resources whose file is missing from disk (`zip_assembler.py:719-726`), whose `local_path` is empty (`:701-706`), or whose `zf.write` raises (`:728-734`) — each with only a log warning — and then marks the session `ready` (`:586-591`). Markdown/link-page conversion failures are similarly isolated (`:294-312`). Finalize knows the discovered-vs-received deficit (`sessions.py:802-822`) and deliberately treats it as visibility-only: "the deficit never blocks or alters the 202 outcome" (`sessions.py:875-890`; codified in `test_finalize_resource_integrity.py:9-11`). The client therefore has **no API surface** telling it an archive is incomplete.

**The durability gap.** `get_db()` commits in dependency teardown (`database.py:32-42`); since FastAPI ≥0.106 that runs after the response is sent. `create_session` (`sessions.py:365`), `scrape_complete` (`:659`), and `finalize` (`:873`) commit explicitly before returning — the team documented why for scrape-complete (`:655-659`) — but the upload routes do not: `resources.py:401-403` and `html.py:199-200` only `flush()`; `upload_filename_map` flushes at `sessions.py:503`. `upload_content` (`sessions.py:674-712`) writes a file and performs no DB mutation. A commit failure after the 200 (pool exhaustion, deadlock, MySQL restart) means the client counted success while the row + `total_size` accounting rolled back — which then _creates_ the discovered/received deficits finding D1 reports.

**The race.** `upload_resource` checks `SCRAPING/UPLOADING` (`resources.py:169-179`) but inserts and commits later (`:389-403` + teardown). Finalize transitions to `ASSEMBLING` with a guarded `UPDATE ... WHERE status='uploading'` (`sessions.py:824-873`), and the assembler snapshots resources at pipeline start (`zip_assembler.py:189` → `:1427-1434`). An upload in flight across that transition commits after the snapshot: its blob lands on disk with a DB row (no orphan) but the archive was assembled without it — silently.

**The limiter family.** `register()` consumes the per-IP limiter (`auth.py:77`) and the per-instance limiter (`:95-109`) **before** the instance-id dedup lookup (`:112-120`), so a returning instance resolving via `existing` still spends budget. The instance limiter is 10/day with refill spread over 24h (`rate_limiter.py:131-137`, `config.py:75`), so a 429 computes `Retry-After ≈ 8640 s` (2.4 h). The extension's `register()` retries `MAX_REGISTRATION_ATTEMPTS = 3` (`server-client.ts:368`) with 1 s/2 s backoff and ignores `Retry-After` (`:1031-1060`) — a single 429 becomes a hard failure that persists for hours. Per-IP keys use the peer address unless `TRUST_PROXY` is on (`auth.py:40-58`; default off, `config.py:78`); production binds `127.0.0.1:8000` behind nginx (`docker-compose.yml:11`) and the runbook marks `TRUST_PROXY=true` REQUIRED, but the env is not in the repo — if it is not effectively set, every registrant shares one bucket. Separately, `RateLimiter.is_allowed` (`rate_limiter.py:85`) and `cleanup_if_needed` (`:101`) both do `self._call_count += 1`, so the 100-call cleanup interval fires every ~50 calls.

**Bounds.** `upload_content` appends `body.text` to disk with no cap and never counts against `max_session_size_mb` (`sessions.py:699-705`); `upload_filename_map` merges an unbounded dict into a JSON column (`sessions.py:500`). Contrast: HTML chunks are capped (`html.py:92-132`). Resources have a byte quota but no count cap (`resources.py:183-213,296-309,344-360`); `cloud_max_assets=200` (`config.py:59`) is cloud-push-only. The container runs 2 GB with `oom_kill_disable: true` and a single uvicorn worker (`docker-compose.yml:34,56-60`), so one oversized body can OOM the whole service. The Content-Length pre-check (`resources.py:190-214`) measures the whole multipart body (boundaries, form fields) against the quota, 413-ing legitimate uploads near the limit.

**Chunk overwrite.** Chunk dedup requires matching `content_hash` (`html.py:143-151`), so a same-`(page_url_hash, scroll_index)` chunk with NEW content passes dedup, then `storage_path = f"{body.scrollIndex}.html"` (`:182-186`) overwrites the previous file while a second DB row referencing the same path is inserted (`:188-200`). The merger registers both registrations (`:222-234` → `html_merger.py:233-240` appends the path again), duplicating the chunk in the merged HTML and double-counting `total_size`.

**Leaks and stalls.** `_jobs` (`html_merger.py:136`) is populated per chunk upload (`:145-170`) and drained only by `merge_session` (`:269`) / `merge_linked_pages` (`:867`); `cleanup.py` never touches the merger, so sessions that upload chunks but never finalize leak jobs (holding chunk paths and sizes) forever. `aiofiles` is in `requirements.txt` but never imported: resource writes up to the ~50 MB inflate ceiling are synchronous (`resources.py:327-329,336-341`), as are chunk writes (`html.py:184-186`) and the content append (`sessions.py:703-705`) — stalling the single event loop that serves every `/status` poll. The written resource file is cleaned up only on the 413/dedup/IntegrityError paths (`resources.py:349,371,410-412`); any other flush error leaks the file (dir-level cleanup eventually reclaims it). And both assembly `asyncio.gather` fan-outs run bare (`zip_assembler.py:360-363,389`): on the first sibling exception the mainline `except` (`:598-614`) opens a _second_ session to `_mark_failed` while abandoned siblings may still flush the shared session through `db_flush_lock` (`:134`, `:1471-1476`), and their exceptions are never retrieved ("Task exception was never retrieved").

## Goals / Non-Goals

**Goals:**

- Make partial archives **honest without making them invalid**: missing/failed resource counts are persisted and surfaced everywhere the client already looks (`/status`, finalize payload, archive record).
- Make uploads **durable before success**: no commit failure can occur after a 200.
- Make upload-vs-finalize races **deterministic**: no false 409 for a counted resource, no orphan blobs, late arrivals accounted.
- Make registration rate limiting **survivable**: dedup'd registrations are free, `Retry-After` is sane, the client honors it.
- Close the bounds/hygiene defects (body caps, count cap, quota accuracy, chunk replace, job eviction, async I/O, file cleanup, gather isolation, counter fix).
- All response changes additive; no DB migration; no breaking API changes.

**Non-Goals:**

- Failing assembly (or finalize) because resources are missing — partial downloads remain a feature.
- Redis-backed/multi-process rate limiting (single-server deployment; in-memory is the documented trade-off).
- Migrating integrity counters to dedicated DB columns (options-JSON pattern suffices; revisit if aggregate querying is ever needed).
- Changing cloud-push (`cloud_max_assets`) semantics or the finalize guarded-transition mechanism itself.
- Extension UI changes beyond the `register()` retry discipline (surfacing `archive_warning` in the extension UI is a follow-up).

## Decisions

### D1 — Honest partial assembly: partial stays valid, always reported with missing/failed counts

Keep the skip-and-continue assembly behavior (partials are valid artifacts; finalize semantics unchanged), and add **integrity accounting**:

- Persist an `integrity` object on the session options JSON — the established no-migration pattern for exactly this kind of counter (`sessions.py:649-652` stashes `resourcesFailed` the same way). Fields: `discovered_deficit` (finalize: `resources_discovered - resources_received`, clamped ≥ 0), `capture_failed` (from scrape-complete `resourcesFailed`), `assembly_missing` (missing file / empty `local_path` skips), `assembly_failed` (`zf.write` failures + late-arrival count per D3), `archive_warning` (human-readable summary string).
- `/status` (`SessionStatusResponse`) gains `resources_missing`, `resources_failed` (nullable ints, `null` until finalize) and `archive_warning`; finalize's `FinalizeResponse` gains the finalize-known counts (`resources_discovered`, `resources_received`, `resources_missing`, `resources_failed`).
- Marking the session `ready` does not clear counts; a complete session reports `0/0` and no warning.
- _Why options JSON:_ zero migration, single-row reads are already what `/status` does, and the counts never need aggregate queries. _Alternatives:_ dedicated columns (migration cost, no querying benefit at this access pattern); failing assembly (rejected — changes product semantics).

### D2 — Commit-before-respond

All upload routes that mutate session state — `upload_resource` (`resources.py`), `upload_html_chunk` (`html.py`), `upload_filename_map` (`sessions.py`) — explicitly `await db.commit()` before constructing the success response, mirroring `create_session`/`scrape_complete`/`finalize`. On commit failure: rollback, remove any file written during the request, re-raise → the client gets a 5xx instead of a false 200, and no orphan row/file remains. `get_db()`'s teardown commit stays as a safety net for future routes. `upload_content` performs no DB mutation (its synchronous file write already precedes the response) and is only touched for D7/D10. _Why:_ the scrape-complete comment (`sessions.py:655-659`) already documents this exact class of race for the team; uploads are strictly more critical because clients count the 200 toward `resources_discovered`.

### D3 — Upload-vs-finalize race closure: accept-and-account late arrivals deterministically

- Keep the request-time status pre-check 409 (`resources.py:169-179`) — a request that _observes_ `assembling/ready` is rejected as today.
- An upload that passed the pre-check is **never** rejected mid-flight: it inserts and (per D2) commits unconditionally. This preserves the invariant that a resource the client counted as uploaded is stored — no false 409.
- Archive membership stays defined by the assembler's start-of-pipeline snapshot (`zip_assembler.py:189`). At completion the assembler compares snapshot count to a fresh live count; the difference is recorded in `integrity.assembly_missing` (late arrivals are in `/status` totals but not in the artifact) and folded into `archive_warning`.
- Because D2 guarantees row+file commit before the 200, and the finalize guarded transition (`sessions.py:824-873`) remains the single assembly trigger, every late arrival has a row and a file — **no orphan blobs, no silent drops**, and the client's accounting always reconciles with `/status`.
- _Alternatives considered:_ re-checking status at commit time inside the insert transaction (produces the false-409 the client cannot handle — rejected); blocking finalize until in-flight uploads drain (requires distributed drain tracking — overkill for a single-worker server).

### D4 — Same-index chunk conflict: replace atomically

A chunk with the same `(page_url_hash, scroll_index)` but a different `content_hash` **replaces** the superseded chunk:

- The new file is written to a temp name and `os.replace()`d over `{scrollIndex}.html` (atomic, no window with a missing file).
- The superseded `HtmlChunk` row is deleted in the same transaction that inserts the replacement; `html_chunks` counter is not incremented; size accounting nets the delta (merger `total_size` adjusted by ±size).
- The in-memory merger job updates its registration for that scroll index (dedup key replaced, chunk path list deduplicated by scroll index), so merged HTML never contains the chunk twice.
- _Why replace over 409:_ the extension legitimately re-captures the same scroll position with updated DOM (scroll-back, dynamic content); rejecting would poison otherwise-valid sessions, and silently keeping the first copy (today's overwrite) corrupts the archive. Replace is the only policy consistent with both.

### D5 — Register limiter: dedup'd registrations don't consume budget

Reorder `register()`: perform the instance-id dedup lookup **before** consuming the per-instance limiter; a dedup hit returns the existing key without consuming instance budget. The per-IP limiter still consumes per request (5/min — a returning instance re-registering on service-worker restarts stays orders of magnitude under it, and it retains the abuse bound for random-id miss floods). Fresh registrations consume both budgets as today. Additionally, emitted `Retry-After` on both registration 429 sites is capped at `registration_retry_after_max_seconds` (default 300 s) — an honest value for the instance limiter is hours, which is useless operationally; a capped hint plus client honoring (D6-era client fix) turns a hard failure into a delayed success. _Why not "separate cheap path":_ the lookup-first ordering _is_ the cheap path — one indexed SELECT — and keeps a single limiter code path.

### D6 — Shared-IP collapse: verify, test, and fail loudly

- Pin `get_client_ip` behavior with tests: peer address when `TRUST_PROXY` off; rightmost `X-Forwarded-For` entry when on; peer fallback when the header is absent/malformed.
- Add a loud, rate-limited (once per N minutes) WARNING when `TRUST_PROXY` is disabled but requests arrive carrying `X-Forwarded-For` — the signature of proxy-in-front-but-untrusted, i.e. every registrant sharing the proxy's 5/min bucket.
- Document in `scripts/prod/README.md` that `TRUST_PROXY` is required not only for `download_url` but for per-IP registration limiting behind nginx.
- No startup fail-fast: inside the container the loopback bind is not observable (`docker-compose.yml:11` maps it at the host level), so a runtime signal is the honest detector.

### D7 — Bounded request bodies and resource counts

New settings: `max_content_text_mb` (default 5), `max_filename_map_bytes` (default 2 MB) with `max_filename_map_entries` (default 20 000), `max_resources_per_session` (default 10 000 — generous above `cloud_max_assets=200`, which stays cloud-only). `upload_content` rejects oversized text with 413 and counts accepted content against `max_session_size_mb` (existing quota semantics, `session_size_exceeded`); `upload_filename_map` rejects oversized maps with 413; `upload_resource` checks the live resource count before writing and rejects with 413 `resources_count_exceeded` (dedup'd re-uploads don't count). _Why:_ unbounded bodies against a 2 GB `oom_kill_disable` single-worker container are a one-request OOM; millions of tiny rows within the 1 GB byte budget bloat MySQL and make the 3-aggregate `/status` poll (`sessions.py:441-449`) and finalize linearly slower.

### D8 — Gather fan-out isolation

Both fan-outs (`zip_assembler.py:360-363` linked pages, `:389` CSS) switch to `asyncio.gather(..., return_exceptions=True)`. After the gather: collect and log each sibling exception; if any sibling failed, marshal the first into the existing mainline failure path. `return_exceptions=True` guarantees all siblings have finished before the mainline continues, so nothing can flush the shared session (`db_flush_lock`, `:134`) after failure handling begins; `_mark_failed` keeps using a fresh session (`:603-614` pattern). No exception is left unretrieved.

### D9 — Memory hygiene: AssemblyJob eviction and limiter counter

- `AssemblyJob` gains a `last_activity` timestamp updated by `get_or_create_job`/`register_chunk`; `HtmlMergerService.evict_stale_jobs(max_age)` removes jobs idle beyond `stale_session_timeout_minutes` (reusing the existing config, `config.py:23`); `cleanup.py`'s periodic sweep calls it. Sessions that upload chunks but never finalize stop leaking jobs (their disk chunks are already reclaimed by expiry cleanup).
- Remove the double `self._call_count += 1` (`rate_limiter.py:85,101`): the counter increments exactly once per `is_allowed()`, restoring the intended ~100-call cleanup cadence.

### D10 — I/O and failure-path hygiene

- Replace synchronous file writes in request handlers with `aiofiles` (already a dependency): resource writes (`resources.py:327-329,336-341`), chunk writes (`html.py:184-186`), content append (`sessions.py:703-705`). `zip_assembler`'s CSS rewrite writes move to `asyncio.to_thread` alongside the existing conversion call. This stops multi-hundred-ms disk stalls from delaying every concurrent `/status` poll on the single worker.
- Resource file cleanup moves to `try/finally` in `upload_resource`: any failure after the file is created (non-IntegrityError flush, commit failure per D2) removes the written file.
- Quota measurement uses the **decoded blob byte count**: the whole-multipart Content-Length pre-check (`resources.py:190-214`) is removed; the non-gzip streaming loop enforces the remaining session budget mid-stream on bytes actually written (abort + cleanup + 413), and the existing post-write check remains authoritative. Legitimate near-limit uploads are no longer rejected for multipart envelope overhead, while gross oversize is bounded without buffering.

### D11 — Client honors Retry-After on register

`register()` (`server-client.ts:1031-1060`): on 429 with a `Retry-After` header, wait `min(retryAfter, 60)` seconds before the next attempt (client-side cap so a hostile/buggy header can't hang the worker); the wait does not consume an attempt beyond the running loop, and remaining attempts still apply. Non-429 failures keep the existing 1 s/2 s backoff. _Why 60 s cap:_ the server caps its own hint at 300 s (D5); the client additionally bounds it to keep registration responsive inside a service-worker lifetime — with D5 in place the 429 itself becomes rare.

## Risks / Trade-offs

- [Integrity counts in options JSON can drift from live aggregates] → counts are written only by finalize/assembly (single writer after the guarded transition), and `/status` keeps its live aggregates authoritative for in-flight numbers; counts are strictly the archive-honesty view.
- [Capped Retry-After makes clients retry into more 429s] → acceptable: dedup'd registrations no longer consume budget (D5), so legitimate clients rarely 429; abusers retrying every 300 s cost one indexed SELECT.
- [Replace-on-same-index changes observable chunk ids] → superseded rows are deleted, so `/status` chunk counts stay correct; clients never key on chunk ids (they key on scrollIndex).
- [`return_exceptions=True` masks which sibling failed first] → each sibling exception is logged with its resource/page identity; the session error message carries the first failure — strictly better than today's unretrieved-exception silence.
- [Mid-stream quota enforcement aborts mid-upload] → the client already treats non-2xx upload responses as retryable-vs-fatal per its upload queue; the alternative (writing the whole file) wastes unbounded disk.

## Migration Plan

1. Server first: every change is backward-compatible (additive response fields, unchanged status codes for existing success paths, no schema change). Old extensions ignore the new fields.
2. Extension second: `Retry-After` honoring degrades gracefully against old servers (header absent → existing backoff).
3. Rollback: revert the deploy; options-JSON `integrity` data is inert without the new readers.
4. Production deploy only on the user's explicit order per `scripts/prod/README.md` and the deploy skill.

## Open Questions

- None blocking. Deferred: dedicated `integrity` columns if aggregate reporting over sessions is ever needed; surfacing `archive_warning` in the extension download UI.
