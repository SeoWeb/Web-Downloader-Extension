## Context

All six findings come from the 2026-10 multi-agent hang audit and were re-verified against current source before this proposal. They share one shape: a download-stage await whose unblock is not guaranteed, so a stalled stage holds the pipeline open indefinitely. Concretely:

- **Pressure gating (finding 1).** `download.ts:41-49` pauses `RequestQueue` on `CRITICAL` and resumes only on `LOW`. `MemoryManager.evaluateMemoryPressure()` (`MemoryManager.ts:346-364`) deliberately fires callbacks only on high-zone boundary transitions and delivers the **boundary** level. So `CRITICAL → MEDIUM` delivers `MEDIUM` (the callback ignores it — not `LOW`), and the later `MEDIUM → LOW` transition fires nothing (`previous < HIGH`, `level < HIGH`). `RequestQueue.pause()` (`RequestQueue.ts:287-294`) clears the processing flag; `scheduleProcessing()` (`501-504`) early-returns while paused, so every queued `enqueueRequest` promise stays pending and the `Promise.allSettled` over images/assets/documents (`download-core.ts:635`) — which has no timeout — never settles. `forceCleanup()` (`MemoryManager.ts:292-310`) recomputes `currentUsage` but does not re-run `evaluateMemoryPressure`, so even a full recovery of memory does not lift the pause until a later periodic check happens to cross the boundary again (and even then the `LOW`-only resume contract can miss it). Note `MemoryPressureLevel` is numerically ranked (`memoryLimits.ts:119-123`, LOW=0 … CRITICAL=3), so subcritical checks are rank comparisons, not string comparisons.
- **Paused scraper (finding 2).** The scraper loop awaits `this.resumePromise` at both queue phases (`linked-page-scraper.ts:315-318, 415-418`). `resumePromise` is created in `pause()` and resolved only by `resume()`/`stop()` (`123-147`), reachable only via the panel messages `SCRAPER_PAUSE/RESUME/STOP` (`message.ts:331-343` → `scraper-state.ts:16-26`). The side panel is the only sender; when it closes, no context can deliver the resume. The keepalive port (`download-state.ts:112-124`) has **no `onDisconnect` handler anywhere**, so the panel-disconnect event — the observable signal that the UI is gone — is currently unobserved, and bidirectional keepalive pings keep the MV3 worker alive indefinitely. Existing recovery is tab close (`cleanupHandlers.ts:329-343`, `stopScraping` at 336) or browser restart.
- **Chunk counter (finding 3).** `SCROLL_AND_EXTRACT_DIFF` (`message.ts:215-224`) passes `sessionState.scrollIndex++` as the chunk-index argument — the increment happens when the argument is evaluated, before the `await` resolves, so a failed upload (client retries exhausted) still counts as streamed. `hasStreamedHtmlChunks()` (`99-104`) is `scrollIndex > 0`, and `download-core.ts:584-591` skips the chunk-0 `"main"` upload when true → finalized session with no main-page HTML. The `SERVER_UPLOAD_HTML_CHUNK` path (`385-407`) was already fixed to advance on success only (with an explicit comment); the diff path predates that invariant.
- **Navigation wait (finding 4).** `navigateAndWait` (`linked-page-scraper.ts:579-602`) resolves on any `onUpdated` event where `updatedTabId === tabId && changeInfo.status === "complete"`. During `chrome.tabs.update(tabId, { url })` the outgoing page can still emit a late `complete`; the wait then resolves with the old page's URL and the wrong DOM is captured/uploaded for that job. The scraper already records `this.lastNavigatedUrl = url` (`570`), so the target URL is available at the listener.
- **Timer hygiene (finding 5).** `capturePageDOM` (`612-620`) and `capturePageDOMChunks` (`652-676`) build `Promise.race([executeScript, timeoutPromise])` where the `setTimeout` handle is never cleared. When `executeScript` wins, the timer still fires later (rejecting an already-settled promise — harmless but a leaked timer that can extend service-worker lifetime); the losing `executeScript` promise is also left pending.
- **Unbounded control calls (finding 6).** `register()` (`server-client.ts:1033-1037`) and `checkHealth()` (`764-766`) use bare `fetch` with no `signal`, while all other calls default to `AbortSignal.timeout(CONTROL_CALL_TIMEOUT_MS)` (constant at line 371; applied at 840, 951, 1098, 1141). `register()` runs inside `ensureApiKey()` → `createSession()` at download start; a black-holed server hangs the whole `START_DOWNLOAD` handler and the panel's `startDownload` promise (`useScrapingDownloader.ts:587`) has no timeout either.

