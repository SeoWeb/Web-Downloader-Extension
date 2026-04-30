## Why

In server mode, the UI gets stuck showing "Uploading resources..." while the Actions stepper simultaneously shows "Complete". The ZIP file has already been downloaded locally, but the UI never finalizes. This happens because `DOWNLOAD_COMPLETE` (from Chrome's download listener) races with `status.complete` (from the download engine) and the sidepanel ends up with `action=DOWNLOAD_DONE` but `serverModeState.phase` still at `uploading` — and the uploading check in DownloadStatus renders before the DOWNLOAD_DONE hide-check.

## What Changes

- Move the `DOWNLOAD_DONE` hide-check to the top of DownloadStatus.tsx so it always takes priority over server-mode phase checks
- Reset `serverModeState.phase` to `ready` inside the `DOWNLOAD_COMPLETE` handler in sidepanel.tsx, so the state is consistent regardless of message ordering
- Guard the chrome.storage completion handler against double-processing (both message and storage handlers fire for the same download)

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `user-interface`: DownloadStatus rendering priority and DOWNLOAD_COMPLETE state cleanup

## Impact

- `src/sidepanel/components/DownloadStatus.tsx` — rendering order change
- `src/sidepanel.tsx` — DOWNLOAD_COMPLETE handler and storage handler
- No API or dependency changes
