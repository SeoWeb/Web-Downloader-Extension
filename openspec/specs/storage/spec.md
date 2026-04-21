# Storage Specification

## Purpose

Persistent storage and ZIP generation for the Website Downloader extension. Covers the storage adapter abstraction, IndexedDB-based file storage, session management, blob storage, and multi-part ZIP generation for large downloads.

## Requirements

### Requirement: Storage Adapter Abstraction

The system SHALL provide a unified storage interface that supports multiple backends.

#### Scenario: Adding a file to storage

- GIVEN a file path, content (Blob, string, or ArrayBuffer), and optional MIME type
- WHEN the file is added to storage
- THEN the file is stored at the specified path
- AND the content is normalized to a Blob

#### Scenario: Retrieving a file from storage

- GIVEN a file path that exists in storage
- WHEN the file is requested
- THEN the file content is returned as a Blob

#### Scenario: Retrieving a non-existent file

- GIVEN a file path that does not exist in storage
- WHEN the file is requested
- THEN null is returned

#### Scenario: Listing all files

- GIVEN a storage adapter with multiple files
- WHEN all files are enumerated
- THEN a list of file paths and sizes is returned

#### Scenario: Clearing storage

- GIVEN a storage adapter with stored files
- WHEN the clear operation is invoked
- THEN all files are removed from storage

### Requirement: IndexedDB File Storage

The system SHALL store downloaded files in IndexedDB for persistence beyond the service worker lifecycle.

#### Scenario: Storing a file in IndexedDB

- GIVEN a download session ID, a file path, and content
- WHEN the file is stored
- THEN the file is saved with a composite key of `{downloadId}-{path}`
- AND the blob size and MIME type are recorded
- AND the timestamp is recorded

#### Scenario: Retrieving file metadata

- GIVEN a download session ID
- WHEN file metadata is requested
- THEN the file paths, sizes, and IDs are returned
- AND the actual blob content is not loaded

#### Scenario: Deleting all files for a download

- GIVEN a download session ID
- WHEN the download is deleted
- THEN all files associated with that session are removed
- AND the session record itself is removed

#### Scenario: Cleaning up old downloads

- GIVEN files older than 24 hours
- WHEN the cleanup routine runs
- THEN the old files are deleted
- AND the old sessions are deleted
- AND the count of deleted files is returned

#### Scenario: Storage statistics

- GIVEN files stored in IndexedDB
- WHEN storage statistics are requested
- THEN the total file count, total size, and active session count are returned

### Requirement: Download Session Management

The system SHALL manage download sessions with status tracking.

#### Scenario: Creating a new session

- GIVEN a base URL for the download
- WHEN a session is created
- THEN a unique session ID is generated
- AND the session is stored with status "scraping"
- AND the start time is recorded

#### Scenario: Updating session status

- GIVEN an existing session
- WHEN the session status is updated
- THEN the session record is modified with the new status and any additional fields

#### Scenario: Completing a session

- GIVEN a session that has finished successfully
- WHEN the session is completed
- THEN the status is set to "complete"
- AND the end time is recorded

#### Scenario: Failing a session

- GIVEN a session that encountered an error
- WHEN the session is failed
- THEN the status is set to "failed"
- AND the end time and error message are recorded

#### Scenario: Pausing a session

- GIVEN an active session
- WHEN the session is paused
- THEN the status is set to "paused"
- AND the pause timestamp is recorded

#### Scenario: Resuming a paused session

- GIVEN a paused session
- WHEN the session is resumed
- THEN the status is set back to "scraping"
- AND the resume timestamp is recorded

#### Scenario: Finding a resumable session

- GIVEN a base URL
- AND a paused session exists for that URL
- WHEN a resumable session is requested
- THEN the paused session is returned

#### Scenario: Cannot resume non-paused session

- GIVEN a session that is not in the "paused" state
- WHEN a resume is attempted
- THEN an error is thrown

### Requirement: Blob Storage

The system SHALL provide a separate blob storage system for temporary data with metadata tracking.

#### Scenario: Saving a blob with metadata

- GIVEN a blob key, Blob content, and optional download ID
- WHEN the blob is saved
- THEN the blob is stored in the blob object store
- AND metadata is stored including size, timestamp, access count, and download ID

#### Scenario: Retrieving a blob with access tracking

- GIVEN a blob key
- WHEN the blob is retrieved
- THEN the blob content is returned
- AND the access count is incremented
- AND the last-accessed timestamp is updated

#### Scenario: Deleting a blob

- GIVEN a blob key
- WHEN the blob is deleted
- THEN both the blob content and its metadata are removed

#### Scenario: Cleaning up old blobs by age

- GIVEN blobs older than a configurable age (default 30 minutes)
- WHEN the cleanup routine runs
- THEN all blobs older than the cutoff are deleted
- AND their metadata is removed

#### Scenario: Cleaning up blobs by download ID

- GIVEN a download ID
- WHEN download-specific blob cleanup is requested
- THEN all blobs associated with that download ID are deleted
- AND their metadata is removed

#### Scenario: Emergency blob cleanup

- GIVEN the system needs to free memory immediately
- WHEN force cleanup is invoked
- THEN all blobs and metadata are cleared regardless of age or usage

#### Scenario: Blob memory usage reporting

- GIVEN blobs stored in the blob storage
- WHEN memory usage is queried
- THEN the blob count, total size, oldest blob date, and newest blob date are returned

### Requirement: Multi-Part ZIP Generation

The system SHALL generate multi-part ZIP archives when the total download size exceeds a threshold (25MB per part).

#### Scenario: Small download generates single ZIP

- GIVEN a download where the total content fits within the part size
- WHEN the ZIP is generated
- THEN a single `.zip` file is produced

#### Scenario: Large download generates split ZIP

- GIVEN a download where the total content exceeds the part size
- WHEN the ZIP is generated
- THEN the ZIP is split into parts of 25MB each
- AND the first part has a 4-byte spanning signature
- AND parts are named `.z01`, `.z02`, etc.
- AND the last part is named `.zip`
- AND the central directory and end-of-central-directory records reference the correct disk numbers and offsets

#### Scenario: Multi-part download requires side panel

- GIVEN a download that will produce multiple ZIP parts
- WHEN the ZIP generation begins
- THEN the side panel MUST be available for URL.createObjectURL
- AND if the panel is not available, an error is thrown

#### Scenario: Memory pressure check between ZIP parts

- GIVEN a multi-part ZIP is being generated
- WHEN a part is about to be downloaded
- THEN memory pressure is checked
- AND if pressure is critical, the system waits for cleanup and suggests garbage collection
- AND if the side panel becomes unavailable during generation, the download is aborted

#### Scenario: Delay between ZIP parts

- GIVEN a multi-part ZIP is being generated
- AND a part has just been downloaded
- WHEN the next part is ready
- THEN a 2-second delay is applied between parts
- AND garbage collection is suggested if available

### Requirement: Post-Download Storage Cleanup

The system SHALL clean up storage after a download completes.

#### Scenario: Successful download cleanup

- GIVEN a download that completed successfully
- WHEN the cleanup routine runs
- THEN the session status is set to "complete"
- AND all stored files for that download are deleted from IndexedDB
- AND download-specific blobs are cleaned up

#### Scenario: Failed download cleanup

- GIVEN a download that failed
- WHEN the cleanup routine runs
- THEN the session status is set to "failed" with the error message
- AND the stored files are preserved for potential debugging
