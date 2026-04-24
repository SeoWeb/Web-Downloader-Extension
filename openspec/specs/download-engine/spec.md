# Download Engine Specification

## Purpose

Core download lifecycle for the Website Downloader extension, covering how a user-initiated download request is validated, processed, and delivered as a ZIP or single HTML file.

## Requirements

### Requirement: Download Concurrency Guard

The system SHALL prevent concurrent downloads. Only one download MAY be active at a time. When server mode is active, the concurrency guard applies to the combined upload + assembly pipeline.

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

#### Scenario: Server mode session creation at download start

- GIVEN server mode is active (VITE_SERVER_URL is configured at build time)
- WHEN the user initiates a download
- THEN a server session is created before any scrolling or resource downloading begins
- AND the session ID is used for all subsequent uploads

### Requirement: Pre-Download Memory Check

The system SHALL check memory pressure before starting a download. Downloads MUST NOT start when memory pressure is critical. In server mode, the memory check is less strict because ZIP assembly and HTML merging happen on the server.

#### Scenario: Memory check in local mode

- GIVEN local mode is active and memory pressure is critical
- WHEN the user initiates a download
- THEN the download is rejected with a memory pressure error

#### Scenario: Memory check in server mode

- **GIVEN** server mode is active and memory pressure is critical
- **WHEN** the user initiates a download
- **THEN** the download is rejected with a memory pressure error (resources still need to be held in memory before upload)
- **AND** the memory rejection threshold in server mode is 100MB of available memory (vs 256MB in local mode), because ZIP assembly and HTML merging are offloaded to the server
- **AND** a non-blocking warning is displayed when available memory is between 100MB and 256MB, suggesting the user consider local-only content

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

### Requirement: Server Mode Linked Page Scraping

The system SHALL support full-website scraping in server mode, uploading linked page HTML and resources to the server with incremental filename map updates.

#### Scenario: Linked page scraping in server mode

- **GIVEN** server mode is enabled and `downloadLinksFullScraping` is true
- **WHEN** linked pages are being scraped
- **THEN** each linked page's HTML is streamed to the server with `pageType: "linked"`
- **AND** resources for each linked page are uploaded to the server via ServerStorageAdapter
- **AND** the AssetRegistry prevents duplicate uploads of resources already downloaded for the main page
- **AND** after each linked page, the filename map is incrementally updated on the server

#### Scenario: Linked page scraping with AssetRegistry deduplication

- **GIVEN** server mode is enabled and a linked page contains images already downloaded for the main page
- **WHEN** the extension processes the linked page's resources
- **THEN** the AssetRegistry identifies already-downloaded resources
- **AND** only new resources are uploaded to the server
- **AND** the existing filename map entries are reused for URL conversion
- **AND** resource preloading elements like `<link rel="preload" as="font">` are converted if the resource is present in the session, otherwise original URLs are preserved

### Requirement: Server Mode Download Lifecycle

The system SHALL support a server-mode download lifecycle where HTML chunks are streamed to the server during scrolling, resources are uploaded after download, and ZIP assembly happens on the server. The main-page scroll function SHALL report page height changes and the scroll loop SHALL use height-aware bottom detection.

#### Scenario: Full server mode download flow

- GIVEN server mode is enabled
- WHEN the user initiates a download
- THEN the system creates a server session, scrolls the page sending each HTML chunk to the server, signals scrape-complete when scrolling is done, downloads and uploads resources, uploads the filename map, uploads content text, finalizes the session, waits for assembly, and triggers a download from the server URL
- AND the scroll function reports whether the page height changed during each step via the `heightChanged` flag in `ScrollResult`

#### Scenario: HTML chunk streaming during scroll with height awareness

- GIVEN server mode is enabled and a scroll cycle completes
- WHEN the extension captures the page HTML
- THEN the HTML is immediately uploaded to the server as a chunk
- AND the HTML is not accumulated in browser memory
- AND the `ScrollResult` includes a `heightChanged` flag indicating whether `scrollHeight` changed during the scroll step

#### Scenario: Bottom detection with page growth

- GIVEN the main page is being scrolled and lazy-loaded content causes the page to grow
- WHEN the scroll position reaches the nominal bottom
- THEN the system does NOT stop scrolling if the page height increased compared to the previous step
- AND the system continues scrolling until: at bottom AND height has not changed AND scroll position has not changed for one additional iteration (settle mechanism)

#### Scenario: Layout shift during main page scrolling

- GIVEN the main page is being scrolled and content insertion causes a layout shift
- WHEN the viewport jumps upward (scrollY decreases)
- THEN the scroll function records the jump and continues scrolling
- AND the `heightChanged` flag is set to true in the `ScrollResult`

#### Scenario: Resource download then upload pipeline

- GIVEN server mode is enabled and resources are being processed
- WHEN a resource (image, CSS, JS, document) is downloaded from the origin site
- THEN the resource blob is uploaded to the server via the ServerStorageAdapter
- AND the blob is released from memory after upload confirmation

#### Scenario: Filename map upload before finalization

- GIVEN server mode is enabled and all images have been processed
- WHEN the image filename map is built
- **THEN** the map is uploaded to the server for use during HTML URL conversion
- **AND** the scrape-complete signal is sent ONCE — after ALL page scrolling is complete (main page and every linked page) AND after every previously uploaded HTML chunk has received a 200 ACK from the server; resource uploads MAY still be in progress when scrape-complete is sent
- **AND** the finalization request is sent only after: (a) scrape-complete has received a 200 ACK, (b) the upload queue is fully drained (all resource uploads complete), and (c) the filename map and content uploads have received 200 ACKs
- **AND** if finalize returns 409 (already assembling), the extension treats it as success and proceeds to polling

#### Scenario: Session transitions to uploading status

- GIVEN server mode is enabled and the scrape-complete signal has been sent
- WHEN the server processes the scrape-complete signal
- THEN the session status transitions to `uploading`
- **AND** the extension continues uploading resources
- **AND** the UI reflects the uploading state
- **AND** finalization can only be called after scrape-complete

### Requirement: Server Failure Error Handling

The system SHALL handle server failures gracefully when the server becomes unreachable during a server-mode download. The user is offered the option to fall back to local mode.

#### Scenario: Server becomes unreachable during upload

- GIVEN server mode is active and a download is in progress
- WHEN the server becomes unreachable (connection timeout or network error)
- THEN the extension displays "Server connection lost. Try again or download locally."
- AND the download is stopped
- AND the user can retry when the server is available again
- AND the user can choose to restart the download in local mode

#### Scenario: Server returns error during finalization

- GIVEN server mode is active and the finalization request fails
- WHEN the server returns a 5xx error
- THEN the extension retries the finalization up to 3 times with exponential backoff
- AND if all retries fail, the user is notified with "Server error. Try again or download locally."

#### Scenario: Assembly timeout

- GIVEN server mode is active and the session has been finalized
- WHEN the assembly polling does not reach `ready` status within 5 minutes
- THEN the extension displays "Server assembly is taking too long. Try again or download locally."
- AND the user can choose to retry or fall back to local mode

#### Scenario: Server error categorization

- GIVEN server mode is active and a server-related error occurs
- WHEN the error is processed
- THEN a server error category is used (distinct from memory or network errors)
- AND the error message includes whether the server was unreachable, returned an error, or timed out
- AND the user is offered the option to fall back to local mode
