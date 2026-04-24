## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Server Mode Download Lifecycle

The system SHALL support a server-mode download lifecycle where HTML chunks are streamed to the server during scrolling, resources are uploaded after download, and ZIP assembly happens on the server.

#### Scenario: Full server mode download flow

- GIVEN server mode is enabled
- WHEN the user initiates a download
- THEN the system creates a server session, scrolls the page sending each HTML chunk to the server, signals scrape-complete when scrolling is done, downloads and uploads resources, uploads the filename map, uploads content text, finalizes the session, waits for assembly, and triggers a download from the server URL

#### Scenario: HTML chunk streaming during scroll

- GIVEN server mode is enabled and a scroll cycle completes
- WHEN the extension captures the page HTML
- THEN the HTML is immediately uploaded to the server as a chunk
- AND the HTML is not accumulated in browser memory

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