Capability mapping note: the task description allows the chunk-invariant and control-call-timeout requirements to land in `download-engine` or in `upload-timeouts`/`extension-server-client`, "where they best match existing requirement structure". Decision: the chunk invariant goes to `download-engine` (it is a pipeline invariant of `executeDownloadServerMode`); the control-call timeout goes to `upload-timeouts`, whose existing "Control-plane API call timeout" requirement already defines the exact 60-second discipline being extended. Hence this change modifies four capabilities, not three.

## Goals / Non-Goals

**Goals:**

- No download stage may wait forever: memory-pressure pauses always resume; every finalization-gating wait has a bound or a contractual unblock.
- A paused scraper cannot be orphaned by UI loss; the download reaches finalization (success or visible failure) within bounded time.
- The main page's HTML reaches the server exactly once per session, regardless of upload failures during streaming.
- Linked-page jobs capture the DOM of the page they navigated to.
- All server control calls obey the existing timeout discipline.
- Preserve the existing notification discipline (no callback spam on low/medium churn) while fixing the resume contract.

**Non-Goals:**

- Reworking `RequestQueue` scheduling or the limiter; only the pause/resume contract and callers change.
- Server-side changes (session semantics, assembler) — all fixes are extension-side.
- General UI redesign of pause/resume controls; the reopened panel keeps today's resume/stop semantics.
- Adding a panel-side timeout on `startDownload` (the background-side bounds are the fix; the panel already handles rejection via `status.failed`).

## Decisions

### D1 — Resume on any subcritical level; re-evaluate after forceCleanup

`download.ts`'s pressure callback becomes: `level === CRITICAL` → pause; `level < CRITICAL` → resume. Because the manager delivers only boundary levels, the `CRITICAL → MEDIUM` transition itself now resumes the queue — the queue never depends on a `LOW` delivery that the notification discipline never sends. Additionally, `MemoryManager.forceCleanup()` calls `evaluateMemoryPressure()` after recomputing `currentUsage`, so a cleanup that actually recovered memory lifts the pause immediately instead of waiting for the next periodic check.

- _Why not resume on "left the high zone"?_ Equivalent in effect for this callback (MEDIUM is the delivered leaving-level), but the subcritical check is simpler, total (covers any future level delivery), and matches the numeric-rank contract already established by the memory-safety spec.
- _Alternatives considered:_ changing the notification discipline to deliver every transition (more callback churn, breaks the documented silence on low/medium transitions); watchdog-only resume (arbitrary delay for a deterministic fix).

### D2 — Paused-scraper liveness contract

The pause wait must be resolvable without the panel that issued the pause. Three cooperating mechanisms, in order of preference:

