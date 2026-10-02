## 1. Upload Queue — Session Full Detection and Fast-Fail

- [x] 1.1 Add `private sessionFullDetected = false` field and `isSessionFull(): boolean` accessor to `UploadQueue` class in `src/background/upload-queue.ts`
- [x] 1.2 In the 413 handler (`handleTaskError` around line 467): set `sessionFullDetected = true`, then immediately drain all `this.pending` tasks as failed (set status="failed", blob=null, increment failedCount), then call `notifyProgress()` before firing `onSessionFull`

## 2. Download Core — Wire onSessionFull and Stop Scraper

- [x] 2.1 Import `stopScraping` from `./scraper-state` in `src/background/download-core.ts`
- [x] 2.2 After the `uploadQueue.onProgress` assignment (around line 738), subscribe to `uploadQueue.onSessionFull` with a callback that calls `stopScraping(tabId)` and sends a `{ key: "status.sessionSizeLimitReached" }` status message
- [x] 2.3 After `waitForAll` resolves (around line 949), add a check: if `uploadQueue.isSessionFull()`, log a message and send `{ key: "status.finalizingPartial" }` status message — no logic change, just visibility

## 3. Linked Page Scraper — Break on 413 from HTML Upload

- [x] 3.1 In the per-page `catch` block in `src/background/linked-page-scraper.ts` (around line 349): check if the error has `statusCode === 413` (via `instanceof HttpError && err.statusCode === 413` or duck-typing), and if so set `this.isStopped = true` and `break` out of the loop
- [x] 3.2 Import `HttpError` from `./server-client` if needed for the 413 detection

## 4. Verification

- [x] 4.1 Run TypeScript build (`npm run build` or equivalent) to verify no compilation errors
- [x] 4.2 Verify normal downloads under 500MB are unaffected by checking the build output and tracing the code path where `isSessionFull()` is always `false`
