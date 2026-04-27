## Context

The extension runs as a Chrome MV3 service worker, which Chrome can terminate after ~30 seconds of inactivity (no events/ports). The current keepalive mechanism (`keepalivePort` in `download-state.ts`) is only created inside `trackDownload()`, which runs at the very end of the download flow — after assembly completes. During the scraping and paused phases, nothing keeps the service worker alive.

The scraper queue, pause state, and server session reference are all purely in-memory (`LinkedPageScraper` instance, `currentScraper` in `scraper-state.ts`, `activeServerSessionId` in `message.ts`). When the service worker is killed, all are lost with no recovery path.

Current startup cleanup (`cleanupHandlers.ts:handleInterruptedDownload`) silently resets `isDownloadInProgress` and cleans blobs — no message is sent to the sidepanel, leaving it showing stale state.

## Goals / Non-Goals

**Goals:**
- Keep the service worker alive for the entire download lifecycle (scraping → packing → download)
- Persist enough state to detect and communicate interrupted downloads on service worker restart
- Allow the user to restart a download after interruption without confusion
- Minimize storage footprint — use `chrome.storage.session` (cleared on browser close)

**Non-Goals:**
- Full pause/resume across service worker restarts (persisting the entire scraper queue and re-injecting scripts into tabs is out of scope — too complex and fragile)
- Resuming linked-page scraping from the exact checkpoint (a restart re-scrapes from scratch)
- Changes to the server-side session timeout or session management

## Decisions

### 1. Move keepalive port creation to download start

**Decision**: Create the keepalive port in `downloadResources()` immediately after the `setDownloadInProgress(true)` guard, not in `trackDownload()`.

**Rationale**: The port is cheap to create and ensures the service worker stays alive during scraping and pause. The existing `trackDownload()` call in `server-download.ts` is a no-op for a second port since `keepalivePort` is already set.

**Alternative considered**: Periodic `chrome.alarms` to ping the service worker — rejected because alarms have a minimum 1-minute interval and are less reliable than a port connection.

### 2. Persist interrupt metadata to `chrome.storage.session`

**Decision**: Store a lightweight checkpoint object in `chrome.storage.session` (not `chrome.storage.local`) containing:
- `downloadInterrupted: true` flag
- `serverSessionId` (if server mode)
- `tabId`
- `tabUrl`
- `timestamp`
- `phase`: which phase was interrupted ("scraping", "uploading", "assembling")

This is written once when `downloadResources()` enters the download flow and cleared on completion/failure.

**Rationale**: `chrome.storage.session` is session-scoped (auto-cleared on browser close), avoiding stale data across sessions. The metadata is minimal — no queue state, no HTML blobs. It's enough to detect interruption and offer a restart.

**Alternative considered**: Full queue serialization to IndexedDB — rejected as too complex for the first iteration. Restart-from-scratch is acceptable.

### 3. Send DOWNLOAD_INTERRUPTED to sidepanel on SW restart

**Decision**: In `handleInterruptedDownload()`, after detecting the checkpoint, send a `DOWNLOAD_INTERRUPTED` message to the sidepanel with the phase and tab info. The sidepanel shows a clear "Download was interrupted" state with a "Restart download" button.

**Rationale**: The current silent cleanup leaves the panel showing stale "Packing..." or "Downloading..." state. An explicit interrupt message lets the UI transition cleanly.

**Alternative considered**: Auto-resume the download — rejected because the scraper queue is lost and re-scraping requires re-injecting scripts and navigating tabs, which is unreliable after a service worker restart.

### 4. Close keepalive port and clear checkpoint on download completion/failure

**Decision**: In the `finally` block of `downloadResources()`, disconnect the keepalive port and clear the session checkpoint. Also disconnect on `SCRAPER_STOP`.

**Rationale**: Prevents the service worker from staying alive indefinitely after a download completes or is cancelled.

## Risks / Trade-offs

- **[Chrome may still kill SW despite keepalive port]** → Mitigation: The checkpoint/recovery mechanism handles this case. The user gets a clear message and restart option instead of stale state.
- **[Sidepanel may also be closed during 10-minute absence]** → Mitigation: On panel reopen, the panel should check for interrupted downloads via a message to the background and show the interrupt state.
- **[`chrome.storage.session` write latency]** → Mitigation: Write is async but fast (< 5ms). The write happens at download start, not in a hot path.
- **[Restart re-scrapes from scratch]** → Accepted trade-off. Full queue persistence is a future enhancement. The user at least gets a working restart instead of a broken stuck state.
- **[Server session may expire before restart]** → Mitigation: The restart flow will create a new server session. If the old session's resources are still on the server, they'll be re-uploaded (idempotent).
