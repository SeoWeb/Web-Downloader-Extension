## Context

The server-mode download flow scrapes a main page and optionally linked pages, uploading HTML chunks and resources to the server. The server enforces a 500MB session size limit (`max_session_size_mb` in `config.py`) by returning 413 on both the resource upload endpoint (`POST /sessions/{id}/resources`) and the HTML chunk upload endpoint (`POST /sessions/{id}/html`).

Currently, when 413 is received:
- `UploadQueue.handleTaskError` (upload-queue.ts:467) marks the task failed and fires `onSessionFull` callback
- The `onSessionFull` callback is defined in `UploadQueue` but never subscribed to — nobody handles it
- The linked-page scraper continues processing, uploading HTML chunks and queuing resource uploads that will also 413
- The queue eventually drains (failed tasks count as "done") but the flow in `executeDownloadServerMode` doesn't know the limit was hit
- If the scraper is still running when `waitForAll` resolves, subsequent HTML uploads 413 and the catch block doesn't differentiate

The server's assembler (`zip_assembler.py:351-359`) already skips missing resource files with a warning, and the `finalize` endpoint does not require a complete resource set. This means partial ZIPs are already server-safe — we just need the client to reach finalize.

## Goals / Non-Goals

**Goals:**
- Stop linked-page scraping immediately when the 500MB limit is hit
- Fast-fail pending uploads after the first 413 (avoid N unnecessary HTTP round-trips)
- Proceed to finalize and assembly with whatever resources were successfully uploaded
- Inform the user that the download is partial

**Non-Goals:**
- Changing the 500MB limit or making it configurable per-download
- Server-side changes to the 413 enforcement or assembly logic
- Retry or resume of skipped resources after the limit is hit
- Guaranteeing all resources from already-scraped pages are included (some will 413 and that's correct — we're at the limit)

## Decisions

### 1. Client-side only, no server changes

**Decision:** All changes are in the extension client. The server's 413 response and assembler behavior are correct as-is.

**Rationale:** The server already does exactly what it should — enforce the limit and skip missing resources. The problem is purely that the client doesn't handle 413 gracefully.

### 2. Fast-fail pending queue on first 413

**Decision:** When the first 413 arrives, set a `sessionFullDetected` flag and immediately drain all pending tasks as failed without making HTTP requests.

**Alternative considered:** Let each task attempt its upload and 413 naturally. Rejected because with 12+ concurrent uploads and a scraper still queuing new ones, this could produce dozens of unnecessary round-trips.

**Rationale:** Once the limit is exceeded, every subsequent upload will also 413. Fast-failing saves network time and lets the queue drain instantly.

### 3. Stop scraper via existing `stopScraping()` mechanism

**Decision:** Use the existing `stopScraping(tabId)` from `scraper-state.ts` which calls `LinkedPageScraper.stop()`, setting `isStopped = true` and breaking the loop.

**Alternative considered:** Add a size-check API endpoint on the server. Rejected because it adds latency and the 413 signal is already immediate and accurate.

**Rationale:** The scraper already has pause/stop/resume machinery. Reusing `stop()` is zero-overhead and handles the "scraping was paused when 413 arrived" case correctly.

### 4. Also break scraper on 413 from HTML chunk uploads

**Decision:** In the linked-page scraper's per-page catch block, detect 413 errors and set `isStopped = true` to break the loop immediately.

**Rationale:** The 413 can come from HTML chunk uploads (not just resource uploads). The upload queue's `onSessionFull` callback stops the scraper asynchronously, but if the scraper is mid-page and the HTML upload 413s, catching it directly avoids one more page being attempted.

### 5. Proceed to finalize regardless of 413 failures

**Decision:** After `waitForAll` resolves, check `isSessionFull()` flag for logging but always proceed to finalize.

**Rationale:** The existing flow already catches `waitForAll` errors and continues to finalize. The `sessionFullDetected` flag is informational — it doesn't change the control flow, just adds visibility and stops the scraper.

## Risks / Trade-offs

- **[Partial ZIP may confuse users]** → Mitigate with a status message ("Session size limit reached, finalizing with partial data"). The ZIP is still valid and usable.
- **[Race: multiple 413s arrive simultaneously]** → Low risk. `sessionFullDetected` is a boolean set synchronously. `stopScraping()` is idempotent. The worst case is one extra page being scraped after the 413, which would also 413 and be handled.
- **[Race: 413 arrives while scraper is between pages]** → Low risk. `stop()` sets `isStopped = true`, checked at the next loop iteration. At most one additional page processes.
- **[Some resources from already-scraped pages are missing]** → Expected. The ZIP contains everything uploaded before the limit. The assembler logs warnings for missing files.
