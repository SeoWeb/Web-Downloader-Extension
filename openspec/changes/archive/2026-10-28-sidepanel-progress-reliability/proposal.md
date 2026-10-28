## Why

A 2026-10 multi-agent audit confirmed six defects (all verified against current source) that strand the side panel UI or corrupt the download flow:

1. **Terminal messages swallowed on tab switch (HIGH)** — every message handler in `src/sidepanel.tsx` (~168, ~258–345) drops pushes whose `tabId` differs from the panel's _live_ active tab (`src/sidepanel/hooks/useActiveTabInfo.ts` re-pins `tabId` on every `tabs.onActivated`). Start a download on tab A, switch to tab B → `status.uploadProgress`, `status.complete`, `status.serverError`, `DOWNLOAD_FAILED/CANCELLED` are all discarded; `serverModeState.phase` stays `uploading`/`assembling` and `DownloadStatus.tsx` (~415–528) renders the spinner/Stop card forever. The chrome.storage completion fallback has the same live-tab check (~453–501). Pause/Resume buttons send `SCRAPER_PAUSE`/`SCRAPER_RESUME` with the live tabId, targeting the wrong tab.
2. **Resume starts a parallel fresh scrape (HIGH)** — `onRestartDownload` (`src/sidepanel.tsx` ~670–724) sets `isScraping(true)` _before_ sending `RESUME_SERVER_DOWNLOAD`, so `useScrapingDownloader` Effect 1 starts `scrape()` — a NEW server session plus tab scrolling — concurrently with the background resume. The `DOWNLOAD_INTERRUPTED` handler (~361–383) never clears `downloadOptions`, so when the resume path flips `isScraping` back to false, Effect 2 (~537–609) can fire a full second `START_DOWNLOAD`. One click → two parallel flows, duplicate sessions, hijacked tab.
3. **Heartbeat sent but never consumed (MED)** — `src/background/download-core.ts` (~849–861, ~1395–1416) sends 15 s progress heartbeats "so the UI can detect a dead worker"; no panel-side consumer exists. If the MV3 service worker dies mid-download, the panel shows the last progress frame forever.
4. **Startup cleanup wired to `activate` only (MED)** — `performStartupCleanup()` is registered exclusively on `self.addEventListener("activate", …)` (`src/background/cleanupHandlers.ts` ~77–80). MV3 workers do not re-fire install/activate on warm kills + wakes, so a worker killed mid-download and later woken by any event never runs interrupted-download handling — an open panel is never told and the interrupt card never appears.
5. **Shared module-level debounce cancels concurrent sends (MED)** — `sendMessage` in `src/common/chrome.ts` (~65–91) uses one module-level timer; a second non-force call within ~1 s `clearTimeout`s the first caller's pending send (its promise never settles). All `src/background/download-listener.ts` terminal pushes use non-force (`DOWNLOAD_COMPLETE` ~29–43, `DOWNLOAD_CANCELLED` ~74–83 and ~150–159, `DOWNLOAD_FAILED` ~90–100), and only `DOWNLOAD_COMPLETE` has a chrome.storage fallback — CANCELLED/FAILED can be lost entirely.
6. **Unhandled promise rejections when the panel closes (LOW)** — `download-core.ts` push helpers (`uploadQueue.onProgress` ~513–523, `onSessionFull` ~527–536, both heartbeats) call `sendMessage` fire-and-forget; once the panel closes, `sendMessageToPanel` rejects ("Receiving end does not exist") with no catch → unhandled rejections in the service worker that mask real errors.

## What Changes

- **Download-identity routing (panel):** message routing keys on the download's own identity (origin tab + server session pinned when the download started) instead of the live active tab; terminal states always resolve the in-progress UI regardless of the active tab; Pause/Resume/Stop controls target the download's origin tab.
- **Single-flow resume:** clicking Resume/Restart never starts a scrape — no new server session, no scrolling, no second `START_DOWNLOAD`; a single-flow guard mirrors the existing Fix A single-fire gates.
- **Dead-worker watchdog (panel):** while a server-mode download is in `uploading`/`assembling`, the panel arms a watchdog; ~45 s without any download message (3 missed 15 s heartbeats) transitions the panel to the existing interrupted (Resume/Restart) state.
- **Warm-restart startup cleanup (background):** startup cleanup + interrupted-download handling runs on the first service-worker wake via an idempotent top-level guard, independent of the `activate` event; `activate` is kept for install/update; an open panel is notified via the existing `DOWNLOAD_INTERRUPTED` push.
- **Per-call send timers + terminal storage fallback:** `sendMessage` non-force debounce becomes per-call (no shared cancellable timer); `DOWNLOAD_CANCELLED` and `DOWNLOAD_FAILED` gain the same chrome.storage fallback `DOWNLOAD_COMPLETE` already has.
- **Push rejection hygiene:** the background push helpers catch-and-ignore delivery failures (panel closed), so no unhandled rejections occur.

## Capabilities

### New Capabilities

(none — all requirements land in existing component-scoped capabilities)

### Modified Capabilities

- `user-interface`: download status routing changes from live-tab filtering to download-identity routing with always-delivered terminal states (MODIFIED "Download Status Display"); new requirements for single-flow resume, the dead-worker liveness watchdog, and panel push resilience.
- `download-keepalive`: new requirements for the dead-worker detection contract (heartbeat emission cadence + bounded panel detection) and warm-restart startup cleanup (first-wake interrupted-download handling).

## Impact

- **Extension panel:** `src/sidepanel.tsx` (messageWorker routing, interrupt handler, storage fallback handler, watchdog effect, `onRestartDownload`), `src/sidepanel/hooks/useScrapingDownloader.ts` (single-flow guard for resume), `src/sidepanel/components/DownloadStatus.tsx` (`ScrapingControls` uses the download's pinned origin tab), possibly a new `src/sidepanel/hooks/useDownloadWatchdog.ts`.
- **Extension background:** `src/common/chrome.ts` (per-call send timers), `src/background/download-listener.ts` (storage fallbacks for CANCELLED/FAILED), `src/background/download-core.ts` (push helpers catch-and-ignore), `src/background/cleanupHandlers.ts` (first-wake startup cleanup).
- **Tests:** new unit suites under `tests/unit/` (vitest; e.g. message routing, watchdog decision, send-timer behavior, resume single-flow, cleanup wake) plus manual verification passes; existing suites must stay green (`npm test` = `tsc --noEmit && vitest run`).
- **No server changes, no manifest/permission changes, no new i18n keys** (the watchdog reuses the existing `status.downloadInterrupted` message and interrupt card).
