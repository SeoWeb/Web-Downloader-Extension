## Why

When the user presses Stop during first-page scrolling (before linked pages begin), the extension does nothing — no assets are uploaded or downloaded. The previous fix (`fix-stop-during-first-page-scrape`) correctly prevented the full download pipeline from starting, but went too far by preventing ANY download. The user still expects main page assets to be processed and the zip to download, just without linked-page scraping. When Stop is pressed during linked-page scraping, this already works correctly: assets upload, the session finalizes, and the zip downloads.

## What Changes

- When the user presses Stop during first-page scrolling, the download phase still starts but with linked-page processing disabled (`downloadLinks: false`, `downloadLinksFullScraping: false`)
- Main page assets (images, CSS, JS, documents, text) are extracted, uploaded to server, and the session finalizes normally
- In local mode, a zip is created from main page assets only
- Linked page scraping is skipped entirely, respecting the Stop intent
- The background code (`SCRAPER_STOP` handler, `download-core.ts`) requires no changes — linked page scraping is not triggered when the options disable it

## Capabilities

### New Capabilities

<!-- None — this change relaxes an existing requirement rather than adding a new capability -->

### Modified Capabilities

- `main-page-scrape-control`: The requirement "SHALL NOT start the download phase when the stop is user-initiated" is relaxed. The system SHALL start the download phase but SHALL skip linked-page processing when the stop was user-initiated during first-page scrolling.
- `user-interface`: The Stop button scenario for first-page scrape is updated to reflect that the download does start (for main page assets only), rather than being completely skipped.

## Impact

- Affected code: `src/sidepanel/hooks/useScrapingDownloader.ts` (lines 228-231 — the `stoppedByUserRef` guard in the `useEffect`)
- No background code changes needed
- No API changes, no dependency changes
- No breaking changes — existing stop behavior during linked-page scraping and server-mode phases is unchanged
