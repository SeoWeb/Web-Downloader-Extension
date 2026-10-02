# Streaming Specification

## Purpose

Upload progress tracking for the Website Downloader extension. Covers how resource upload progress is reported to the user during server-mode downloads.

## Requirements

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
