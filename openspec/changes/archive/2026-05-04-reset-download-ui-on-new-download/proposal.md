## Why

After a download completes, the "Download Complete" section remains visible. When the user clicks "Start Download" to begin a new download, the download process starts correctly, but the UI still shows the "Download Complete" section instead of transitioning to the download progress UI. This confuses users — they see a success message while a new download is actively running.

## What Changes

- When `onClickStartDownload` fires, reset the `action` state to `null` so the `DownloadComplete` component hides, the `DownloadStatus` component shows, and the `Actions` stepper reappears.
- Clear `interruptData` so any stale interrupt state from a previous download doesn't interfere with the new download UI.

## Capabilities

### New Capabilities

<!-- None — this is a bug fix to existing UI behavior -->

### Modified Capabilities

- `user-interface`: When a new download is initiated via "Start Download", the download progress UI SHALL be displayed and the download complete UI SHALL be hidden, even if `action` was previously set to `DOWNLOAD_DONE` from a prior download.

## Impact

- `src/sidepanel.tsx`: The `onClickStartDownload` callback (line 369) needs `setAction(null)` and `setInterruptData(null)` calls added before starting the download.
