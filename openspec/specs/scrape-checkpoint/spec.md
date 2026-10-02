# Scrape Checkpoint Specification

## Purpose

Manages interrupt checkpoints during active downloads, enabling detection of interrupted downloads after service worker restarts.

## Requirements

### Requirement: Checkpoint written at download start
The system SHALL persist an interrupt checkpoint to `chrome.storage.session` immediately after the keepalive port is established in `downloadResources()`. The checkpoint SHALL contain: `downloadInterrupted: true`, `serverSessionId` (if server mode), `tabId`, `tabUrl`, `timestamp`, `phase` (initially "scraping"), and `resourceUrls` (an array of `{ url, path, contentType }` objects populated after resource extraction).

#### Scenario: Checkpoint written in local mode
- **WHEN** a download starts in local mode
- **THEN** a checkpoint is written to `chrome.storage.session` with `phase: "scraping"`, `tabId`, `tabUrl`, `timestamp`, and no `serverSessionId`

#### Scenario: Checkpoint written in server mode
- **WHEN** a download starts in server mode
- **THEN** a checkpoint is written to `chrome.storage.session` with `phase: "scraping"`, `tabId`, `tabUrl`, `timestamp`, and the active `serverSessionId`

#### Scenario: Checkpoint updated with resource URLs after extraction
The system SHALL persist resource URLs to the checkpoint at two points: (1) after main-page resource processing completes (`processImages`, `processAssets`, `processDocuments` settle and filename map is uploaded), and (2) after all resource extraction completes (including linked pages). The first save ensures the checkpoint is populated before linked-page processing, which is the longest-running phase and the most likely point for service worker termination. The second save overwrites with the complete superset including linked-page resources.

##### Scenario: Checkpoint saved after main-page resource processing
- **WHEN** `processImages`, `processAssets`, and `processDocuments` have settled and the filename map has been uploaded
- **THEN** the checkpoint is updated with `resourceUrls` containing all main-page discovered resource metadata (images, assets, documents)
- **AND** each entry includes `url` (original URL), `path` (ZIP path), and `contentType` (MIME type)
- **AND** this occurs BEFORE linked-page processing begins

##### Scenario: Checkpoint overwritten after all resource extraction
- **WHEN** resource extraction completes (after `processImages`, `processAssets`, `processDocuments`, and `processLinks`/linked-page processing settle)
- **THEN** the checkpoint is updated with the complete `resourceUrls` array containing all discovered resource metadata (main page + linked pages)
- **AND** this overwrites the earlier progressive save with a superset

##### Scenario: No main-page resources discovered
- **WHEN** `processImages`, `processAssets`, and `processDocuments` settle but no resources were enqueued
- **THEN** no progressive checkpoint save occurs (the `resourceUrls` array would be empty)
- **AND** the final save after all extraction still runs if linked pages discover resources

### Requirement: Checkpoint phase updated during download lifecycle
The system SHALL update the checkpoint's `phase` field as the download progresses through phases: "scraping" → "uploading" → "assembling" (server mode) or "scraping" → "packing" (local mode).

#### Scenario: Phase updated when entering upload phase
- **WHEN** the download flow sends `status.waitingForUploads` or `status.sendingScrapeComplete`
- **THEN** the checkpoint phase is updated to "uploading"

#### Scenario: Phase updated when entering assembly phase
- **WHEN** the download flow sends `status.assemblingServer` or `status.finalizingServer`
- **THEN** the checkpoint phase is updated to "assembling"

### Requirement: Checkpoint cleared on download completion or failure
The system SHALL clear the checkpoint from `chrome.storage.session` in the `finally` block of `downloadResources()`.

#### Scenario: Checkpoint cleared on success
- **WHEN** a download completes successfully
- **THEN** the checkpoint entry is removed from `chrome.storage.session`

#### Scenario: Checkpoint cleared on failure
- **WHEN** a download fails with an error
- **THEN** the checkpoint entry is removed from `chrome.storage.session`

#### Scenario: Checkpoint cleared on user stop
- **WHEN** the user presses Stop during a download
- **THEN** the checkpoint entry is removed from `chrome.storage.session`
