## ADDED Requirements

### Requirement: Upload queue detects session size limit breach
The UploadQueue SHALL set an internal `sessionFullDetected` flag when any upload receives a 413 status code. Once set, all remaining pending tasks SHALL be immediately marked as failed without making HTTP requests.

#### Scenario: First 413 triggers flag and fast-fails pending queue
- **WHEN** an upload task receives a 413 response from the server
- **THEN** the UploadQueue sets `sessionFullDetected = true`, marks the failed task, immediately drains all remaining pending tasks as failed (releasing their blob memory), fires the `onSessionFull` callback, and `isSessionFull()` returns `true`

#### Scenario: Normal downloads under the limit are unaffected
- **WHEN** all uploads succeed without 413 errors
- **THEN** `isSessionFull()` returns `false` and the upload queue behaves identically to before this change

### Requirement: Scraper stops when session size limit is reached
The download flow SHALL subscribe to the `onSessionFull` callback and stop the linked-page scraper immediately when the session size limit is reached.

#### Scenario: Scraper stops on 413 from resource upload
- **WHEN** the upload queue receives a 413 on a resource upload and fires `onSessionFull`
- **THEN** `stopScraping(tabId)` is called, setting the scraper's `isStopped = true`, causing the scraper loop to break at the next iteration check

#### Scenario: Scraper breaks on 413 from HTML chunk upload
- **WHEN** the linked-page scraper receives a 413 error while uploading an HTML chunk for a linked page
- **THEN** the scraper sets `isStopped = true` and breaks out of the page-processing loop immediately, without attempting further pages

### Requirement: Finalization proceeds with partial data
After the upload queue drains (including fast-failed tasks), the download flow SHALL proceed to `scrapeComplete`, `finalizeSession`, and assembly polling regardless of whether the session size limit was reached.

#### Scenario: Finalize with partial data after 413
- **WHEN** the upload queue finishes draining and `isSessionFull()` is `true`
- **THEN** the flow sends `scrapeComplete` with the actual resource count, calls `finalizeSession`, and polls for assembly completion. The server assembles a ZIP containing all resources that were successfully uploaded before the limit was hit.

#### Scenario: Partial download notifies user
- **WHEN** the session size limit is reached during a download
- **THEN** a status message is sent indicating the limit was reached and the download will proceed with partial data
