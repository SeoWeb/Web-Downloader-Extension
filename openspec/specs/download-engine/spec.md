# Download Engine Specification

## Purpose

Core download lifecycle for the Website Downloader extension, covering how a user-initiated download request is validated, processed, and delivered as a ZIP or single HTML file.

## Requirements

### Requirement: Download Concurrency Guard

The system SHALL prevent concurrent downloads. Only one download MAY be active at a time.

#### Scenario: Download rejected when another is active

- GIVEN a download is already in progress
- WHEN the user initiates a new download
- THEN the system rejects the request with a "download in progress" error
- AND the existing download continues unaffected

#### Scenario: Download flag reset after completion

- GIVEN a download has completed (success or failure)
- WHEN the cleanup routine runs
- THEN the download-in-progress flag is cleared
- AND a new download can be initiated

### Requirement: Pre-Download Memory Check

The system SHALL check memory pressure before starting a download. Downloads MUST NOT start when memory pressure is critical.

#### Scenario: Critical memory pressure blocks download

- GIVEN memory pressure level is critical
- WHEN a download is initiated
- THEN the system rejects the request with a memory pressure error
- AND no download resources are allocated

#### Scenario: Normal memory allows download

- GIVEN memory pressure level is not critical
- WHEN a download is initiated
- THEN the download proceeds normally

### Requirement: Download Mode Selection

The system SHALL support two download modes: ZIP archive and single HTML file, controlled by the `singleFile` filter option.

#### Scenario: ZIP archive mode

- GIVEN the singleFile option is false
- WHEN the download completes
- THEN all resources are packaged into a ZIP file
- AND the filename ends with `.zip`

#### Scenario: Single HTML file mode

- GIVEN the singleFile option is true
- WHEN the download completes
- THEN the page is converted to a self-contained HTML file
- AND the filename ends with `.html`
- AND all resources are inlined into the HTML

### Requirement: Resource Processing Pipeline

The system SHALL process resources in a specific order: images first, then HTML, then assets (CSS/JS), then documents, then links, then content text.

#### Scenario: All resource types enabled

- GIVEN all filter options are enabled (HTML, images, assets, documents, links, text)
- WHEN a download is executed
- THEN images are downloaded first to determine correct filenames
- AND HTML is processed second using the image filename map
- AND CSS and JS assets are downloaded third
- AND documents are downloaded fourth
- AND links are processed fifth
- AND content text is extracted last

#### Scenario: Only HTML enabled

- GIVEN only the downloadHTML option is enabled
- WHEN a download is executed
- THEN only the HTML file is included in the output
- AND no images, assets, documents, or links are processed

### Requirement: Linked Page Full Scraping

The system SHALL support full scraping of linked pages when the `downloadLinksFullScraping` option is enabled.

#### Scenario: Full scraping enabled with linked pages

- GIVEN downloadLinks is true and downloadLinksFullScraping is true
- WHEN a download is executed
- THEN each discovered link is added to a scraping queue
- AND linked pages are scraped sequentially with a configurable delay
- AND assets from the main page are registered to avoid duplicate downloads
- AND the image filename map from the main page is shared with linked pages

#### Scenario: Full scraping disabled

- GIVEN downloadLinks is true and downloadLinksFullScraping is false
- WHEN a download is executed
- THEN only the link URLs are saved as HTML files without full resource scraping

### Requirement: Incremental HTML Assembly

The system SHALL support incremental HTML assembly for large pages, where HTML is collected in chunks during scrolling and assembled before download.

#### Scenario: Incremental assembly success

- GIVEN an assembly job ID is provided
- WHEN the download is executed
- THEN the system finalizes the incremental merge
- AND the assembled HTML is used as the index file

#### Scenario: Incremental assembly failure fallback

- GIVEN an assembly job ID is provided
- AND the incremental merge fails
- WHEN the download is executed
- THEN the system falls back to regular HTML processing
- AND the original HTML is used as the index file

### Requirement: Network Connectivity Check

The system SHALL check network connectivity before starting resource downloads.

#### Scenario: No internet connection

