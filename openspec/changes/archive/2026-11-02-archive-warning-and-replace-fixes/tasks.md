## 1. Bite-proof scaffolding

- [x] 1.1 Create a worktree at HEAD and record baseline-green evidence: server `python3 -m pytest -q` (680 passed), extension `npm test` (67 files / 967 tests), `npx tsc --noEmit` clean
- [x] 1.2 Write the regression tests listed below in the worktree FIRST (server pytest in `server/tests/`, extension vitest in `tests/unit/`) and run them against unmodified HEAD, recording each failure output as bite-proof before any fix lands

## 2. Server merge fixes (defects 3 + 6 — `server-html-merge` delta)

- [x] 2.1 `server/app/services/html_merger.py`: record the skeleton-source scroll index on the job in `initialize_skeleton`, and track per-chunk sizes (path→size map fed by `register_chunk`) so post-replacement `total_size` can be recomputed exactly
- [x] 2.2 `server/app/api/routes/html.py`: in the replace branch, route a replacement whose scroll index equals the job's skeleton-source index to `initialize_skeleton(job, body.html)` (rewrite skeleton from new content, drop any stale registration/dedup entry for that index, recompute `total_size` as new skeleton size + registered chunk sizes); non-source indexes keep the existing `replace_chunk` swap
- [x] 2.3 `server/app/services/html_merger.py` `_dom_merge`: carry chunk body bare text into the merged output at the body insertion position — leading body text (`.text` of the combined chunk tree) and element tails appended to the skeleton body's last child's tail (or `skeleton_body.text` when the body has no children); keep the string-subset dedup path unchanged
- [x] 2.4 pytest (new cases in `server/tests/test_html_merger.py` conventions): skeleton-source replace on a fresh job (new content once, old content absent), skeleton-source replace after in-memory job eviction/reload, non-zero index replace swap, exact retransmission still deduplicated; text-only chunk survives merge, mixed text+elements both survive, bare text already in the skeleton not duplicated — all proven failing at HEAD in task 1.2, passing after 2.1–2.3

## 3. Server quota fix (defect 4 — `server-session-storage` delta)

- [x] 3.1 `server/app/api/routes/html.py`: move the same-index conflict query above the session-size pre-check; in replace mode compare `current_total − Σ(superseded.size) + chunk_size` against the limit, keep `current_size` as the true pre-state total and report the net growth as `upload_size` in the 413 body; exact retransmissions still short-circuit via the dedup branch unchanged
- [x] 3.2 pytest (extend `server/tests/` quota/HTML-chunk fixtures): replacement whose net growth fits near the limit accepted at HEAD-failing (falsely 413 before the fix), replacement exceeding net growth still 413 with accurate body fields, non-replace upload quota behavior unchanged — proven failing/passing per task 1.2

## 4. Extension UI (defects 2 + 5 — `download-ux-feedback` delta)

- [x] 4.1 `src/background/server-client.ts`: add optional nullable `resources_missing`, `resources_failed`, `archive_warning` to `SessionStatusResponse` (undefined-safe pattern like `assembly_elapsed_seconds`)
- [x] 4.2 `src/background/` completion + salvage paths: attach `archiveWarning` (from `/status`'s `archive_warning`) to the `status.complete` and `status.serverDownloadReady` message options
- [x] 4.3 `src/sidepanel/server-mode-state.ts`: add `"cancelled"` to the phase union and an `archiveWarning: string | null` field; handle `status.cancelled` → terminal cancelled phase (carrying `serverDownloadUrl`), store `archiveWarning` additively on `status.complete` / `status.serverDownloadReady` (absent option keeps previous value)
- [x] 4.4 `src/sidepanel/components/DownloadStatus.tsx`: render the stopped-with-partial-archive card when `phase === "cancelled" && serverDownloadUrl` (cancellation wording, amber/slate styling, reuses `onDownloadFromServer`; never the green complete presentation), and a warning block (localized heading + server message as data) on the ready card and the stopped-with-archive card when `archiveWarning` is set
- [x] 4.5 Localization: add the new keys (stopped-with-archive title/subtitle, archive warning heading) to every shipped locale per the `localization` spec — no hardcoded English in shipped components
- [x] 4.6 vitest (`tests/unit/` conventions): `applyServerModeMessage` cancelled transition carries the URL; `status.serverDownloadReady` mid-run does NOT produce the terminal phase; `archiveWarning` additive storage and clean-session absence; `SessionStatusResponse` parses the three optional fields — proven failing at HEAD per task 1.2, passing after 4.1–4.4

## 5. Dead code removal (defect 1 — tasks-only, no spec delta)

- [x] 5.1 Delete `src/sidepanel/utils/tabFilter.ts` and `tests/unit/push-tab-filter.test.ts`; remove the stale `isPushForPanel` comment references in `src/sidepanel/hooks/useScrapingDownloader.ts` (keep `download-routing.test.ts`'s self-contained old-behavior helper)
- [x] 5.2 Verify zero remaining references (`grep -r isPushForPanel src/ tests/`), `npx tsc --noEmit` clean, vitest green

## 6. Full verification

- [x] 6.1 Server: `cd server && python3 -m pytest -q` — all passing (680 baseline + new regressions), no baseline test regressed
- [x] 6.2 Extension: `npm test` — all files/tests passing (967 baseline minus removed dead-code tests plus new tests), `npx tsc --noEmit` clean
- [x] 6.3 Cross-check every scenario in the three delta specs against an implemented test or explicit manual verification note; `openspec validate archive-warning-and-replace-fixes --strict` passes
