## Why

A 2026-10 multi-agent audit confirmed a family of server-side defects where the server reports success while data is missing, commits too late, races concurrent clients, or leaks resources. The worst offender: ZIP assembly silently skips missing/unwritable resources (`server/app/services/zip_assembler.py:701-734`), then marks the session `ready` — finalize explicitly never blocks on the discovered-vs-received deficit (`server/app/api/routes/sessions.py:875-890`, codified in `server/tests/test_finalize_resource_integrity.py:9-11`) — so the client polls `/status`, sees `ready`, and downloads an archive that is quietly missing files with no signal of any kind. Alongside it: upload handlers only `flush()` and rely on the `get_db()` teardown commit (`server/app/db/database.py:32-42`), which FastAPI runs **after** the response is sent — a commit failure post-200 means the client counted success while the row and accounting rolled back, feeding the silent-partial problem; an upload racing finalize can commit after the assembler's resource snapshot (orphan blob, missing from ZIP); the registration limiter burns daily budget on dedup'd registrations and emits hours-long `Retry-After` values the extension ignores; and a series of resource-hygiene defects (unbounded request bodies, no resource-count cap, same-index HTML chunk overwrites, leaked in-memory assembly jobs, a limiter counter double-increment, blocking file I/O in async handlers, an over-conservative Content-Length quota check, unretrieved sibling exceptions in the assembly fan-out, and a file leak on late DB errors) round out the family.

## What Changes

**Honest partial assembly (no behavior break):**

- Partial downloads stay valid (they are a feature and finalize semantics do not change), but they become **honest**: the server persists per-session resource-integrity counts (`resources_missing`, `resources_failed`) at finalize and during assembly, exposes them in `/status` and the finalize response payload, and sets an `archive_warning` on the assembled archive record whenever either count is non-zero.
- Assembly fan-out (`asyncio.gather` for CSS and linked-page conversion) collects sibling exceptions instead of abandoning them, and the failure path never touches the shared assembly session after a failure is detected.
- Uploads racing finalize are resolved deterministically: uploads that passed the status pre-check are never rejected mid-flight with 409; resources committing after the assembler's snapshot are stored (never orphaned) and counted in the integrity totals.

**Durability and race closure:**

- All upload routes that mutate session state (resource upload, HTML chunk upload, filename map) commit **before** the success response is sent, matching `create_session` / `scrape_complete` / `finalize`; a simulated post-200 commit failure surfaces as an error response instead of a false success.

**Rate limiting and registration:**

- Returning (dedup'd) registrations no longer consume the per-instance daily limiter budget; emitted `Retry-After` on registration 429s is capped to a sane configurable bound; the extension's `register()` honors `Retry-After` (bounded client-side) instead of burning 3 attempts in ~3 seconds.
- `TRUST_PROXY` behavior for limiter keys is pinned with tests for XFF-derived client keys, and a proxy-present-but-untrusted misconfiguration is logged loudly.
- The limiter's cleanup-scheduling counter no longer double-increments.

**Bounds and hygiene:**

- Content-text and filename-map upload bodies are size-capped (413) and content text counts against the session quota; a per-session resource-count cap (413) bounds DB row bloat.
- The upload quota check uses the actual decoded resource byte count (multipart envelope overhead no longer rejects legitimate near-limit uploads), enforced mid-stream for non-gzip uploads.
- A same-index HTML chunk with different content **replaces** the superseded chunk atomically (row + file + merger job), never duplicating content or double-counting size.
- Stale in-memory `AssemblyJob`s are evicted by the periodic cleanup sweep; synchronous file writes in async handlers move to `aiofiles`/`asyncio.to_thread`; resource files are cleaned up in a `finally` on every failure path.

## Capabilities

### New Capabilities

(none — all requirements changes land in existing component-scoped capabilities)

### Modified Capabilities

- `server-zip-assembly`: honest partial-assembly reporting (missing/failed counts persisted at finalize and assembly, surfaced in `/status`, the finalize payload, and an `archive_warning` on the archive record); deterministic archive membership for uploads racing finalize (accept-and-account, no orphan blobs); parallel conversion failure isolation (`return_exceptions=True`, sibling retrieval, no shared-session mutation after failure).
- `server-resource-guards`: registration limiter semantics (dedup'd registrations consume no instance budget, `Retry-After` capped); proxy-aware client-IP limiter keys with loud TRUST_PROXY misconfig signaling; bounded upload bodies (content text, filename map) and a per-session resource-count cap; accurate decoded-byte quota measurement; rate-limiter self-maintenance (single counter increment).
- `server-session-storage`: durable uploads — session-mutating upload endpoints commit before the success response is sent, and a commit failure cannot masquerade as success (placed here because `server-resource-guards` has no persistence/durability requirement structure; this matches "Session Persistence with MySQL").
- `extension-server-client`: `register()` honors the server's `Retry-After` on 429 (bounded client-side) so a rate-limited registration retries instead of hard-failing within seconds.

## Impact

- **Server (`server/`):** `app/services/zip_assembler.py` (integrity accounting, gather isolation, late-arrival accounting), `app/api/routes/sessions.py` (finalize integrity persistence, `/status` + finalize payload fields, body caps), `app/api/routes/resources.py` (commit-before-respond, count cap, quota measurement, aiofiles, finally-cleanup), `app/api/routes/html.py` (commit-before-respond, same-index replace, aiofiles), `app/api/routes/auth.py` (dedup-before-budget, capped Retry-After), `app/api/rate_limiter.py` (counter fix, Retry-After cap constant), `app/config.py` (new bounds/settings), `app/services/html_merger.py` (chunk replace support, job staleness + eviction), `app/services/cleanup.py` (merger eviction in the sweep), `app/db/database.py` (unchanged teardown commit stays as safety net).
- **Extension:** `src/background/server-client.ts` (register honors `Retry-After`).
- **Tests (`server/tests/`, `tests/unit/`):** new/extended coverage for integrity reporting, commit-before-respond, late-upload handling, dedup limiter budget, body caps, same-index replace, job eviction, gather sibling isolation, Retry-After cap, XFF keys, quota measurement.
- **Docs:** `scripts/prod/README.md` (TRUST_PROXY limiter rationale).
- **No DB migration** — integrity counts persist in the session options JSON, the established no-migration pattern (`resourcesFailed` stash). **No breaking API changes** — all response fields are additive; partial downloads remain valid artifacts.
