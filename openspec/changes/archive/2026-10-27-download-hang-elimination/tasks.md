## 1. Memory-pressure gating always resumes (finding 1)

- [x] 1.1 Change the pressure callback in `src/background/download.ts` (lines 41-49) so `requestQueue.resume()` runs on ANY delivered level below `MemoryPressureLevel.CRITICAL` (rank comparison, `memoryLimits.ts` numeric enum), keeping `CRITICAL` → `pause()` unchanged
- [x] 1.2 Make `MemoryManager.forceCleanup()` (`src/utils/MemoryManager.ts:292-310`) call `evaluateMemoryPressure()` after recomputing `currentUsage`, so recovered memory lifts a pressure pause immediately instead of waiting for the next periodic check
- [x] 1.3 Add a safety bound to the asset-category wait in `src/background/download-core.ts` (the `Promise.allSettled` at line 635): race it against a timeout sized from remaining resource count (same calculus as the existing `waitForAll` dynamic timeout: per-resource × count, generous cap); on expiry proceed to finalization with the stalled category reported failed (images rejection remains a hard error per existing code)
- [x] 1.4 Unit tests in `tests/unit/memory-manager.test.ts`: pause → `forceCleanup()` → resume path — deliver CRITICAL (queue paused), free allocations, run `forceCleanup()`, assert `evaluateMemoryPressure` re-runs and the resume callback fires with a subcritical level
- [x] 1.5 Unit tests in `tests/unit/request-queue.test.ts`: callback contract — deliver CRITICAL then MEDIUM and assert the queue processes again (no dependency on a `LOW` delivery); deliver CRITICAL then LOW still resumes
- [x] 1.6 Unit tests in `tests/unit/download-liveness.test.ts`: category-wait bound — one category promise never settles, the wait releases within the bound and the download proceeds to finalization; healthy download with slow-but-progressing categories does not trip the bound

## 2. Paused scraper cannot hang when the UI disappears (finding 2)

- [x] 2.1 Observe keepalive-port disconnect in `src/background/download-state.ts` (`createKeepalivePort`, lines 112-124): add an `onDisconnect` hook that resolves the owning tab's scraper pause wait with the stop semantics (via a new liveness hook on `LinkedPageScraper`, wired through `scraper-state.ts`)
- [x] 2.2 Add a paused-state watchdog to `LinkedPageScraper` (`src/background/linked-page-scraper.ts`): arming `resumePromise` (in the two `await this.resumePromise` sites at ~315-318 and ~415-418, or in `pause()`) also arms a bounded timer that stops the scraper if the pause outlives the bound; clear the timer on `resume()`/`stop()`; both phases (internal + external) share the mechanism
- [x] 2.3 Make the stop-on-liveness path finalize the download visibly: ensure `processQueue` exits, `START_DOWNLOAD` answers, and the keepalive port is disconnected (verify the existing finalize/cleanup path in `download-core.ts`/`cleanupHandlers.ts` runs unchanged after a watchdog stop)
- [x] 2.4 Unit tests in `tests/unit/linked-page-scraper-guards.test.ts`: pause the scraper, fire port disconnect (simulated panel close), assert the pause wait resolves within bounded time and the loop exits (no indefinitely-pending `processQueue`)
- [x] 2.5 Unit tests in `tests/unit/linked-page-scraper-guards.test.ts`: watchdog — pause with no resume and no disconnect, advance past the watchdog bound, assert the scraper stops; resume before the bound still continues the queue normally
- [x] 2.6 Unit test in `tests/unit/download-liveness.test.ts`: paused scraper with disconnected panel reaches finalization — the download promise settles (success or controlled failure) and the keepalive port is released

## 3. Chunk counter advances on success only (finding 3)

- [x] 3.1 Fix `SCROLL_AND_EXTRACT_DIFF` in `src/background/message.ts` (lines 215-224): evaluate the chunk index WITHOUT incrementing, await `uploadHtmlChunk`, and advance `sessionState.scrollIndex` only on success (mirror the `SERVER_UPLOAD_HTML_CHUNK` success-only pattern at ~385-407, monotonic `Math.max` semantics preserved)
- [x] 3.2 Unit tests in `tests/unit/message-handler.test.ts`: failed first chunk — `SCROLL_AND_EXTRACT_DIFF` with a rejected `uploadHtmlChunk` (retries exhausted) leaves `scrollIndex` at 0, `hasStreamedHtmlChunks()` returns false, and `download-core` still uploads the final HTML as chunk 0 (`pageType "main"`)
- [x] 3.3 Unit tests in `tests/unit/message-handler.test.ts`: successful chunk advances the counter to the next index; main-page chunk 0 is uploaded exactly once per session (skip logic at `download-core.ts:584-591` verified for both streamed and non-streamed sessions)

## 4. Navigation wait matches the requested navigation (finding 4)

- [x] 4.1 In `navigateAndWait` (`src/background/linked-page-scraper.ts:579-602`), resolve only when the completion event belongs to the requested navigation: match `tab.url` against the URL passed to the call (already stored as `lastNavigatedUrl` at line 570) with normalization (origin + path, hash-insensitive); ignore `complete` events carrying a different (stale) URL; timeout/rejection path unchanged
- [x] 4.2 Unit tests in `tests/unit/linked-page-scraper-guards.test.ts`: stale completion from the previous page (same tabId, old URL, `status "complete"`) does NOT resolve the wait and no capture happens; completion with the requested URL resolves with the final URL; no qualifying event within `pageTimeout` still rejects with the navigation timeout

## 5. DOM-capture timer hygiene (finding 5)

- [x] 5.1 In `capturePageDOM` (`src/background/linked-page-scraper.ts:612-620`) and `capturePageDOMChunks` (`652-676`), keep the timeout handle and clear it when the race settles (both winner and timeout paths) so no stray timers outlive the capture
- [x] 5.2 Unit tests in `tests/unit/linked-page-scraper-guards.test.ts`: winning `executeScript` clears the pending timeout (no timer left); timeout path rejects with the capture-timeout error exactly once and leaves no re-firing timer

## 6. All server control calls are timeout-bounded (finding 6)

- [x] 6.1 Apply `AbortSignal.timeout(CONTROL_CALL_TIMEOUT_MS)` to the bare fetches in `src/background/server-client.ts`: `checkHealth()` (lines 764-766) and `register()` (lines 1033-1037), matching the discipline of the other control calls (lines 840, 951, 1098, 1141); confirm a `TimeoutError` abort maps to the existing retry/`ServerUnavailableError` failure paths so `START_DOWNLOAD` fails visibly instead of hanging
- [x] 6.2 Unit tests in `tests/unit/server-client.test.ts`: register and checkHealth pass an abort signal to fetch; a never-responding server (hanging fetch) rejects within the control-call bound — `register` exhausts retries into an `ensureApiKey` failure, `checkHealth` throws `ServerUnavailableError`

## 7. Validation

- [x] 7.1 Run the full unit suite (`tests/unit`) and fix regressions; confirm no existing test depends on the old resume-only-on-LOW or increment-before-await behavior
- [ ] 7.2 Manual verification (operator): (a) start a download, force critical memory pressure (large allocations), confirm the queue pauses and resumes when pressure drops — download completes without SW restart; (b) pause the linked-page scraper and close the side panel — confirm the download finalizes within bounded time and the panel reopens to a non-stuck state; (c) simulate a failing upload endpoint for the first scroll chunk — confirm the archive contains the main page; (d) point the extension at a black-holed server host (TCP accept, no response) — confirm the download start fails with a visible error within ~60s instead of hanging at "Scraping"
