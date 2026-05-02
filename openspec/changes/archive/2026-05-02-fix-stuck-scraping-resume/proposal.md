## Why

When scraping large sites (5000+ resources, 500MB+), Chrome kills the service worker during the download. The extension never sends `scrapeComplete` to the server, leaving the session stuck in "scraping" status indefinitely. The existing resume mechanism fails because resource URLs aren't saved to the checkpoint early enough — so resume throws "No resource URLs in checkpoint — full restart required" even though all 4711 resources are already uploaded to the server. This is the most common failure mode for large downloads.

## What Changes

- Save resource URLs to the checkpoint **progressively** — after main-page resource processing completes, not only after linked-page processing finishes. This ensures the checkpoint is populated before the phase where the SW is most likely to be killed.
- Make `resumeServerDownload()` work without checkpoint resource URLs by querying the server's `resources_received` count. If the server already has resources, send `scrapeComplete` with the server's count and skip directly to finalization — no re-upload needed.
- Update the "no resource URLs" error to distinguish between "server has resources, we can recover" and "truly nothing to resume."

## Capabilities

### New Capabilities

_None_

### Modified Capabilities

- `scrape-checkpoint`: Resource URLs must be saved to the checkpoint after main-page resource processing completes (not only after linked-page processing). Currently the spec requires saving only "after resource extraction completes (after processImages, processAssets, processDocuments, and processLinks settle)" — this is too late.
- `server-session-resume`: Resume must work when the checkpoint has no `resourceUrls`, by querying the server's `resources_received` count and proceeding to `scrapeComplete` + `finalize` if resources are already present. Currently the spec requires falling back to a full restart when no `resourceUrls` exist.

## Impact

- `src/background/download-core.ts` — progressive checkpoint save after line 814; resume-without-URLs logic at lines 1187-1190
- `src/background/download-checkpoint.ts` — no changes (existing `updateCheckpointResourceUrls` used as-is)
- `src/background/server-client.ts` — no changes (existing `getSessionStatus` with `resources_received` used as-is)
