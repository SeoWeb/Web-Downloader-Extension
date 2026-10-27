## 1. Fix 1 — Download-identity message routing (terminal states survive tab switches)

- [ ] 1.1 Add a pinned download-identity ref to `src/sidepanel.tsx`: capture `{ originTabId, serverSessionId }` when a download starts (in `onClickStartDownload`, from the same press-time snapshot `useScrapingDownloader` pins, plus the created/resumed session id) and expose it to `DownloadStatus`
- [ ] 1.2 Reroute `messageWorker` guards in `src/sidepanel.tsx` (~168, ~258, ~263, ~270, ~285, ~299, ~322, ~345) from live `tabId` state to the pinned identity: progress-class messages apply only on identity match; terminal messages (`DOWNLOAD_COMPLETE`, `DOWNLOAD_FAILED`, `DOWNLOAD_CANCELLED`, `DOWNLOAD_INTERRUPTED`) are always evaluated and resolve the UI when they match the tracked download
- [ ] 1.3 Reroute the chrome.storage completion fallback in `src/sidepanel.tsx` (~453–501) to the pinned identity instead of live `tabId`, and extend it to consume the new `downloadCancelled`/`downloadFailed` fallback records (task 5.3)
- [ ] 1.4 Pass the pinned origin tab (not live `tabId`) into `DownloadStatus` → `ScrapingControls` in `src/sidepanel/components/DownloadStatus.tsx` (~101–150) so `SCRAPER_PAUSE`/`SCRAPER_RESUME` (`handlePause`/`handleResume` ~114–128) target the download's own tab; keep Stop on the existing `targetRef` path
- [ ] 1.5 Extract the routing decision (match/no-match/terminal-always-evaluate) into a pure helper (e.g. `src/sidepanel/utils/downloadRouting.ts`) so it is unit-testable without React
- [ ] 1.6 Unit test `tests/unit/download-routing.test.ts`: terminal state (complete, failed, cancelled) delivered and resolves the UI after the live tab has switched away; progress message from a different download identity ignored; pause/resume/stop target the origin tab
- [ ] 1.7 Manual test: start a server-mode download on tab A, switch to tab B during upload/assembly → spinner resolves (complete) or error/cancel card shows (fail/cancel) on tab B's view; Pause/Resume during upload affects tab A's download, not tab B

## 2. Fix 2 — Single-flow resume (one click → exactly one server flow)

- [ ] 2.1 Rework `onRestartDownload` in `src/sidepanel.tsx` (~670–724): resume path MUST NOT call `setIsScraping(true)` — send `RESUME_SERVER_DOWNLOAD` and drive a dedicated resume status (progress pushes arrive via the normal routing of Fix 1); remove the `isScraping` false→true transition that arms Effect 1's `scrape()`
- [ ] 2.2 Mirror the Fix A single-fire gate (`useScrapingDownloader.ts` ~231–266) for resume: a resume run sets/owns its own started-ref so Effect 2 (`useScrapingDownloader.ts` ~537–609) cannot fire a `START_DOWNLOAD` for it; only the resume-failure fallback ("full restart") may start a scrape run, through the normal single-run gate
- [ ] 2.3 Clear `downloadOptions` in the `DOWNLOAD_INTERRUPTED` handler (`src/sidepanel.tsx` ~361–383) so a stale options object cannot re-arm the auto-`START_DOWNLOAD` effect after an interrupt
- [ ] 2.4 Unit test `tests/unit/resume-single-flow.test.ts`: one resume click → exactly one background flow (no `SERVER_CREATE_SESSION`, no scroll/`START_DOWNLOAD` message sent); resume failure fallback starts exactly one scrape run; rapid double-click on Resume sends at most one `RESUME_SERVER_DOWNLOAD`
- [ ] 2.5 Manual test: interrupt a download (kill the service worker mid-upload), click Resume → observe in DevTools/`chrome://serviceworker-internals` that no second session is created, the tab does not scroll, and exactly one completion arrives; repeat with Resume-failure (server unreachable) → exactly one restart flow

## 3. Fix 3 — Panel dead-worker watchdog

- [ ] 3.1 Add watchdog hook (e.g. `src/sidepanel/hooks/useDownloadWatchdog.ts`) or equivalent effect in `src/sidepanel.tsx`: armed while `serverModeState.phase` is `uploading`/`assembling` and the pinned download is live; reset by ANY message belonging to the tracked download (progress, heartbeat `status.uploadProgress`, `status.assemblyProgress`, terminal)
- [ ] 3.2 On timeout (45 s = 3 missed 15 s heartbeats per design D3), transition to the existing interrupted state: set `interruptData` (phase from current `serverModeState`), clear `liveSessionId`, show the existing `status.downloadInterrupted` card (reuse i18n key — no new locale strings); disarm on any terminal state, new download, or when no download is in progress
- [ ] 3.3 Extract the watchdog decision (arm/disarm/reset/timeout) into a pure function for unit testing; verify it never arms during `scraping`/`ready`/`failed`/`timeout` phases or when no download is tracked
- [ ] 3.4 Unit test `tests/unit/download-watchdog.test.ts`: panel transitions to interrupted after 45 s without messages during uploading/assembling; any tracked-download message resets the timer; terminal message wins over a concurrently expiring timer; watchdog inactive when idle or scraping
- [ ] 3.5 Manual test: start a download, terminate the MV3 service worker from `chrome://serviceworker-internals` during upload → within ~45 s the open panel shows the interrupted (Resume/Restart) card instead of the frozen spinner

