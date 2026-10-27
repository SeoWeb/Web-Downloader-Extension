## Why

A 2026-10 multi-agent audit (verified against current source) confirmed six defects through which a server-mode download can hang indefinitely, hold the MV3 service worker alive forever, or capture/upload the wrong content:

1. **Memory-pressure pause never resumes (HIGH).** The queue-pause callback in `src/background/download.ts:41-49` resumes only on `level === LOW`, but `MemoryManager.evaluateMemoryPressure()` (`src/utils/MemoryManager.ts:346-364`) delivers callbacks only on high-zone boundary transitions: the `CRITICAL → MEDIUM` transition delivers `MEDIUM` (no resume), and the later `MEDIUM → LOW` transition fires nothing. Once paused, `RequestQueue.scheduleProcessing()` early-returns forever (`src/utils/RequestQueue.ts:501-504`), handler `enqueueRequest` promises never settle, and the `Promise.allSettled` in `download-core.ts:635` has no timeout — the download hangs indefinitely. `forceCleanup()` (`MemoryManager.ts:292-310`) recomputes usage but never re-runs the pressure evaluation, lengthening the stall.
2. **Paused scraper + closed side panel = permanent hang (HIGH).** `LinkedPageScraper` awaits `this.resumePromise` (`src/background/linked-page-scraper.ts:315-318, 415-418`), resolved only by SCRAPER_RESUME/SCRAPER_STOP panel messages. If the side panel closes while paused, nothing ever resolves it: `processQueue` never returns, finalize never runs, the START_DOWNLOAD channel never answers, and the keepalive port (`src/background/download-state.ts:112-124`, no `onDisconnect` handling) keeps the MV3 worker alive. Recovery only via tab close (`cleanupHandlers.ts:336`) or browser restart.
3. **Chunk counter advanced before upload resolves (MED-HIGH).** `src/background/message.ts:215-224` evaluates `sessionState.scrollIndex++` as an argument before `uploadHtmlChunk` resolves, so a failed (retries-exhausted) upload still advances the counter. `hasStreamedHtmlChunks()` (`message.ts:99-104`) then returns true and `download-core.ts:584-591` skips the chunk-0 initialization upload — the session finalizes with **no main-page HTML** (empty/skeleton archive). The `SERVER_UPLOAD_HTML_CHUNK` path (`message.ts:385-407`) already advances on success only; the diff path violates that invariant.
4. **`navigateAndWait` resolves on any tab "complete" (MED-LOW).** `linked-page-scraper.ts:579-602` filters only by `updatedTabId === tabId && changeInfo.status === "complete"` — the old page's late completion (mid-navigation) resolves the wait with the wrong URL and the wrong DOM is captured/uploaded for that linked-page job.
5. **`cleanupPageDOM` race leaks timers (LOW).** The `Promise.race` timeouts in `capturePageDOM` (`linked-page-scraper.ts:612-620`) and `capturePageDOMChunks` (`652-676`) never clear the losing timer; the losing `executeScript` promise is left pending, and stray timers can extend service-worker lifetime.
6. **`register()` / `checkHealth()` fetches have no timeout (MED-LOW).** `src/background/server-client.ts:1033-1037` and `764-766` use bare `fetch` with no abort `signal`, while every other control call applies `AbortSignal.timeout(CONTROL_CALL_TIMEOUT_MS)`. A black-holed server (TCP accepted, no response) hangs `ensureApiKey()` inside `createSession` forever — `START_DOWNLOAD` never answers and the panel await (`src/sidepanel/hooks/useScrapingDownloader.ts:587`) hangs with no timeout; the UI sticks at "Scraping".

## What Changes

- Resume the request queue on **any** subcritical pressure delivery (not only `LOW`), and re-run the pressure evaluation after `forceCleanup()` so a pause caused by memory pressure is always followed by a resume without a service-worker restart.
- Add a safety bound to the download pipeline's asset-category wait (`Promise.allSettled` in `download-core.ts`) so no download step can wait without a bound.
- Make the paused scraper live: resolve the pause wait when the side panel disappears (keepalive/port disconnect is observable) and via a paused-state watchdog, so a download paused with the panel closed always reaches finalization within bounded time; the paused state remains controllable from a reopened panel.
- Advance the streaming chunk counter **on success only** in the `SCROLL_AND_EXTRACT_DIFF` path (aligning it with `SERVER_UPLOAD_HTML_CHUNK`), guaranteeing the main-page chunk 0 is uploaded exactly once per session.
- Make `navigateAndWait` resolve only on a completion event belonging to the requested navigation (URL match against the just-navigated URL), ignoring stale completions from the previous page.
- Clear the losing timers in the DOM-capture `Promise.race` calls on settlement.
- Apply the existing `CONTROL_CALL_TIMEOUT_MS` abort discipline to `register()` and `checkHealth()` so every server control call is timeout-bounded.

## Capabilities

### New Capabilities

(none — all requirements land in existing capabilities)

### Modified Capabilities

- `download-engine`: adds a "bounded download waits" requirement (the asset-category wait carries a safety bound; no finalization-gating wait is unbounded) and an "HTML chunk counter advances on success only" requirement (failed chunk never advances the index; chunk 0 uploaded exactly once).
- `memory-safety`: "Recoverable memory gating" is tightened — a queue paused at `critical` is resumed by any subcritical delivery (the high-zone-leaving transition itself), and `forceCleanup` re-evaluates pressure so recovery never waits for the next periodic check.
- `linked-pages`: "Scraper Pause, Resume, and Stop" gains a liveness contract (paused scraper cannot hang when the UI disappears; bounded resolution; reopened panel can resume/stop). New requirements for navigation completion matching (stale completions ignored) and DOM-capture timer cleanup.
- `upload-timeouts`: "Control-plane API call timeout" is extended to cover **all** server control calls, including the unauthenticated `register()` and `checkHealth()`, which currently bypass the `authenticatedFetch` timeout.

## Impact

- **Code:** `src/background/download.ts` (resume contract), `src/utils/MemoryManager.ts` (post-cleanup re-evaluation), `src/background/download-core.ts` (safety bound on the category wait), `src/background/linked-page-scraper.ts` (pause liveness + watchdog, navigation matching, timer cleanup), `src/background/download-state.ts` (observe keepalive-port disconnect), `src/background/message.ts` (success-only counter advance), `src/background/server-client.ts` (timeouts on `register`/`checkHealth`).
- **Tests:** `tests/unit/memory-manager.test.ts`, `tests/unit/request-queue.test.ts`, `tests/unit/linked-page-scraper-guards.test.ts`, `tests/unit/message-handler.test.ts`, `tests/unit/download-liveness.test.ts`, `tests/unit/server-client.test.ts`.
- **No server changes, no manifest changes, no protocol changes.** Failure-visible behavior replaces silent hangs: bounded waits surface as errors/retries the UI can display.
