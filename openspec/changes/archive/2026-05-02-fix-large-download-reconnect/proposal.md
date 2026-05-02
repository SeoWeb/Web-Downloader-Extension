## Why

Large page downloads (1900+ resources, ~210MB) fail silently. The service worker is killed mid-upload because the keepalive port has no corresponding listener, uploads have no timeouts, and there's no reconnect mechanism. The user sees "download failed" with no recovery path beyond starting over.

## What Changes

- **Bidirectional keepalive pings**: Add `onConnect` listener in `background.js` and bidirectional ping/pong messages to keep the service worker alive during long uploads
- **Upload fetch timeouts**: Add `AbortSignal.timeout()` to `uploadResource()` and `authenticatedFetch()` so hung requests fail fast instead of blocking forever
- **Queue drain timeout**: Add an overall timeout to `waitForAll()` so the upload phase cannot stall indefinitely
- **Guaranteed scrape-complete**: Ensure `scrapeComplete()` is always sent to the server (best-effort in catch block), preventing sessions from getting stuck in SCRAPING status
- **Upload heartbeat**: Periodic progress messages during `waitForAll()` so the UI can detect a dead service worker
- **Server session resume**: When the user clicks "Restart Download" after an interruption, reconnect to the existing server session instead of re-scraping from scratch. The server already supports this (idempotent `scrapeComplete`/`finalize`, resource deduplication by URL hash)

## Capabilities

### New Capabilities
- `upload-timeouts`: Per-request and overall timeouts for server upload fetch calls and queue draining
- `server-session-resume`: Reconnect to an existing server session after service worker restart, skipping re-scraping by re-uploading resources to the deduplicating server

### Modified Capabilities
- `download-keepalive`: Add bidirectional ping/pong between service worker and background port to ensure Chrome considers the worker actively doing I/O
- `scrape-checkpoint`: Extend checkpoint with resource URL list so resume can re-download and re-upload without re-scraping the page
- `download-recovery`: Change "Restart Download" to attempt session resume before falling back to full restart

## Impact

- **Extension background scripts**: `background.js`, `download-state.ts`, `download-core.ts`, `server-client.ts`, `upload-queue.ts`, `download-checkpoint.ts`, `message.ts`
- **Extension sidepanel**: `sidepanel.tsx` (restart callback routes to resume flow)
- **Server**: No changes needed — existing idempotent endpoints and URL-hash deduplication already support resume
- **Backward compatibility**: All changes are additive; no breaking changes to existing download flow for smaller pages
