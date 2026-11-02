## Context

Six defects were deferred from the Oct 2026 audit batch. Verified against HEAD on 2026-11-02 (baselines: server pytest 680 passed, extension 67 files / 967 tests, `tsc --noEmit` clean):

- **Stop hides the partial archive.** On stop the background emits `status.serverDownloadReady` (with the salvage-probe download URL) followed by `status.cancelled` (`src/background/download-core.ts:1174-1183`, `:1459-1467`, `:1637-1645`). `applyServerModeMessage` (`src/sidepanel/server-mode-state.ts:170-176`) stores the URL but never changes `phase`; `status.cancelled` hits the `default` arm. `DownloadStatus.tsx:426-431` renders the "Download from server" card only when `phase === "ready"`, so a stopped run's URL is stored but never shown — violating the live requirement in `download-lifecycle-reliability` ("Stop never reports success with partial data", scenario "Partial archive is surfaced when the server already produced it").
- **`archive_warning` is dropped client-side.** The server sends `resources_missing`, `resources_failed`, `archive_warning` in `/status` (`server/app/api/routes/sessions.py:611-649`) and the finalize payload (`zip_assembler.py:1841`), but the extension's `SessionStatusResponse` (`src/background/server-client.ts:269-305`) declares none of them, and no UI consumes them. The `server-assembly-honesty` design explicitly deferred this ("surfacing `archive_warning` in the extension UI is a follow-up").
- **Index-0 replace corrupts the merge.** The first chunk of a page becomes the skeleton (`html_merger.py:224-250`) and is never registered in `job.chunks`. A later different-content upload at scroll index 0 takes the replace path (`html.py:294-301`), and `replace_chunk` (`html_merger.py:283-316`) appends `0.html` to `job.chunks` (`path_present` is False) while the skeleton file keeps the old content — merged output contains the first scroll twice (old as skeleton, new as appended chunk). This also bites after in-memory job eviction: `_load_jobs_from_disk` excludes the skeleton-source chunk from the chunk list (the documented restart-recovery behavior), so a post-eviction index-0 replace re-adds it via `replace_chunk`.
- **Replace uploads are over-charged.** The session-size pre-check (`html.py:142-163`) computes `current_total` = SUM(resources) + SUM(html_chunks) — still including the chunk about to be superseded — and adds the full new chunk size. The superseded-row delete happens later in the same transaction (`html.py:242-246`), and the conflict query runs _after_ the quota check (`html.py:202-209`), so the superseded bytes are counted twice. Near `MAX_SESSION_SIZE_MB`, legitimate replaces are falsely rejected with 413 `session_size_exceeded`.
- **Bare-text chunks vanish.** `_dom_merge` (`html_merger.py:489-581`) combines chunk bodies into `<html><body>{bodies}</body></html>` and parses with lxml; bare text becomes `chunk_body.text`, and only child _elements_ are appended to the skeleton (line 565). A text-only chunk yields an empty children list: the superset check needs both lists non-empty (line 544), so it is skipped and the append loop no-ops — the text is silently dropped. `_extract_body_content` (line 1124) does return bare text, so the loss happens purely in the DOM-append step.
- **Dead `isPushForPanel`.** `src/sidepanel/utils/tabFilter.ts:24` has no production importer — only `tests/unit/push-tab-filter.test.ts:12` imports it; the identity-routing rework (`3b13d47`, live `user-interface` spec) replaced it with `downloadRouting.ts`. Remaining references are stale comments (`useScrapingDownloader.ts:381,691`) and a self-contained `isPushForPanelOld` helper in `download-routing.test.ts` (local, no import).

## Goals / Non-Goals

**Goals:**

- Surface the server-produced partial-archive URL on stopped downloads, with cancelled (never complete) wording.
- Surface the server's `archive_warning` on terminal download states.
- Regenerate the merger skeleton when the skeleton-source chunk is replaced; keep non-zero same-index replacement behavior as shipped (D4 swap).
- Charge replace-mode HTML chunk uploads their net growth in the session-size pre-check.
- Preserve bare-text chunk bodies in DOM-merged output.
- Remove `isPushForPanel` and its test.

