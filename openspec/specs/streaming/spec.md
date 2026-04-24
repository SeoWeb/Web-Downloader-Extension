# Streaming Specification

## Purpose

Streaming and large download support for the Website Downloader extension. Covers how large resources are downloaded in chunks, how progress is tracked and persisted, and how the multi-part ZIP output is generated for downloads exceeding size limits.

## Requirements

### Requirement: Streaming Download Eligibility

The system SHALL determine whether a resource should be downloaded using streaming based on file size and type. In server mode, the streaming downloader is still used for fetching large resources from origin sites, but the resulting data is uploaded to the server rather than stored in split ZIP parts.

#### Scenario: File exceeds streaming threshold

- GIVEN a resource larger than the streaming threshold (5MB)
- WHEN streaming eligibility is checked
- THEN the resource is downloaded using streaming

#### Scenario: File has a streaming-eligible extension

- GIVEN a resource with a known large-file extension (e.g., .zip, .mp4, .pdf, .iso)
- WHEN streaming eligibility is checked
- AND the file size cannot be determined
- THEN the resource is downloaded using streaming as a conservative measure

#### Scenario: Small file uses regular download

- GIVEN a resource smaller than the streaming threshold
- WHEN streaming eligibility is checked
- THEN the resource is downloaded using the regular download path

#### Scenario: No large files found

- GIVEN none of the page's resources are large enough for streaming
- WHEN the streaming download function is invoked
- THEN the entire download falls back to the regular download path

#### Scenario: Large resource fetched then uploaded

- GIVEN server mode is active and a resource exceeds the streaming threshold (5MB)
- WHEN the resource is downloaded using the streaming downloader
- THEN the chunks are reassembled into a complete blob
- **AND** if the resource is a text-based MIME type (`text/*`, `application/javascript`, `application/json`, `application/xml`), the blob is gzip-compressed before upload
- **AND** binary resources (images, videos, PDFs, fonts) are uploaded uncompressed
- AND the blob is uploaded to the server via the ServerStorageAdapter
- AND no split ZIP generation is performed on the client

#### Scenario: Split ZIP generation skipped in server mode

- GIVEN server mode is active
- WHEN the download completes and ZIP generation would normally begin
- THEN the split ZIP generator is NOT used
- AND the server handles ZIP assembly instead

### Requirement: Chunked Download Processing

The system SHALL download large resources in chunks with configurable chunk sizes.

#### Scenario: CSS file chunking

- GIVEN a CSS file being downloaded via streaming
- WHEN the download is initiated
- THEN the file is downloaded in 512KB chunks
- AND up to 2 chunks are downloaded in parallel

#### Scenario: JavaScript file chunking

- GIVEN a JavaScript file being downloaded via streaming
- WHEN the download is initiated
- THEN the file is downloaded in 512KB chunks
- AND up to 2 chunks are downloaded in parallel

#### Scenario: Image file chunking

- GIVEN an image file being downloaded via streaming
- WHEN the download is initiated
- THEN the file is downloaded in 1MB chunks
- AND up to 3 chunks are downloaded in parallel

#### Scenario: Data URL images skipped

- GIVEN an image URL that starts with "data:"
- WHEN streaming resources are enumerated
- THEN the image is skipped for streaming

### Requirement: Streaming Download Lifecycle

The system SHALL manage the complete lifecycle of a streaming download including creation, progress tracking, and completion.

#### Scenario: New streaming download creation

- GIVEN a URL for a large resource
- WHEN a streaming download is started
- THEN a HEAD request is made to determine file size, MIME type, and filename
- AND optimal chunk size is calculated based on total size
- AND the download object is created with status "pending"
- AND the download is registered in the active downloads map

#### Scenario: Streaming download completion

- GIVEN all chunks of a streaming download have been received
- WHEN the download completes
- THEN the download status is set to "completed"
- AND the progress event is fired

#### Scenario: Streaming download failure

- GIVEN a chunk download fails with a non-retryable error
- WHEN the error is processed
- THEN the download status is set to "failed"
- AND the error message is stored
- AND the error event is fired

### Requirement: Streaming Download Pause and Resume

The system SHALL support pausing and resuming streaming downloads.

