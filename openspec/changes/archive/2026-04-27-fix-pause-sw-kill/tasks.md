## 1. Keepalive Port Lifecycle

- [x] 1.1 Add `createKeepalivePort()` function to `download-state.ts` that creates a `chrome.runtime.connect({ name: "download-keepalive" })` port if one does not already exist
- [x] 1.2 Add `disconnectKeepalivePort()` function to `download-state.ts` that disconnects and nulls the port
- [x] 1.3 Call `createKeepalivePort()` in `downloadResources()` immediately after `setDownloadInProgress(true)` (before `executeDownload`)
- [x] 1.4 Call `disconnectKeepalivePort()` in the `finally` block of `downloadResources()`
- [x] 1.5 Call `disconnectKeepalivePort()` in `abortActiveDownload()` (Stop button handler)
- [x] 1.6 Update `trackDownload()` in `download-state.ts` to skip port creation when a port already exists (reuse instead of duplicate)

## 2. Interrupt Checkpoint Persistence

- [x] 2.1 Create `download-checkpoint.ts` with `writeCheckpoint(data)` and `clearCheckpoint()` functions using `chrome.storage.session`
- [x] 2.2 Define checkpoint schema: `{ downloadInterrupted: boolean, serverSessionId?: string, tabId?: number, tabUrl?: string, phase: string, timestamp: number }`
- [x] 2.3 Call `writeCheckpoint()` in `downloadResources()` after keepalive port creation, with phase "scraping"
- [x] 2.4 Update checkpoint phase to "uploading" when `status.waitingForUploads` or `status.sendingScrapeComplete` is sent
- [x] 2.5 Update checkpoint phase to "assembling" when `status.assemblingServer` or `status.finalizingServer` is sent (server mode)
- [x] 2.6 Update checkpoint phase to "packing" when `status.creatingPackage` is sent (local mode)
- [x] 2.7 Call `clearCheckpoint()` in the `finally` block of `downloadResources()` (alongside keepalive disconnect)

## 3. Service Worker Restart Detection

- [x] 3.1 Add `readCheckpoint()` function to `download-checkpoint.ts` that reads and returns the checkpoint from `chrome.storage.session`
- [x] 3.2 Modify `handleInterruptedDownload()` in `cleanupHandlers.ts` to read checkpoint, send `DOWNLOAD_INTERRUPTED` message to sidepanel (via `chrome.runtime.sendMessage`), then clear checkpoint
- [x] 3.3 Add `DOWNLOAD_INTERRUPTED` to the message actions enum in `common/message.ts`
- [x] 3.4 Reset `isDownloadInProgress` to false and clear checkpoint even if sidepanel message delivery fails (background may restart before panel is open)

## 4. Sidepanel Interrupt UI

- [x] 4.1 Add `DOWNLOAD_INTERRUPTED` message handler in `sidepanel.tsx` that sets an `isInterrupted` state and stores the interrupt metadata (phase, tabUrl, timestamp)
- [x] 4.2 Add `CHECK_INTERRUPTED_DOWNLOAD` message action that the panel sends on open/reconnect to query the background for any uncleared checkpoint
- [x] 4.3 Add handler in background `message.ts` for `CHECK_INTERRUPTED_DOWNLOAD` that reads and returns checkpoint data (or null)
- [x] 4.4 Create an interrupt state view in `DownloadStatus.tsx` showing the interrupted phase, explanation text, and "Restart download" button
- [x] 4.5 Wire the "Restart download" button to re-trigger the download flow using the stored `tabUrl` and the currently selected download options
- [x] 4.6 Reset `isInterrupted` state when the user clicks restart or dismisses the interrupted view

## 5. Testing & Cleanup

- [x] 5.1 Verify keepalive port is created at download start and disconnected at end (console logging)
- [x] 5.2 Verify checkpoint is written/cleared correctly by inspecting `chrome.storage.session`
- [x] 5.3 Test the full scenario: start download → pause → wait for SW kill → reopen panel → see interrupt UI → restart
- [x] 5.4 Verify that successful downloads clear both checkpoint and keepalive port
- [x] 5.5 Verify that the Stop button clears checkpoint, keepalive, and download-in-progress flag
