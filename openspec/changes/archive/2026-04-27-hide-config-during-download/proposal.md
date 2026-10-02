## Why

When a download or web scraping is in progress, the download button, server mode badge, and configuration panel remain visible. This is confusing — the user has already started the download and shouldn't see the start button or be able to change configuration mid-download. The active download status UI should replace the idle configuration UI.

## What Changes

- Hide the entire "Start download" button + configuration accordion block when `isScraping` or `isScrapingLinkedPages` is true
- The progress/status UI (DownloadStatus component) already renders during active downloads — no change needed there
- Show the config block again once the download completes, is cancelled, or fails

## Capabilities

### New Capabilities

None

### Modified Capabilities

- `user-interface`: The Filter component must hide the download button and configuration panel during active downloads, and restore them when the download ends

## Impact

- `src/components/Filter.tsx` — conditional rendering of the config block based on scraping state
- `src/sidepanel.tsx` — may need to pass `isScraping` / `isScrapingLinkedPages` props to Filter if not already available