1. **Observe keepalive-port disconnect.** When the side panel closes, the service-worker side of the keepalive port (`download-state.ts`) receives `onDisconnect`. A per-tab disconnect hook resolves the affected tab's scraper pause wait as a **stop** (safe default: finish the download rather than hang), since no UI exists to resume it. The hook must tolerate "panel reopened" races: a disconnect followed by a fresh `SCRAPER_RESUME` before the watchdog fires is resolved idempotently (`resume()` already no-ops when not paused).
2. **Paused-state watchdog.** Independently of port events, a paused wait arms a bounded watchdog (reuse the scraper's existing `pageTimeout` scale; a distinct constant is fine). On expiry it logs and stops the scraper (same safe default). This covers panel contexts that close without a clean port disconnect event.
3. **Recoverable paused state.** `isPaused` already lives on the scraper instance held in the `scrapers` map (`scraper-state.ts`), so a reopened panel's SCRAPER_RESUME/SCRAPER_STOP reach the same instance while the worker lives. No persistence layer is added in this change (the worker cannot be killed while the keepalive port holds it, so in-memory state survives; adding `storage.session` persistence is deferred as a follow-up if liveness-only proves insufficient in practice).

Safe default rationale: stop (not resume) — the user's UI is gone, so "keep crawling" without supervision risks unbounded work; stopping finalizes the download and reports completion, which the audit identified as the required recovery path.

### D3 — Chunk counter advances on success only

`SCROLL_AND_EXTRACT_DIFF` uploads with the **current** `scrollIndex` and advances the counter only after `uploadHtmlChunk` resolves successfully (mirroring the `SERVER_UPLOAD_HTML_CHUNK` pattern at `message.ts:405-407`, including the `Math.max` monotonic guard when explicit indices are involved). A failed upload leaves the counter unchanged, so `hasStreamedHtmlChunks()` stays false and `download-core.ts:584-591` performs the chunk-0 `"main"` initialization upload. The main page's chunk 0 is therefore uploaded exactly once per session: by a successful stream at index 0, or by the initialization upload when nothing streamed.

- _Note:_ the sidepanel is responsible for re-requesting a failed scroll chunk; a permanently failed chunk stream still ends with the initialization upload, so the archive never loses the main page (worst case: fewer streamed scroll-state chunks — same as today's failure mode for the explicit-index path).

### D4 — Navigation wait matches the requested navigation

`navigateAndWait`'s `onUpdated` listener additionally requires the completion to belong to the just-issued navigation: match `tab.url` against the requested URL (the scraper already stores it as `lastNavigatedUrl`) with normalization (origin+path; ignore hash-only differences that fire during anchor scroll). A `complete` event carrying a different URL — i.e., the old page's late completion — is ignored, and the wait continues until the requested URL completes or `pageTimeout` elapses (existing timeout/rejection path unchanged).

- _Why URL matching over `chrome.webNavigation`/`tabs.onUpdated` filter objects:_ no new permissions, no listener-shape changes, and the URL is already tracked; the `filter` argument cannot express URL conditions.
- _Fallback:_ if URL equality proves flaky for redirects (server-side redirect lands on a different URL), accept a completion whose URL differs from the target only after the target URL was seen loading — implementation may refine, but the invariant stands: **never resolve on a completion belonging to a page that was not navigated to by this call.**

### D5 — Clear race timers on settlement

Both DOM-capture races get the standard settled-cleanup shape: keep a handle to the timeout id, and clear it in a `finally` (or in both the resolve and reject paths of the raced promise). The losing `executeScript` promise cannot be cancelled (Chrome API has no abort), so the fix is scoped to not leaving live timers behind; the already-settled race means the late rejection is a no-op.

### D6 — All server control calls are timeout-bounded

`register()` and `checkHealth()` adopt the existing pattern: `signal: AbortSignal.timeout(CONTROL_CALL_TIMEOUT_MS)` (or the shared `authenticatedFetch` init path where applicable). A timeout abort surfaces as `TimeoutError`, which both call sites already map to their failure paths (`register` retries with backoff up to `MAX_REGISTRATION_ATTEMPTS`, then fails `ensureApiKey`; `checkHealth` throws `ServerUnavailableError`) — i.e., the download start fails visibly instead of hanging `START_DOWNLOAD` forever.

### D7 — Bounded finalization wait

The `Promise.allSettled` over images/assets/documents in `download-core.ts` gets a safety bound sized from the upload-queue workload model (same calculus as the existing `waitForAll` dynamic timeout: per-resource time × count with a generous cap, applied as an outer race). On expiry the pipeline proceeds to finalization with the stalled category reported as failed (the existing per-category rejection handling already tolerates asset/doc failures; images failing remains a hard error). The memory-gated queue pause is exempt from tripping this bound because D1 guarantees its resume; the bound exists for the residual "paused forever" class of bugs so a single regression can no longer hang finalization.

- _Why not an unbounded wait plus alerts:_ the audit's core finding is that waits with no bound _did_ hang; every finalization-gating wait gets a bound, full stop.

## Risks / Trade-offs

- [Resuming at MEDIUM resumes into still-high memory pressure] → mitigated: the manager keeps force-cleaning at CRITICAL and the pause will re-engage on the next CRITICAL delivery; a brief resume between boundary deliveries only lets a bounded number of queued requests through (limiter + concurrency caps still apply).
- [Port-disconnect auto-stop stops a download whose panel was reopened quickly] → mitigated: the reopened panel sees the stopped/failed state and can restart; the watchdog default (stop) trades auto-resume convenience for guaranteed liveness, matching the audit's requirement that the download must reach finalization.
- [URL-matching navigation wait could miss redirect targets] → D4's fallback accepts the landed URL after the target was seen loading; worst case falls back to the timeout path, which marks the job failed (visible, not wrong-content).
- [Safety bound could cut off a legitimately huge download] → the bound reuses the existing dynamic-timeout calculus (per-resource × count, capped high) already accepted for `waitForAll`; only true stalls trip it.
- [Failed scroll-chunk leaves gaps in streamed scroll state] → unchanged from the explicit-index path's existing failure semantics; the invariant prioritizes "main page always present" over "every scroll state captured".

## Migration Plan

1. All changes are extension-side and independently shippable; order within the change follows the task list (memory gating → scraper liveness → chunk invariant → navigation matching → timer hygiene → control timeouts → validation).
2. No data migration, no server deploy, no feature flag: behavior changes from "hang forever" to "bounded failure/recovery" only in the defective paths.
3. Rollback = revert the corresponding commits; no persisted state is introduced.

## Open Questions

- None blocking. Watchdog duration for the paused scraper (D2.2) is an implementation constant to be tuned during testing (bounded, on the order of the page timeout).
