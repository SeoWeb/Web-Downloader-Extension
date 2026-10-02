## Why

When a server-mode download hits the 500MB session size limit, the server returns 413 errors on resource and HTML uploads. The linked-page scraper keeps discovering pages and queuing uploads, producing cascading 413 errors. The session gets stuck in "uploading" status because `finalizeSession()` is never called. The user gets nothing — no ZIP, no partial download, just a failure.

## What Changes

- When the first 413 is received, the upload queue sets a flag and fast-fails all remaining pending uploads (no HTTP round-trips for tasks that will certainly 413).
- The `onSessionFull` callback is wired to stop the linked-page scraper immediately, preventing further page discovery and HTML uploads.
- The linked-page scraper breaks its loop when a 413 is received during HTML chunk upload.
- After the queue drains (failed tasks count as "done"), the flow proceeds to `scrapeComplete` → `finalizeSession` → assembly, producing a ZIP with whatever resources were successfully uploaded before the limit was hit.
- No server-side changes needed — the assembler already skips missing resources gracefully.

## Capabilities

### New Capabilities
- `session-size-graceful-degradation`: Client-side graceful handling when the 500MB session size limit is reached — stop scraping, drain uploads, finalize with partial data.

### Modified Capabilities

## Impact

- **Client code**: `upload-queue.ts`, `download-core.ts`, `linked-page-scraper.ts`
- **No server changes**: The server's 413 enforcement and assembler behavior remain unchanged.
- **No API changes**: No new endpoints or request/response modifications.
- **User-visible**: Downloads that exceed 500MB will produce a partial ZIP instead of failing completely. A status message will inform the user that the limit was reached.
