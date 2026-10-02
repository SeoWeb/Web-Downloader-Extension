## MODIFIED Requirements

### Requirement: Upload queue detects session size limit breach

The UploadQueue SHALL set an internal `sessionFullDetected` flag when any upload receives a 413 status code. Once set, all remaining pending tasks SHALL be immediately marked as failed without making HTTP requests. The 413 response now reflects the accurate total session size (resources + HTML chunks).

#### Scenario: First 413 triggers flag and fast-fails pending queue
- **WHEN** an upload task receives a 413 response from the server (whether from resource or HTML upload)
- **THEN** the UploadQueue sets `sessionFullDetected = true`, marks the failed task, immediately drains all remaining pending tasks as failed (releasing their blob memory), fires the `onSessionFull` callback, and `isSessionFull()` returns `true`

#### Scenario: Normal downloads under the limit are unaffected
- **WHEN** all uploads succeed without 413 errors
- **THEN** `isSessionFull()` returns `false` and the upload queue behaves identically to before this change
