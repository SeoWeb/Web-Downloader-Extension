## Requirements

### Requirement: Cloud-only upload replaces local ZIP download
When cloud storage is enabled and the user is authenticated, the download pipeline SHALL skip local ZIP generation and instead upload the page's HTML and assets directly to PagePocket. No local file SHALL be saved to the user's disk.

#### Scenario: Cloud upload flow replaces local download
- **GIVEN** cloud storage is toggled ON and the user is authenticated
- **WHEN** the user clicks "Start download"
- **THEN** the extension scrapes the page as normal (HTML, images, assets, documents)
- **AND** skips ZIP creation and `chrome.downloads.download()`
- **AND** uploads the HTML content and all assets to PagePocket via `POST /api/v1/archive/pages/ingest`
- **AND** the completion UI shows "Saved to PagePocket" instead of "Show in Folder"

#### Scenario: Local download when cloud OFF
- **GIVEN** cloud storage is toggled OFF
- **WHEN** the user clicks "Start download"
- **THEN** the standard local download pipeline runs unchanged (ZIP creation, file save dialog)

#### Scenario: Local download when cloud ON but not authenticated
- **GIVEN** cloud storage is toggled ON but the user is not authenticated
- **WHEN** the user clicks "Start download"
- **THEN** the download button is disabled or triggers the auth form
- **AND** no download starts until the user authenticates

### Requirement: Upload data format
The cloud upload SHALL send page data as `multipart/form-data` to the PagePocket ingest endpoint with the HTML content and each asset as separate file parts.

#### Scenario: Multipart upload with assets
- **GIVEN** a page has HTML content, 3 CSS files, 2 JS files, and 5 images
- **WHEN** the cloud upload executes
- **THEN** the request contains `url`, `title`, `extension_job_id` as form fields
- **AND** `html_content` as a file blob containing the full HTML
- **AND** 10 asset files with their original filenames and content types

#### Scenario: Idempotent uploads
- **GIVEN** a page was previously uploaded with `extension_job_id` "job-123"
- **WHEN** the same `extension_job_id` is sent again
- **THEN** the backend returns the existing `page_id` without creating a duplicate

### Requirement: Upload progress tracking
The extension SHALL display upload progress in the DownloadStatus/DownloadComplete UI while the cloud upload is in progress.

#### Scenario: Upload progress shown
- **GIVEN** a cloud upload is in progress
- **WHEN** bytes are transferred to the PagePocket API
- **THEN** the UI shows "Uploading to PagePocket..." with a progress indicator
- **AND** progress messages are sent from the background service worker to the sidepanel via `PANEL_MESSAGE`

#### Scenario: Upload completes successfully
- **GIVEN** a cloud upload completes
- **WHEN** the PagePocket API returns `{ success: true, page_id: "..." }`
- **THEN** the UI shows "Saved to PagePocket" with the page ID
- **AND** a "View in PagePocket" link is displayed

#### Scenario: Upload fails with quota exceeded
- **GIVEN** a cloud upload is attempted
- **WHEN** the PagePocket API returns 402 (quota exceeded)
- **THEN** the UI shows "PagePocket storage quota exceeded"
- **AND** the error message includes the quota limit

#### Scenario: Upload fails with network error
- **GIVEN** a cloud upload is in progress
- **WHEN** the network connection is lost
- **THEN** the UI shows "Upload failed: network error" with a "Retry upload" button
- **AND** the retry re-attempts the upload with the same `extension_job_id`

### Requirement: Upload does not affect local download when cloud is OFF
When cloud storage is OFF, no PagePocket-related code SHALL execute during the download pipeline.

#### Scenario: No cloud code runs when cloud OFF
- **GIVEN** cloud storage is toggled OFF
- **WHEN** a local download completes
- **THEN** no PagePocket API calls are made
- **AND** no cloud upload messages are sent to the sidepanel

### Requirement: Download concurrency with cloud mode
Cloud uploads SHALL use per-tab concurrency tracking (same as server mode), allowing concurrent uploads from different tabs.

#### Scenario: Concurrent cloud uploads from different tabs
- **GIVEN** cloud mode is ON and Tab A is uploading a page
- **WHEN** the user starts a download on Tab B
- **THEN** the Tab B upload is allowed to proceed concurrently

#### Scenario: Cloud upload blocked for same tab
- **GIVEN** cloud mode is ON and Tab A is uploading a page
- **WHEN** the user tries to start another download on Tab A
- **THEN** the request is rejected with "download in progress" error
