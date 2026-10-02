## REMOVED Requirements

### Requirement: Streaming Download Eligibility
**Reason**: The local streaming download path (`downloadResourcesWithStreaming`) is removed. Server-mode downloads process resources via the upload queue, not client-side streaming.
**Migration**: Delete `download-streaming.ts`. Server-mode resource processing uses `processImages`, `processAssets`, `processDocuments` via the server storage adapter's upload queue.

### Requirement: Chunked Download Processing
**Reason**: Local-mode chunked downloading removed. Server-mode uploads resources as complete files via the upload queue.
**Migration**: No replacement needed. Upload queue handles resource uploads.

### Requirement: Streaming Download Lifecycle
**Reason**: Local streaming lifecycle removed.
**Migration**: Delete `download-streaming.ts`.

### Requirement: Streaming Download Pause and Resume
**Reason**: Local streaming pause/resume removed.
**Migration**: No replacement needed.

### Requirement: Streaming Download Cancellation
**Reason**: Local streaming cancellation removed. Download-level abort controller still cancels uploads via the upload queue.
**Migration**: No replacement needed.

### Requirement: Progress Tracking
**Reason**: Local streaming progress removed. Server-mode upload progress is tracked by the upload queue.
**Migration**: Upload queue `onProgress` callback provides equivalent tracking.

### Requirement: Streaming Fallback to Regular Download
**Reason**: No local streaming to fall back from.
**Migration**: No replacement needed.

### Requirement: Incremental Assembly Download
**Reason**: Local incremental assembly removed. Server handles incremental chunk assembly.
**Migration**: Delete `download-incremental.ts`. `START_INCREMENTAL_DOWNLOAD` message action removed.

### Requirement: Stale Streaming Download Cleanup
**Reason**: No client-side streaming downloads to clean up.
**Migration**: No replacement needed.

### Requirement: Memory-Aware Streaming
**Reason**: No client-side streaming to pause.
**Migration**: Memory management still applies to upload queue; `streamingDownloader` event listeners removed from `download.ts` barrel.
