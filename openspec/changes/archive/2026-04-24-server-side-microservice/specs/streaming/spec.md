## MODIFIED Requirements

### Requirement: Streaming Download Eligibility

The system SHALL determine whether a resource should be downloaded using streaming based on file size and type. In server mode, the streaming downloader is still used for fetching large resources from origin sites, but the resulting data is uploaded to the server rather than stored in split ZIP parts.

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

## ADDED Requirements

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
