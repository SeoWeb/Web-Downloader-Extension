## Context

The extension uses a Manifest V3 service worker for background processing. Chrome kills MV3 service workers after ~30 seconds of inactivity. The current keepalive port (`download-state.ts`) creates a `chrome.runtime.connect()` port but there's no `onConnect` listener in `background.js`, so Chrome may still consider the worker idle. For large downloads (1900+ resources), uploads take 3-10 minutes, making service worker termination likely.

The server already supports session resumption: `scrapeComplete()` and `finalizeSession()` are idempotent, and resources are deduplicated by URL hash (re-uploading an existing resource silently replaces it).

## Goals / Non-Goals

**Goals:**
- Prevent service worker termination during long uploads
- Fail fast on hung network requests instead of blocking indefinitely
- Guarantee the server session transitions out of SCRAPING status
- Allow users to reconnect to an existing server session after service worker restart
- Provide visible feedback during uploads so users can detect stalls

**Non-Goals:**
- Lazy blob loading / IndexedDB-backed upload queue (deferred — addresses memory pressure for extreme cases but is a large refactor)
- Server-side changes (server already supports everything needed)
- Automatic background resume without user interaction (service worker restart requires panel reopen)

## Decisions

### D1: Bidirectional keepalive via port ping/pong

**Decision**: Add `chrome.runtime.onConnect` listener in `background.js` that sends `{ type: "keepalive-ping" }` every 25 seconds. The port creation side responds with `{ type: "keepalive-pong" }`.

**Rationale**: Chrome keeps service workers alive while there is active I/O on a port. A one-directional port creation is not sufficient — Chrome needs to see actual message traffic. A 25-second interval stays well under Chrome's ~30-second idle timeout.

**Alternative considered**: `chrome.alarms` API for keepalive — rejected because alarms have a minimum 1-minute interval in MV3, which is too coarse and doesn't prove active I/O.

### D2: AbortSignal.timeout() for fetch calls

**Decision**: Use `AbortSignal.timeout()` (Chrome 103+) combined with `AbortSignal.any()` (Chrome 116+) to add timeouts to fetch calls. Fall back to manual `AbortController` + `setTimeout` for Chrome <116.

**Rationale**: MV3 extensions require Chrome 110+, so only the `any()` gap (110-115) needs a fallback. Timeouts: 5 minutes for resource uploads, 60 seconds for control-plane API calls.

**Alternative considered**: Per-request `setTimeout` + `AbortController` everywhere — more verbose but works on all Chrome versions. Using `AbortSignal.any()` when available keeps the code cleaner for the vast majority of users.

### D3: Resume via re-upload with server deduplication

**Decision**: On resume, re-fetch resource blobs directly from their original URLs using `fetch()` and upload all of them. The server deduplicates by URL hash, so already-received resources are silently replaced without extra storage.

**Rationale**: Tracking which specific resources were uploaded would require a server endpoint to list uploaded resource URLs, which doesn't exist and would need server changes. Re-uploading is simpler and the server handles it gracefully. Direct fetching is preferred over the content script because the content script may not be injected or responsive after a service worker restart.

**Alternative considered**: Store blob data in IndexedDB for true resume — rejected because blobs for 1900+ resources would consume significant IndexedDB storage and the checkpoint would become very large.

### D4: Checkpoint stores resource metadata (URLs only)

**Decision**: Extend the checkpoint with a `resourceUrls` array containing `{ url, path, contentType }` for each discovered resource. This is metadata only (no blob data), staying small even for 1900+ entries.

**Rationale**: Having the resource list in the checkpoint allows resume to skip re-scraping the page HTML. The content script still needs to re-download the actual blobs, but the URL discovery step is eliminated.

### D5: Guaranteed scrapeComplete via catch-block retry

**Decision**: Track `scrapeCompleteSent` flag. In the catch block, if not sent, attempt a best-effort `scrapeComplete()` call before re-throwing.

**Rationale**: The server session is stuck in SCRAPING forever if `scrapeComplete()` never runs. A best-effort attempt in the catch block is the last chance to transition the session. If even this fails (service worker killed before catch runs), the server's 30-minute stale session cleanup is the backstop.

## Risks / Trade-offs

- **[Risk] AbortSignal.any() not available on Chrome 110-115** → Mitigation: runtime feature detection with fallback to manual `AbortController` + `setTimeout`
- **[Risk] Service worker killed before catch block runs** → Mitigation: Server's 30-minute stale session cleanup marks stuck sessions as FAILED; resume mechanism handles FAILED sessions by starting fresh
- **[Risk] Re-uploading all resources on resume is slower for near-complete downloads** → Mitigation: The server's deduplication is fast (URL hash lookup); the main cost is re-downloading blobs from the original server, not the upload itself. For sessions that were nearly done, the assembly may already be complete (status=READY) and the download URL can be used directly
- **[Risk] Checkpoint size grows with resource count** → Mitigation: `resourceUrls` stores only strings (URL + path + contentType), roughly 200 bytes per entry. 1900 entries = ~380KB, well within `chrome.storage.session` limits (10MB default)
