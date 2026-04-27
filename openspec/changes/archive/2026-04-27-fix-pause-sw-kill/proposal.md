## Why

When a user pauses a download during linked-page scraping, Chrome's MV3 service worker is killed after ~5 minutes of idle because no keepalive mechanism is active during the scraping phase. All in-memory state (scraper queue, pause promise, server session ID) is lost. The user sees a stale "Packing... Download failed" state with no way to resume or restart, forcing a full re-download.

## What Changes

- Establish a keepalive port connection at the start of `downloadResources()`, not just at the end in `trackDownload()`, so the service worker stays alive during scraping and paused states
- Persist scraper queue progress and pause state to `chrome.storage.session` (session-scoped, cleared on browser close) so the download can recover after service worker restart
- On service worker restart, detect a paused/in-progress download and either auto-resume from the persisted checkpoint or present a clear "Download interrupted — restart?" UI instead of the confusing "Packing... Download failed" stale state
- Send a `DOWNLOAD_INTERRUPTED` message to the sidepanel on service worker restart when an interrupted download is detected, replacing the current silent cleanup in `handleInterruptedDownload()`

## Capabilities

### New Capabilities
- `download-keepalive`: Keepalive port management for the full download lifecycle, from `downloadResources()` entry through ZIP delivery
- `scrape-checkpoint`: Session-scoped persistence of scraper queue state (queued/completed/failed URLs, current position) and pause flag, enabling recovery after service worker restart
- `download-recovery`: Detection and UI handling of interrupted downloads on service worker restart, including auto-resume for paused state and clear error messaging

### Modified Capabilities
- `download-engine`: Startup cleanup must transition from silent flag-reset to checkpoint-based recovery or explicit interrupt notification
- `user-interface`: Sidepanel must handle `DOWNLOAD_INTERRUPTED` message with resume/restart options instead of showing stale state

## Impact

- **Background scripts**: `download-state.ts` (keepalive lifecycle), `cleanupHandlers.ts` (interrupted download handling), `linked-page-scraper.ts` (checkpoint persistence), `scraper-state.ts` (persisted scraper reference)
- **Sidepanel**: `sidepanel.tsx` (new message handler), `DownloadStatus.tsx` (interrupted UI state)
- **Storage**: `chrome.storage.session` for checkpoint data (no disk persistence beyond browser session)
- **Server mode**: Recovery must re-reference the existing server session ID rather than creating a new one
