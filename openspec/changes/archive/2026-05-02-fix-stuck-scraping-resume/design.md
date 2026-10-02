## Context

The server-mode download flow processes resources in three stages: (1) extract and enqueue resources from the main page, (2) process linked pages (if enabled), (3) send `scrapeComplete` and wait for uploads, then finalize. For large sites, stage 2 is the longest-running phase and the most likely point for the Chrome service worker to be killed. The checkpoint system exists but only saves resource URLs after stage 2 completes, making resume impossible when the SW dies during linked-page processing.

The server's `SessionStatusResponse` already includes `resources_received: number` — an authoritative count of resources the server has accepted. This data is available from `getSessionStatus()`, which the resume flow already calls.

## Goals / Non-Goals

**Goals:**
- Ensure the checkpoint has resource URLs before the longest-running phase (linked page processing)
- Enable resume when the checkpoint has no resource URLs but the server already has uploaded resources
- Recover the specific failure mode: all uploads succeeded, but `scrapeComplete` was never sent

**Non-Goals:**
- Preventing service worker termination (browser limitation)
- Periodic checkpoint saves during linked-page processing (nice-to-have, not required for this fix)
- Server-side auto-transition from "scraping" to "uploading" (separate concern)

## Decisions

### 1. Progressive checkpoint save after main-page processing

**Decision**: Insert `updateCheckpointResourceUrls()` call after the `Promise.allSettled` for images/assets/documents completes (after line 814 in download-core.ts), before linked-page processing begins.

**Rationale**: The main-page resource processing is the first phase that populates the upload queue. By saving after it completes, we guarantee the checkpoint has URLs for all main-page resources. Linked-page resources are added later and will be included in the final save at line 922 (which overwrites the progressive save).

**Alternative considered**: Periodic saves every N pages during linked-page processing. Rejected — adds complexity for marginal benefit, since Fix 2 (resume from server) already covers the case where the progressive save didn't happen.

### 2. Resume from server state when checkpoint has no URLs

**Decision**: When `resumeServerDownload()` finds no `resourceUrls` in the checkpoint and the server is in "scraping" status, check `status.resources_received`. If > 0, send `scrapeComplete` with the server's count and proceed directly to finalization, skipping re-upload entirely.

**Rationale**: In the failure scenario, all 4711 resources are already on the server. Re-uploading would be wasteful and could fail (resource URLs may have expired). The server's `resources_received` count is authoritative. After `scrapeComplete` is sent, the server transitions to "uploading" and waits for resources — but it already has them. Calling `finalizeSession` immediately triggers assembly with whatever the server has.

**Alternative considered**: Re-fetch resource URLs from the page and re-upload. Rejected — adds a dependency on the page still being available, and is unnecessary when the server already has everything.

### 3. Extracted `finalizeAndPollAssembly()` helper

**Decision**: Extract the finalization + assembly polling block (~30 lines) into a shared `finalizeAndPollAssembly()` helper called from both the no-URLs resume path and the normal resume path.

**Rationale**: The no-URLs resume path and the normal upload-completion path both need the same finalize → poll sequence. Extracting a helper eliminates the divergence risk that inline duplication would have introduced, and the existing assembling-status resume path already uses the same `downloadWithFallback` pattern so the helper aligns with it naturally.

## Risks / Trade-offs

- **[Progressive save may be incomplete]** The progressive save only captures main-page resources. If the SW dies during linked-page processing, linked-page resources won't be in the checkpoint. → Mitigated by Fix 2: resume from server works regardless of checkpoint contents.

- **[Server `resources_received` could be stale]** If uploads were still in-flight when the SW died, `resources_received` may be less than the total. → Accepted: finalization proceeds with whatever the server has. Partial data is better than a stuck session.

- **[Shared helper adds a call site]** The `finalizeAndPollAssembly` helper is used in two resume paths. → Accepted: the helper is simple and self-contained, and it removes the divergence risk that inline duplication would have introduced.
