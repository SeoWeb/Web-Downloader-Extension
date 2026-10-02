## Why

When the user presses the Stop button during the first page scrolling phase (before linked pages begin), the extension does not stop. Instead, it continues scrolling and then starts the full download pipeline — the exact opposite of what the user expects. The stop mechanism only works once linked page scraping has begun, because the `SCRAPER_STOP` message handler only acts on the `LinkedPageScraper` (which doesn't exist yet during first-page scrolling) and the download `AbortController` (also not created yet). The UI's `setIsScraping(false)` call actually triggers the download to start via a side effect.

## What Changes

- Distinguish between natural scrape completion (reached bottom of page) and user-initiated stop in the side panel's scraping hook
- Prevent the download phase from starting when the user presses Stop during main page scrolling
- The stop button in the UI delegates to a new callback that properly signals stop intent
- Background `SCRAPER_STOP` message handling remains unchanged — linked page scraping stop already works correctly

## Capabilities

### New Capabilities

- `main-page-scrape-control`: Stop support for the main page scrolling phase. When the user presses Stop while the main page is being scrolled for content, the scrolling loop terminates and no download is initiated.

### Modified Capabilities

- `user-interface`: The Stop button's behavior during first-page scraping changes — the `DownloadStatus` component's `ScrapingControls` sub-component no longer directly calls `setIsScraping(false)`. Instead, it delegates to a new `onStopScraping` callback provided by the scraping hook. The existing stop behavior during linked page scraping and server-mode phases (uploading, assembling) is unchanged.

## Impact

- Affected code: `src/sidepanel/hooks/useScrapingDownloader.ts`, `src/sidepanel/components/DownloadStatus.tsx`, `src/sidepanel.tsx`
- No API changes, no dependency changes
- No breaking changes — the stop button during linked page scraping continues to work as before