#### Scenario: Pausing a streaming download

- GIVEN an active streaming download
- WHEN the pause command is issued
- THEN the download status is set to "paused"
- AND progress is persisted
- AND the pause event is fired

#### Scenario: Resuming a paused download

- GIVEN a paused streaming download
- WHEN the resume command is issued
- THEN existing chunks are validated
- AND the downloaded size is recalculated from valid chunks
- AND the download continues from where it left off

#### Scenario: Resuming a download from persisted state

- GIVEN a download that was previously persisted (e.g., after service worker restart)
- AND the download status in storage is "streaming"
- WHEN the download is restarted
- THEN the existing download is resumed from the persisted state
- AND previously downloaded chunks are validated before continuing

#### Scenario: Cannot resume non-paused download

- GIVEN a download that is not in the "paused" state
- WHEN the resume command is issued
- THEN an error is thrown indicating the download cannot be resumed

### Requirement: Streaming Download Cancellation

The system SHALL support cancelling streaming downloads.

#### Scenario: Cancelling a streaming download

- GIVEN an active streaming download
- WHEN the cancel command is issued
- THEN the download status is set to "aborted"
- AND the download is removed from the active downloads map
- AND the persisted progress is removed

### Requirement: Progress Tracking

The system SHALL provide real-time progress information for streaming downloads.

#### Scenario: Querying download progress

- GIVEN an active streaming download
- WHEN progress is queried
- THEN the following metrics are returned: completed chunks, total chunks, bytes downloaded, total bytes, download speed, estimated time remaining, and current status

#### Scenario: Progress event during streaming

- GIVEN an active streaming download
- WHEN chunks are being downloaded
- THEN periodic progress updates are sent via the progress event listener
- AND the progress percentage is calculated

### Requirement: Streaming Fallback to Regular Download

The system SHALL fall back to the regular download path when streaming fails.

#### Scenario: Streaming download fails

- GIVEN a streaming download encounters an unrecoverable error
- WHEN the streaming path fails
- THEN the system falls back to the regular download path
- AND a fallback status message is sent

#### Scenario: Streaming fallback also fails

- GIVEN the streaming download fails
- AND the regular download fallback also fails
- WHEN the fallback download errors
- THEN an error message is displayed to the user

### Requirement: Incremental Assembly Download

The system SHALL support downloading with pre-assembled incremental HTML content.

#### Scenario: Incremental assembly download with valid job

- GIVEN a valid assembly job ID
- AND the incremental merge finalizes successfully
- WHEN the incremental download is executed
- THEN the assembled HTML is used as the index file
- AND remaining resources are processed normally
- AND the ZIP is generated and downloaded

#### Scenario: Incremental assembly finalization failure

- GIVEN an assembly job ID whose finalization fails
- WHEN the incremental download is executed
- THEN an error is thrown with the finalization error
- AND the download is aborted

### Requirement: Stale Streaming Download Cleanup

The system SHALL periodically clean up completed or failed streaming downloads.

#### Scenario: Cleaning up old completed downloads

- GIVEN a streaming download in "completed" or "failed" status
- AND the download was last updated more than 24 hours ago
- WHEN the cleanup timer fires (every 60 seconds)
- THEN the download is removed from the active downloads map
- AND the persisted progress is removed

### Requirement: Memory-Aware Streaming

The system SHALL pause streaming downloads when memory pressure is critical.

#### Scenario: Critical memory pressure pauses streaming

- GIVEN active streaming downloads
- WHEN the memory monitor detects critical pressure
- THEN all active streaming downloads are paused
- AND the memory pressure event is fired

### Requirement: Upload Progress Tracking

The system SHALL track upload progress for resources being sent to the server, providing real-time feedback to the user.

#### Scenario: Upload progress reporting

- GIVEN server mode is active and resources are being uploaded
- WHEN each resource upload progresses
- THEN the extension reports upload progress (bytes sent / total bytes) to the UI
- AND the UI displays an upload progress bar

#### Scenario: Combined download and upload progress

- GIVEN server mode is active
- WHEN resources are being downloaded and uploaded concurrently
- THEN the extension reports both download and upload progress separately
- AND the UI shows "Downloading X/Y resources, uploading A/B to server"