**Non-Goals:**

- No server `/status` schema changes — the extension consumes existing fields.
- No changes to resources upload quota (resources have no replace mode; URL-hash dedup short-circuits first).
- No changes to stop/finalize _background_ semantics — `download-lifecycle-reliability` already specifies them; this change is the panel render side.
- No new localization infrastructure beyond the required strings.

## Decisions

### D1: Terminal `cancelled` phase drives the partial-archive card (defect 2)

Add `"cancelled"` to the `ServerModeState.phase` union. `applyServerModeMessage` handles `status.cancelled` → `phase: "cancelled"` (URL and other fields carried over from `prev`). `DownloadStatus` gains a stopped-with-archive branch — rendered when `phase === "cancelled" && serverDownloadUrl` — showing localized "download stopped — partial archive available" wording (amber/slate card, _not_ the green complete card) with the same `onDownloadFromServer` action, plus a stopped-without-archive branch is NOT needed: `applyDownloadCancelledState` already resets the panel messages, and `serverModeState` surviving with a non-terminal phase is the current bug being fixed.

_Why not gate the card on `serverDownloadUrl != null` alone:_ `status.serverDownloadReady` also arrives mid-run as a self-healing affordance (`download-core.ts:366`), so a stale URL can exist while the run is still live; a terminal phase gate prevents a "download from server" card during active uploads. _Alternative rejected:_ reusing `phase: "ready"` for stopped runs — it would render the green "complete" card and violate the stop contract (terminal status never reads as success).

### D2: Plumb integrity fields through the existing additive-options pattern (defects 2+5 design)

