# Proposal: multipage-download-fixes

## Why

The 2026-11-11 operator verification session (first end-to-end run of a rebuilt extension against the parked content changes) surfaced a cluster of verified defects and two product decisions in the multi-page download experience: a "Done" headline that fires after the first page, assets uploaded for text/markdown runs that cannot use them, a pause that silently auto-stops after 60 seconds, false "Download was interrupted — service was restarted" cards, multi-page text/markdown collapsing into single documents (contradicting the text-native-downloads design), a PagePocket archive that holds only the main page's markdown, and a viewer with no way to navigate subpages. The pending operator verification ticks for `text-native-downloads` 7.4 and `download-as-markdown` 4.5 are blocked on exactly these gaps.

## What Changes

- **Linked-page asset gating** — `LinkedPageScraper.downloadAssets()` currently fetches and uploads every subpage's images/css/js/documents unconditionally, ignoring the option snapshot. It SHALL honor the same per-category flags the main page obeys, implementing the agreed policy: assets only when HTML output is on (which force-enables the flags) or in images/documents-only mode; never for text/markdown-only runs.
- **True pause** — pause SHALL wait indefinitely for Resume or Stop instead of self-stopping via the 60 s watchdog. When the service worker dies while paused, the download SHALL enter a **parked** state (checkpoint phase `paused` + persisted scrape-queue snapshot) from which the reopened panel offers Resume (re-spawns the scraper from the snapshot) or Stop (finalize partial). The scraping tab SHALL be released while paused.
- **Honest interruption detection** — the interrupted card's two detectors (45 s panel silence watchdog; startup checkpoint push) currently declare "service was restarted" without any liveness proof and can false-positive during long silent server merges. They SHALL verify worker/session liveness before declaring, and a `paused` checkpoint SHALL render a Paused card — never an interrupted card.
- **Guarded completion** — the panel's poll can declare `finalizeComplete` (headline "Done!") when the in-memory liveness set was lost to a service-worker restart mid-run. Completion declarations SHALL require liveness or terminal-server evidence; per-page progress ("page X of Y") SHALL be surfaced as a first-class counter, not only a scrolling subtitle.
- **Per-page text streaming** — subpage text SHALL be uploaded immediately after each page instead of accumulated in RAM until end of run (order fixed: main text first, subpages append in scrape order — today the order is inverted). Removes the `accumulatedText` whole-run memory hold and makes paused/resumed runs robust.
- **Per-page text/markdown files with readable slugs** — multi-page text output SHALL stop collapsing into one concatenated `content.txt`: the local zip gains `index.txt` (main) + `pages/<slug>.txt` per subpage, reusing the server's existing `generate_page_filename` slug + collision scheme (`about.html` → `about.txt`, `about-c3d4.txt` on collision). Single-page raw delivery is unchanged.
- **Cloud multi-page content** — the monolith's PagePocket push currently drops all linked-page markdown/text (v1 deferral) and sends zero assets in markdown mode, so a cloud zip is one `.md` + `meta.json`. The push SHALL carry per-page markdown/text documents plus a pages manifest (`path`, `title`, `url`); the PagePocket zip gains its `pages/` directory automatically because export zips the whole storage prefix.
- **Viewer subpage navigation** — pagepocket.app SHALL show a burger-menu button on multi-document pages opening a sidebar of subpages (title from stored HTML `<title>`, fetched server-side at assembly); clicking swaps the main content pane. The viewer's hard `notFound()` on any page-detail failure SHALL become a retryable error state for transient failures.
- **Honest merge-phase wording** — in text/markdown-only runs the UI labels the unconditional merge phase plainly (it is required for markdown derivation and title extraction); Stop-then-finalize keeps triggering it by design.

## Capabilities

### New Capabilities

_(none — all behavior changes land in existing capabilities)_

### Modified Capabilities

- `linked-pages` — linked-page asset fetching gated per category on the download options; pause/resume/stop requirement rewritten from bounded-watchdog to indefinite pause with parked state and queue-snapshot persistence.
- `linked-page-content-text` — per-page extraction/upload replaces whole-run concatenation; per-page keyed storage with page-URL identity.
- `server-zip-assembly` — text-only multi-page assembly emits `index.txt` + `pages/<slug>.txt`; readable slug naming shared with the markdown/html scheme; cloud push carries per-page markdown/text documents and a pages manifest (path/title/url) instead of main-page-only documents.
- `pagepocket-proto-contracts` — additive `PageDocument` list on `IngestPageRequest` and pages list on page-read responses.
- `pagepocket-archive-service` — stores `pages/<path>` objects + manifest; page retrieval exposes the subpage list; page ZIP export includes stored pages.
- `pagepocket-api-gateway` — page-detail response includes the subpage list.
- `pagepocket-frontend-page-viewer` — burger-menu subpage sidebar with in-place content swap; transient page-detail failures render a retryable error state instead of `notFound()`.
- `download-recovery` — interruption/completion declarations require liveness or terminal-server evidence; `paused` checkpoints surface a Paused card (Resume/Stop), never the interrupted card.
- `download-ux-feedback` — per-page progress counter and an explicit Paused state in the panel.

## Impact

- **Extension** (`src/`): `background/linked-page-scraper.ts` (asset gating, pause/park, queue snapshot, per-page text upload), `background/download-core.ts` (text ordering, liveness persistence), `background/download-checkpoint.ts` (paused phase, snapshot), `background/cleanupHandlers.ts` (liveness-proof detection), `sidepanel.tsx` + `sidepanel/utils/livePolling.ts` + `sidepanel/hooks/useDownloadWatchdog.ts` (guarded completion, parked card), `sidepanel/server-mode-state.ts`, `sidepanel/components/DownloadStatus.tsx` (counter, paused card), `components/Actions.tsx` (headline), `background/server-client.ts` (per-page content upload), i18n keys ×45 locales.
- **Monolith** (`server/`): `app/api/routes/sessions.py` (per-page content endpoint), `app/services/zip_assembler.py` (text zip layout, cloud push pages + manifest, titles), `app/services/archive_client.py` (push signature).
- **PagePocket** (`pagepocket/`): `proto/archive.proto` (additive), `services/archive-service/servicer.py` (ingest/storage/retrieval), `services/api-gateway/routers/archive.py` (detail response), `frontend/src/components/app/` viewer shell (sidebar, error state).
- **No DB migrations, no breaking API changes** — proto and REST changes are additive; older extensions/monoliths keep working (empty pages lists).
- **Known limitation (documented, not fixed here)**: parked sessions count toward the 20-active-sessions client cap and normal session retention; a deliberately parked download left for weeks may expire server-side — the paused card's Stop action remains valid, Resume falls back per the existing session-expiry path.
