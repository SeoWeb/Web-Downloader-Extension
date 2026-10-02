## Context

The extension has two download paths: "server mode" sends data to a local Python microservice for full processing (HTML merge, URL rewrite, CSS conversion, linked pages, ZIP assembly), while "cloud mode" bypasses the server and sends raw HTML + blobs directly to PagePocket. Cloud mode produces lower-quality archives because it skips all server processing.

The local Python server already has cloud push infrastructure: `archive_client.py` implements `push_to_archive()` via gRPC, the session model has `cloud_status`/`cloud_page_id`/`cloud_error` columns, and `zip_assembler.py` has a cloud push block (lines 312-354). However, `pagepocket_user_id` is never set on sessions because the client model field is always NULL — there is no endpoint to populate it.

## Goals / Non-Goals

**Goals:**
- Cloud-mode downloads go through the full server pipeline (HTML merge, URL rewrite, CSS conversion, linked pages)
- Server pushes fully-processed result to PagePocket via gRPC instead of creating a ZIP
- Extension receives cloud page ID from server status response
- Backward compatible — non-cloud sessions work identically to today

**Non-Goals:**
- Changes to the PagePocket cloud service (archive-service, proto definitions)
- Changes to the PagePocket frontend
- Preserving the direct-to-cloud code path as a fallback
- Handling the case where the local server is unreachable but cloud is available (user should have the local server running)

## Decisions

### D1: Pass `pagepocketUserId` via session creation options

**Choice**: Add `pagepocketUserId` to `SessionOptions` in the create session request body.

**Alternatives considered**:
- *New endpoint to update `client.pagepocket_user_id`*: Extra endpoint, extra request, race conditions if user logs in/out mid-session.
- *Custom header on each request*: Fragile, harder to test, leaks auth concerns into HTTP layer.
- *Auto-detect from client record*: Requires a separate "link PagePocket account" flow first.

**Rationale**: Session creation is a single call that already accepts options. The extension already knows the PagePocket user ID from `chrome.storage.local`. One field, one call, no extra endpoints.

### D2: Cloud-only mode determined by `session.pagepocket_user_id`

**Choice**: If `session.pagepocket_user_id` is set, the assembly pipeline skips ZIP creation and pushes to cloud.

**Alternatives considered**:
- *Separate `cloudOnly` boolean option*: Redundant — the presence of a user ID already conveys intent.
- *New session status like "cloud_pushing"*: Adds state machine complexity. The existing `assembling` status with `assembly_phase` is sufficient.

**Rationale**: The server already checks `session.pagepocket_user_id` for the cloud push block. Reusing the same signal keeps the logic simple. The assembly phases already provide progress visibility.

### D3: Send processed HTML (not ZIP bytes) to PagePocket

**Choice**: After phases 1-3 (merge, URL rewrite, CSS conversion), encode the processed `main_html` string as UTF-8 bytes and send as `html_content` to PagePocket. Include all session resources as assets.

**Rationale**: The current cloud push code at lines 319-320 has a bug — it reads the ZIP file bytes and sends them as `html_content`. Sending the processed HTML fixes this. PagePocket's `sanitise_and_rewrite` still runs and correctly handles already-relative paths (basename extraction from `images/photo.jpg` yields `photo.jpg` which matches the asset map).

### D4: Single-file mode produces inlined HTML then pushes

**Choice**: When `singleFile=true` and cloud mode is on, the server still runs the single-file assembly (base64 inlining), reads the resulting HTML from disk, pushes it as `html_content` with no assets, then deletes the local file.

**Rationale**: Single-file HTML is self-contained — all resources are inlined. Sending assets would be redundant. PagePocket just needs the one HTML file.

### D5: Extension polls for cloud completion via existing status endpoint

**Choice**: The extension's existing `pollAssemblyStatus` loop already polls `getSessionStatus`. When the session becomes `ready` and `cloud_page_id` is set in the response, the extension treats it as cloud success.

**Rationale**: No new polling endpoint or mechanism needed. The status response already includes cloud fields. The extension just needs to read them.

## Risks / Trade-offs

- **[Assembly timeout]** The 5-minute assembly poll timeout may be tight when the server also pushes to PagePocket. → Mitigation: `push_to_archive` already has 3 retries with exponential backoff (~7s total worst case). The timeout is generous enough.

- **[gRPC unavailability]** If the PagePocket gRPC service is down, the session will be marked `failed` with `cloud_error`. → Mitigation: The extension shows the error. User can retry. The `RESOURCE_EXHAUSTED` quota error is already handled.

- **[Double HTML rewriting]** PagePocket's `sanitise_and_rewrite` runs on already-processed HTML. → Mitigation: The rewriting is harmless — it matches basenames which still work with relative paths like `images/photo.jpg`. The rewrite to `/r2/...` paths is the desired final state.

- **[BlobCollector removal]** `BlobCollector` is only used by `executeDownloadCloudMode`. Removing it is clean. → Mitigation: Verify no other imports before deleting.
