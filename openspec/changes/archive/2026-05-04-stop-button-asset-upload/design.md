## Context

The archived change `fix-stop-during-first-page-scrape` introduced a `stoppedByUserRef` guard in `useScrapingDownloader.ts` that prevents the download phase from starting when the user presses Stop during first-page scrolling. This was necessary because, previously, `setIsScraping(false)` triggered the full download pipeline including linked-page scraping — the opposite of what the user wanted.

However, the fix was too aggressive. When the guard returns early, it skips the entire download phase. In server mode, this means main-page HTML chunks (already streamed to the server during scrolling) never get their assets extracted and uploaded. The user gets nothing — no zip, no server assembly, no feedback. When Stop is pressed during linked-page scraping (Scenario 2), this already works correctly: `abortActiveDownload` triggers `uploadQueue.cancel()`, the flow proceeds to `finalizeSession`, and the zip downloads with whatever was already uploaded.

The gap is only in the transition from first-page scrolling to download. When the user stops, they expect the main page's assets to be processed and the zip to download — just without linked pages.

## Goals / Non-Goals

**Goals:**
- When Stop is pressed during first-page scrolling, start the download phase for main-page assets only
- Skip linked-page scraping entirely when the download is user-stopped
- Work identically in both server mode and local mode
- No changes to background code (`download-core.ts`, `message.ts`, etc.)

**Non-Goals:**
- Changing the Stop behavior during linked-page scraping (already correct)
- Changing the Stop behavior during server-mode uploading/assembling (already correct)
- Adding new message types between sidepanel and background
- Modifying the `SCRAPER_STOP` background handler

## Decisions

**Decision 1: Modify download options in the hook instead of returning early**

Instead of `return` in the `stoppedByUserRef` guard, proceed to call `handleStartDownload` directly with a copy of `downloadOptions` that has linked-page processing disabled (`downloadLinks: false`, `downloadLinksFullScraping: false`).

- **Why not a new message type?** Adding a `START_DOWNLOAD_AFTER_STOP` message would duplicate the existing `START_DOWNLOAD` handler logic. The background already handles `downloadLinks: false` correctly — it simply skips linked-page scraping in both `executeDownload` and `executeDownloadServerMode`.
- **Why not a flag sent to the background?** A flag like `stoppedByUser` in the message payload would need propagation through `downloadOptions` into `FilterOptions`, adding complexity across multiple files. Modifying options in the hook is localized.
- **Why use `handleStartDownload` directly instead of the cached `startDownload` callback?** The `startDownload` callback captures `downloadOptions` in its closure via `useCallback`. The captured value is the original options with linked-page scraping enabled. We need to pass a modified copy, which requires calling `handleStartDownload` directly.

**Decision 2: Disable both `downloadLinks` and `downloadLinksFullScraping`**

Both flags are set to `false` in the modified options. `downloadLinksFullScraping: false` alone would fall through to `processLinks()` which downloads the linked page files. Setting `downloadLinks: false` skips all linked-page processing.

- **Why not just `downloadLinksFullScraping: false`?** The user intentionally pressed Stop. Downloading the linked page files (even without full scraping) is extra work the user didn't ask for.

**Decision 3: No background code changes**

The background code (`download-core.ts`, `message.ts`) already handles missing or disabled linked-page options correctly. Both `executeDownload` and `executeDownloadServerMode` check `downloadOptions.downloadLinks` before entering linked-page processing. The `SCRAPER_STOP` handler calls `stopScraping` and `abortActiveDownload`, which are no-ops during first-page scrolling (no scraper or abort controller exists yet) — this is harmless.

## Risks / Trade-offs

- **[Risk] Duplicate download attempts**: If the user presses Stop multiple times, the guard could trigger `handleStartDownload` multiple times. → **Mitigation**: `stoppedByUserRef.current = false` is set before the download call, preventing re-entry. The `isDownloadInProgress` check in `download-state.ts` provides a second layer of protection.
- **[Risk] Race between natural completion and Stop**: If the page reaches the bottom naturally at roughly the same time the user presses Stop, `isScraping` flips to false twice. → **Mitigation**: The `stoppedByUserRef` flag is set synchronously in `stopScraping()`. The natural-completion path (reaching bottom) does not set the flag, so the natural path's download call won't be affected. The Stop path will handle the call once and clear the flag.
- **[Trade-off] In local mode, main-page HTML is accumulated in `downloadResponse.html`**: This has been the case since before this change and is unrelated to the stop behavior.
