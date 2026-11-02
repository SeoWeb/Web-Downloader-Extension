## Why

The Oct 2026 audit and the operator passes that followed it surfaced six defects that were deliberately deferred from the six shipped changes. They cluster into two failure modes: the server either corrupts or loses merged HTML content (index-0 chunk replacement double-registers the first scroll; bare-text chunk bodies silently vanish from DOM-merged output) or over-charges the session-size quota for legitimate replace uploads (413 near the limit), while the extension UI hides server-produced artifacts the server already reports (the partial-archive download URL after a stop, and the `archive_warning` integrity message).

## What Changes

- **Partial-archive retrieval on stop (extension UI)**: `DownloadStatus` gates the "Download from server" card on `phase === "ready"`, which a stopped run never reaches — the background emits `status.serverDownloadReady` + `status.cancelled`, the URL lands in `serverModeState.serverDownloadUrl`, but no card renders it. The panel SHALL surface the server-archive affordance alongside the cancelled status, per the existing stop contract in `download-lifecycle-reliability`.
- **Archive integrity warning surfaced (extension UI)**: the server emits `archive_warning`, `resources_missing`, and `resources_failed` in `/status` and the finalize payload (shipped in `2026-10-28-server-assembly-honesty`), but the extension's `SessionStatusResponse` drops the fields and no UI shows them. The panel SHALL parse and display the warning on terminal download states.
- **Index-0 chunk replace regenerates the skeleton (server)**: the first chunk of a page becomes the skeleton and is never registered as a chunk, so a later different-content upload at scroll index 0 routes into `replace_chunk`, which _adds_ `0.html` to the chunk list while the skeleton keeps the old content — merged output contains the first scroll twice (old + new). Replacing the skeleton-source chunk SHALL regenerate the skeleton.
- **Replace-mode quota credits superseded size (server)**: the HTML chunk upload's session-size pre-check sums resources + all chunks (still including the chunk about to be superseded) and adds the full new chunk size, double-counting the superseded bytes; legitimate replaces near `MAX_SESSION_SIZE_MB` are falsely rejected with 413 `session_size_exceeded`. Replace-mode uploads SHALL be charged their net growth (new size − superseded size).
- **Bare-text chunk bodies survive DOM merge (server)**: `_dom_merge` parses chunk bodies inside `<html><body>…` so bare text becomes the body's `.text`, and only child _elements_ are appended to the skeleton — text-only (or leading-text) chunks contribute nothing to the merged output. Bare-text chunk content SHALL reach the merged HTML.
- **Dead code removal (extension)**: `isPushForPanel` (`src/sidepanel/utils/tabFilter.ts`) has no production callers since the sidepanel identity-routing rework (`3b13d47`) — only its unit test imports it. Remove the helper, its test file, and stale comment references.

No breaking API changes: the extension starts consuming `/status` fields the server already sends.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `download-ux-feedback`: new panel requirements — surfacing the partial-archive download URL on stopped downloads (alongside the cancelled status), and displaying the server's archive integrity warning (`archive_warning`) on terminal download states.
- `server-html-merge`: new requirements — same-index chunk replacement semantics (skeleton regeneration when the replaced index is the skeleton-source chunk; registration swap otherwise) and preservation of bare-text chunk bodies in DOM-merged output.
- `server-session-storage`: the Session Size Limits requirement changes so replace-mode HTML chunk uploads are charged their net growth instead of the full new chunk size.

The `isPushForPanel` removal changes no requirement (no caller, no observable behavior) and is handled as a tasks-only item.

## Impact

- **Extension**: `src/sidepanel/components/DownloadStatus.tsx` (card gating), `src/sidepanel/server-mode-state.ts` (terminal-state handling for cancelled-with-URL; warning field), `src/background/server-client.ts` (`SessionStatusResponse` gains the integrity fields), localization strings for the new affordances; deletion of `src/sidepanel/utils/tabFilter.ts` and `tests/unit/push-tab-filter.test.ts`, plus stale comment references in `src/sidepanel/hooks/useScrapingDownloader.ts`.
- **Server**: `server/app/api/routes/html.py` (quota pre-check ordering + net-growth charge; index-0 replace routing), `server/app/services/html_merger.py` (`replace_chunk` / skeleton regeneration, `_dom_merge` text-node handling).
- **Tests**: `server/tests/` pytest with the existing real-SQLite fixtures (quota, replace, DOM merge); `tests/unit/` vitest for the panel state machine and status parsing. Regression tests must be proven failing at HEAD before the fixes.
- **Baselines at HEAD (verified 2026-11-02)**: server `python3 -m pytest -q` → 680 passed; extension `npm test` → 67 files / 967 tests passed; `npx tsc --noEmit` clean.
