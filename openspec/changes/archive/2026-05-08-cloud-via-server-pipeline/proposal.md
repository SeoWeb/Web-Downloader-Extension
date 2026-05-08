## Why

When PagePocket cloud mode is enabled, the extension bypasses the local Python server entirely and sends raw HTML + asset blobs directly to the PagePocket cloud. This skips all server-side processing: HTML chunk merging, URL-to-local-path rewriting, CSS `url()` conversion, linked page scraping, and text extraction. The resulting cloud archive is lower quality than a local download.

The local server already has ~80% of the cloud push infrastructure (`archive_client.py`, gRPC `push_to_archive()`, session `cloud_status`/`cloud_page_id` fields), but `pagepocket_user_id` is never set on sessions, so the cloud path never fires.

## What Changes

- The extension will route cloud-mode downloads through the normal server-mode pipeline instead of the direct-to-PagePocket path
- The extension will pass `pagepocketUserId` to the local server during session creation
- The server assembly pipeline will detect cloud-only sessions and push processed data to PagePocket instead of creating a ZIP file
- The server will return cloud page ID in session status for the extension to display
- The `executeDownloadCloudMode` function and `BlobCollector` will be removed from the extension

## Capabilities

### New Capabilities

- `cloud-via-server`: Routes PagePocket cloud uploads through the local server's full processing pipeline (HTML merge, URL rewrite, CSS conversion) instead of the direct-to-cloud path, then pushes the processed result to PagePocket via gRPC

### Modified Capabilities

- `server-zip-assembly`: Assembly pipeline gains a cloud-only branch — when session has `pagepocket_user_id`, skips ZIP creation and pushes processed HTML + resources to PagePocket
- `extension-server-client`: `SessionOptions` gains `pagepocketUserId` field; `SessionStatusResponse` gains `cloud_status`, `cloud_page_id`, `cloud_error` fields
- `pagepocket-archive-service`: No code changes, but receives higher-quality processed HTML from the server pipeline instead of raw HTML from the extension

## Impact

- **Extension TypeScript**: `download-core.ts` (remove cloud bypass, add pagepocketUserId to session creation), `server-client.ts` (new fields), `server-download.ts` (handle cloud completion)
- **Server Python**: `sessions.py` (accept pagepocketUserId in options), `zip_assembler.py` (cloud-only assembly branch)
- **API**: Session creation accepts new optional field; session status response includes cloud fields
- **Backward compatible**: Sessions without `pagepocketUserId` follow the existing ZIP/HTML download path unchanged
