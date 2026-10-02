## 1. Bidirectional Keepalive

- [x] 1.1 Add `chrome.runtime.onConnect` listener in `background.js` for `"download-keepalive"` ports with 25-second ping interval and cleanup on disconnect
- [x] 1.2 Update `createKeepalivePort()` in `src/background/download-state.ts` to add `port.onMessage` listener responding with `keepalive-pong` to `keepalive-ping` messages

## 2. Upload Timeouts

- [x] 2.1 Add timeout helper function (using `AbortSignal.any()` with `AbortSignal.timeout()` when available, manual `AbortController` + `setTimeout` fallback) to `src/background/server-client.ts`
- [x] 2.2 Apply 5-minute timeout to `uploadResource()` fetch fallback path (line 369-387) combining with existing abort signal
- [x] 2.3 Apply 60-second timeout to `authenticatedFetch()` for all control-plane API calls

## 3. Queue Drain Timeout

- [x] 3.1 Add optional `timeoutMs` parameter to `UploadQueue.waitForAll()` in `src/background/upload-queue.ts` with timer that rejects if queue hasn't drained
- [x] 3.2 In `executeDownloadServerMode()` (line ~914), pass calculated timeout `min(remaining * 30s, 30min)` to `waitForAll()`

## 4. Guaranteed Scrape-Complete

- [x] 4.1 Add `scrapeCompleteSent` flag in `executeDownloadServerMode()` and set it to `true` after line 901
- [x] 4.2 In the catch block (line 979), add best-effort `scrapeComplete()` call if flag is false

## 5. Upload Heartbeat

- [x] 5.1 Add 15-second `setInterval` in `executeDownloadServerMode()` around `waitForAll()` that sends `status.uploadProgress` messages, cleared in finally

## 6. Checkpoint Resource URLs

- [x] 6.1 Extend `DownloadCheckpoint` interface in `src/background/download-checkpoint.ts` with optional `resourceUrls?: Array<{ url: string; path: string; contentType: string }>`
- [x] 6.2 In `executeDownloadServerMode()`, update the checkpoint with `resourceUrls` after resource extraction completes (after `Promise.allSettled` for images/assets/docs)

## 7. Server Session Resume

- [x] 7.1 Add `RESUME_SERVER_DOWNLOAD` action to `src/common/message.ts`
- [x] 7.2 Add `RESUME_SERVER_DOWNLOAD` handler in `src/background/message.ts` that reads checkpoint and calls `resumeServerDownload()`
- [x] 7.3 Implement `resumeServerDownload()` in `src/background/download-core.ts`: query server status, reconnect based on status (UPLOADING→re-upload, ASSEMBLING→poll, READY→download, FAILED→fallback), re-extract resources from `resourceUrls`, upload all, finalize, poll
- [x] 7.4 Update `src/sidepanel.tsx` `onRestartDownload` callback to send `RESUME_SERVER_DOWNLOAD` when checkpoint has `serverSessionId`, falling back to full restart otherwise

## 8. Verification

- [x] 8.1 Build extension and test with small page (example.com) for regression
- [x] 8.2 Test with large page (apple.com/store) to verify no silent failure (manual)
- [x] 8.3 Test resume: start large download, kill service worker via `chrome://serviceworker-internals`, reopen panel, click Resume
- [x] 8.4 Test timeout: verify timed-out uploads are retried and don't silently drop