`SessionStatusResponse` gains `resources_missing`, `resources_failed`, `archive_warning` as optional nullable fields (the established undefined-safe pattern, e.g. `assembly_elapsed_seconds`). The background attaches `archiveWarning` to the `status.complete` options and to `status.serverDownloadReady` options (the salvage probe already reads `/status`). `ServerModeState` gains `archiveWarning: string | null`; `applyServerModeMessage` stores it additively — absent option keeps `prev` (same pattern as `failedUploads`, D3 of `download-ux-feedback`). `DownloadStatus` renders a warning block (localized heading + the server's message string as data) on the ready card and on the stopped-with-archive card; clean sessions (`archive_warning` null) render unchanged. The server message is server-authored English shown as payload data, consistent with how `error_message` is displayed today.

### D3: Route skeleton-source replacement to skeleton regeneration (defect 3)

In `upload_html_chunk`, when `replace_mode` and the job is initialized and `body.scrollIndex` equals the job's skeleton-source index, call `initialize_skeleton(job, body.html)` instead of `replace_chunk`: the skeleton file is rewritten from the new content, any stale registration/path for that index is removed from `job.chunks`/dedup keys, and `job.total_size` is recomputed as new-skeleton-size + registered chunk sizes. To make that exact, the job records its skeleton-source scroll index at `initialize_skeleton` (per the extension protocol it is always 0, but recording it avoids assuming) and per-chunk sizes (extend the job with a path→size map; `register_chunk` already receives `size`). The route-level routing fixes both the fresh-job and post-eviction paths because `initialize_skeleton` rewrites the file regardless of job provenance. DB-side behavior is already correct for index-0 replace (rows swapped, counter not incremented, atomic file swap) — no route changes beyond the routing branch. _Alternative rejected:_ teaching `replace_chunk` to detect index 0 and rewrite the skeleton internally — hides a skeleton-level operation inside a chunk-registration API and still needs the route to skip the chunk-list append.

### D4: Credit superseded size before the quota pre-check (defect 4)

Move the same-index conflict query above the session-size pre-check in `upload_html_chunk`. In replace mode compute `post_replace_total = current_total − Σ(superseded.size) + chunk_size` and compare that against the limit; the 413 body keeps `current_size` as the true pre-state total and reports the net growth as `upload_size`. Exact retransmissions still short-circuit via the dedup branch (no charge) — unchanged. Transaction semantics are untouched: detection, delete, and insert remain in the same transaction; only the pre-check arithmetic and ordering change. This strictly _loosens_ a false rejection (net charge ≤ full charge), so no new over-admission is introduced beyond the pre-existing aggregate TOCTOU race that the deadlock-avoidance design already accepts.

### D5: Carry chunk body text through the DOM append (defect 6)

Keep the string-combine + single-parse structure, and transfer bare text alongside elements: when the combined chunk tree's body has leading text (`.text`) or children with tails, append elements as today and place the text at the insertion position (end of body content) — i.e., append to the tail of the skeleton body's last child (or `skeleton_body.text` when the skeleton body has no children), matching the string-based `_insert_chunks_before_body_end` semantics that the DOM path is a port of. The full-body subset check keeps comparing raw strings, so bare text already present in the skeleton still deduplicates without duplication. _Alternative rejected:_ routing every text-bearing chunk through `_insert_chunks_before_body_end` — mixes two merge strategies per job and loses the element-tracking threshold logic for mixed chunks.

### D6: Dead-code removal is tasks-only (defect 1)

No requirement changes — delete `src/sidepanel/utils/tabFilter.ts`, `tests/unit/push-tab-filter.test.ts`, and the stale comments; keep `download-routing.test.ts`'s self-contained old-behavior helper (it documents the routing contract and does not import the module). Verified by `tsc --noEmit` + vitest green with zero references left.

### D7: Test strategy and bite-proofing

Server defects (3, 4, 6) get pytest regressions in `server/tests/` using the existing real-SQLite fixtures: index-0 replace merge output (fresh + post-eviction job), quota pre-check near the limit (falsely-rejected-at-HEAD case admitted post-fix; oversized replace still 413), and `_dom_merge` text preservation (text-only chunk; mixed text+elements; text already in skeleton not duplicated). Extension defects (2, 5) get vitest unit tests for `applyServerModeMessage` (`status.cancelled` transition; additive `archiveWarning`) and `SessionStatusResponse` parsing, following `tests/unit/` conventions. Vitest 4 gotchas apply: unhandled-rejection tests use plain functions (not `vi.fn`); `AbortSignal.timeout` ignores fake timers. Every behavioral test is bite-proofed: fix applied in a worktree at HEAD first, tests run and recorded failing pre-fix, then the fix lands and tests pass.

## Risks / Trade-offs

- [Skeleton regeneration could disturb the restart-recovery "first chunk consumed" behavior] → The fix only reroutes the `replace_mode` branch; `_load_jobs_from_disk`'s first-chunk exclusion is untouched, and the pytest covers both fresh-job and reloaded-job replace flows.
- [Recording skeleton-source index + per-chunk sizes grows job state] → In-memory only, bounded by chunks per page, evicted by the existing D9 stale-job eviction; no persistence changes.
- [`cancelled` phase could be overwritten by late replayed messages] → Terminal messages are already routed through the tracked-download identity filter (`downloadRouting.ts` terminal set); `applyServerModeMessage` transitions remain idempotent and unit-tested.
- [Localized heading wrapping an English server string] → The warning text is data from the server, displayed as-is inside a localized label — same treatment as `error_message`; full translation of server strings is out of scope.
- [Quota net-charge changes 413 payload semantics slightly (`upload_size` = net growth in replace mode)] → Additive refinement of an error body; clients only display the numbers; spec scenario updated accordingly.

## Migration Plan

No database migrations; no new API fields. Deploy order is unconstrained: the extension treats the integrity fields as optional, and the server changes are behavior-fixes invisible to old clients. Rollback is a plain revert of the two surfaces (server routes/services, extension panel/client) — no data backfill exists to undo.

## Open Questions

None blocking. Card wording for the stopped-with-archive state is finalized during implementation via the existing i18n key review (all shipped locales per the `localization` spec).