- GIVEN the network connectivity check fails
- WHEN the download starts
- THEN the system warns the user about no internet
- AND if only HTML download is enabled, continues with basic HTML
- AND if other resource types are required, aborts with an error

#### Scenario: Network check succeeds

- GIVEN the network connectivity check succeeds
- WHEN the download starts
- THEN the download proceeds normally without a network warning

### Requirement: Download Filename Generation

The system SHALL generate safe, descriptive filenames from the page URL.

#### Scenario: Standard URL

- GIVEN a page URL of `https://www.example.com/path/to/page`
- WHEN the filename is generated
- THEN the domain prefix `www.` is stripped
- AND the path parts are joined with hyphens
- AND a timestamp is appended
- AND the filename does not exceed 200 characters

#### Scenario: URL with special characters

- GIVEN a page URL containing special characters
- WHEN the filename is generated
- THEN special characters in the hostname are replaced with underscores
- AND special characters in the path are replaced with hyphens

### Requirement: Download State Tracking

The system SHALL track active downloads and manage a service worker keepalive connection.

#### Scenario: Download starts tracking

- GIVEN a download is initiated
- WHEN the Chrome download API starts
- THEN the download ID and filename are stored in the active downloads map
- AND a keepalive port connection is established if not already present

#### Scenario: Download completes

- GIVEN a tracked download
- WHEN Chrome reports the download state as complete
- THEN the completion info is stored in chrome.storage.local
- AND a completion message is sent to the side panel
- AND the download is removed from the active downloads map
- AND the keepalive port is disconnected when no active downloads remain

#### Scenario: Download interrupted by error

- GIVEN a tracked download
- WHEN Chrome reports the download state as interrupted with a non-user error
- THEN a failure message is sent to the side panel
- AND the download is removed from tracking

#### Scenario: Download cancelled by user

- GIVEN a tracked download
- WHEN Chrome reports the download as interrupted with USER_CANCELED
- OR the download is erased from Chrome history
- THEN a cancellation message is sent to the side panel
- AND blob URLs are revoked
- AND the download is removed from tracking

### Requirement: Error Categorization

The system SHALL categorize download errors and provide user-friendly messages.

#### Scenario: Memory-related error

- GIVEN an error occurs during download
- AND the error message contains "memory", "size", "limit", or "quota"
- WHEN the error is processed
- THEN a memory limit error message is displayed
- AND the memory manager performs forced cleanup

#### Scenario: Network-related error

- GIVEN an error occurs during download
- AND the error message contains "network", "fetch", "connection", or "offline"
- WHEN the error is processed
- THEN a network error message is displayed

#### Scenario: Panel unavailable error

- GIVEN the side panel is closed during a multi-part download
- WHEN the panel check fails
- THEN a panel unavailable error message is displayed
- AND the download is aborted

### Requirement: Post-Download Cleanup

The system SHALL clean up resources after every download, regardless of success or failure.

#### Scenario: Successful download cleanup

- GIVEN a download completes successfully
- WHEN the cleanup routine runs
- THEN download-specific blobs are cleaned up
- AND the request queue is cleared
- AND the download-in-progress flag is reset

#### Scenario: Failed download cleanup

- GIVEN a download fails with an error
- WHEN the cleanup routine runs
- THEN all cleanup actions still execute
- AND the download-in-progress flag is still reset

### Requirement: Service Worker Lifecycle Cleanup

The system SHALL handle cleanup during service worker lifecycle events.

#### Scenario: Service worker startup with interrupted download

- GIVEN the service worker restarts
- AND a download was in progress before the restart
- WHEN the startup cleanup runs
- THEN the download-in-progress flag is reset
- AND all orphaned blobs are cleaned up
- AND forced memory cleanup is performed

#### Scenario: Service worker shutdown

- GIVEN the service worker is about to be suspended
- WHEN the beforeunload event fires
- THEN the memory manager performs an emergency shutdown

#### Scenario: Periodic memory monitoring

- GIVEN the service worker is running
- WHEN the 30-second monitoring interval triggers
- AND memory pressure is critical
- THEN forced cleanup is performed
- AND blob age threshold is reduced to 25% of normal