## 4. Fix 4 — Warm-restart startup cleanup (first-wake interrupted-download handling)

- [ ] 4.1 In `src/background/cleanupHandlers.ts`: trigger `performStartupCleanup()` once per worker lifetime from the module-init path (~361–363, or inside `initializeCleanupHandlers`) behind an idempotent guard (reuse the `handlersInitialized` pattern); keep the existing `activate` registration (~77–80) for install/update
- [ ] 4.2 Make the wake-time run fire-and-forget with `.catch(() => {})` so it never throws or keeps the worker alive; confirm `performStartupCleanup`'s no-op path (no `isDownloadInProgress` flag) stays cheap (single `chrome.storage.local.get`)
- [ ] 4.3 Verify the open-panel notification path: `handleInterruptedDownload` (~242–282) pushes `DOWNLOAD_INTERRUPTED` to a connected panel and keeps checkpoints otherwise (existing `CHECK_INTERRUPTED_DOWNLOAD` discovery on panel open must keep working)
- [ ] 4.4 Unit test `tests/unit/cleanup-warm-restart.test.ts`: simulating a warm wake (module init without `activate`) runs startup cleanup — `isDownloadInProgress` cleared, checkpoint delivered to panel / retained when panel absent; cleanup runs at most once per worker lifetime; `activate` path still triggers it on install/update
- [ ] 4.5 Manual test: start a download, kill the SW mid-download, wake it with an unrelated event (e.g. open another extension page or send a message) → an open panel shows the interrupt card without being reopened; after browser restart the panel-open discovery still offers Resume/Restart

## 5. Fix 5 — Per-call send timers + storage fallback for ALL terminal messages

- [ ] 5.1 Rework `sendMessage` in `src/common/chrome.ts` (~65–91): remove the shared module-level `let i` timer; give each non-force call its own timer (per-call closure) so no call can cancel another's pending send and every returned promise settles
- [ ] 5.2 Audit remaining `force=false` callers (`src/background/download-listener.ts` and any others via grep) to confirm none relies on the old coalescing behavior
- [ ] 5.3 In `src/background/download-listener.ts`: write `chrome.storage.local` fallback records for `DOWNLOAD_CANCELLED` (both the `onChanged` ~74–83 and `onErased` ~150–159 paths) and `DOWNLOAD_FAILED` (~90–100), mirroring the existing `downloadComplete` record (~16–26); consume them in the panel's `storage.onChanged` handler (task 1.3)
- [ ] 5.4 Unit test `tests/unit/send-message-timers.test.ts`: two rapid non-force sends with different payloads are BOTH delivered (previously the second cancelled the first); no promise is left pending after the debounce window; forced sends bypass debouncing unchanged
- [ ] 5.5 Unit test `tests/unit/terminal-storage-fallback.test.ts`: CANCELLED and FAILED records written when pushes fail/panel closed are applied by the panel storage handler exactly once, cleaned up after consumption, and skipped when the live message already resolved the state (same guard as `downloadComplete`)
- [ ] 5.6 Manual test: cancel a `chrome.downloads` download from the save dialog while the panel is open → cancelled feedback shows reliably; close the panel, trigger a failure, reopen the panel → terminal state is surfaced (via storage fallback or `CHECK_INTERRUPTED_DOWNLOAD`), never a stranded spinner

## 6. Fix 6 — Push rejection hygiene (no unhandled rejections in the service worker)

- [ ] 6.1 Wrap the fire-and-forget pushes in `src/background/download-core.ts` — `uploadQueue.onProgress` (~513–523), `onSessionFull` (~527–536), heartbeats (~849–861 and ~1395–1416) — so the `sendMessageToPanel` promise is caught and logged at debug level (mirror `listenMessage`'s catch, `src/common/chrome.ts:117–135`); a failed push never affects the download
- [ ] 6.2 Sweep for other uncaught `sendMessageToPanel` call sites (grep `sendMessageToPanel(`) and apply the same catch-and-ignore where the promise is dropped; leave awaited/critical paths (e.g. checkpoint delivery in `cleanupHandlers.ts`) unchanged
- [ ] 6.3 Unit test `tests/unit/push-rejection-hygiene.test.ts`: invoking `uploadQueue.onProgress`/heartbeat callbacks with a rejecting send does not produce an unhandled rejection (assert via `process.on("unhandledRejection")` spy) and does not throw into the download pipeline
- [ ] 6.4 Manual test: close the side panel mid-upload with the worker logging visible → no "Uncaught (in promise) Error: Receiving end does not exist" noise in the service worker console; download continues to completion

## 7. Regression sweep & validation

- [ ] 7.1 Existing suites stay green: `npm test` (`tsc --noEmit && vitest run`) — especially `tests/unit/download-liveness.test.ts`, `tests/unit/resume-checkpoint-lifecycle.test.ts`, `tests/unit/cleanup-alarms.test.ts`, `tests/unit/message-handler.test.ts`, `tests/unit/actions-status.test.tsx`, `tests/unit/download-status-phase-labels.test.tsx`
- [ ] 7.2 Update any panel tests that assert the old live-tab filtering behavior (e.g. cross-tab message filtering scenarios) to the download-identity model
- [ ] 7.3 Full manual pass (e2e `tests/e2e/ui-smoke.test.cjs` + operator): tab-switch terminal delivery, single-flow resume, watchdog on killed worker, warm-restart interrupt card, rapid terminal sends, panel-closed push hygiene — all verified together in one rebuilt extension
