# Linked Pages Specification

## Purpose

Multi-page crawling and scraping for the Website Downloader extension. Covers how linked pages are discovered, queued, scraped, and their assets deduplicated across the main page and all linked pages.

## Requirements

### Requirement: Linked Page Queue Management

The system SHALL maintain a queue of linked pages to scrape, with configurable limits.

#### Scenario: Adding a same-origin link to queue

- GIVEN a URL that shares the same hostname as the parent page
- AND the queue has not reached the maximum page limit
- WHEN the URL is added to the queue
- THEN the URL is enqueued with status "queued"

#### Scenario: Rejecting external links when not enabled

- GIVEN the includeExternal option is false
- AND a URL with a different hostname than the parent page
- WHEN the URL is added to the queue
- THEN the URL is rejected and not enqueued

#### Scenario: Accepting external links when enabled

- GIVEN the includeExternal option is true
- AND a URL with a different hostname than the parent page
- WHEN the URL is added to the queue
- THEN the URL is enqueued

#### Scenario: Queue size limit

- GIVEN the queue has reached the maximum page limit
- WHEN a new URL is added to the queue
- THEN the URL is rejected

#### Scenario: Duplicate URL rejection

- GIVEN a URL is already present in the queue
- WHEN the same URL is added again
- THEN the duplicate is rejected

#### Scenario: Non-HTML resource rejection

- GIVEN a URL ending with a known non-HTML extension (e.g., .pdf, .jpg, .zip, .mp4)
- WHEN the URL is added to the queue
- THEN the URL is rejected

### Requirement: Sequential Page Scraping

The system SHALL process queued pages sequentially in the same browser tab.

#### Scenario: Successful page scrape

- GIVEN a queued page URL
- WHEN the page is processed
- THEN the tab navigates to the URL and waits for the page to load
- AND the page is scrolled to trigger lazy loading
- AND the rendered DOM is captured
- AND resources are extracted from the captured DOM
- AND new assets are downloaded (skipping already-registered assets)
- AND the HTML is converted with relative paths using the `../` prefix
- AND the page is saved to the `pages/` folder

#### Scenario: Page navigation timeout

- GIVEN a queued page URL that takes longer than the configured timeout
- WHEN the tab navigates to the URL
- THEN a navigation timeout error is raised
- AND the page is marked as failed

#### Scenario: DOM capture failure

- GIVEN a page that cannot be captured via script execution
- WHEN the DOM capture is attempted
- THEN a capture failure error is raised
- AND the page is marked as failed

### Requirement: Cross-Page Asset Deduplication

The system SHALL avoid downloading the same asset multiple times across the main page and all linked pages, using consistent path prefixes for asset registration.

#### Scenario: Asset already downloaded by main page

- GIVEN an asset URL that was already downloaded during the main page processing
- WHEN a linked page references the same asset URL
- THEN the asset download is skipped
- AND the asset is registered in the registry using the same path prefix as the main page (e.g., `styles/`, `scripts/`, `images/`, `documents/`)

#### Scenario: Asset downloaded by a previous linked page

- GIVEN an asset URL that was downloaded during an earlier linked page scrape
- WHEN another linked page references the same asset URL
- THEN the asset download is skipped
- AND the previously downloaded version is reused

#### Scenario: New asset unique to a linked page

- GIVEN an asset URL not yet in the registry
- WHEN a linked page references the asset
- THEN the asset is downloaded
- AND the asset is registered in the registry

### Requirement: Image Filename Map Sharing

The system SHALL share the image filename map from the main page across all linked pages to ensure consistent filename references.

#### Scenario: Linked page references main page image

- GIVEN a linked page containing an image that was already downloaded by the main page
- WHEN the linked page HTML is converted
- THEN the image filename map from the main page is consulted
- AND the correct filename (including proper extension from Content-Type) is used in the HTML

#### Scenario: Linked page has its own unique images

- GIVEN a linked page containing images not present in the main page
- WHEN the linked page is processed
- THEN new images are downloaded
- AND their filenames are added to both the local and global image filename maps

### Requirement: Scraper Pause, Resume, and Stop

The system SHALL support pausing, resuming, and stopping the scraping process.

#### Scenario: Pausing the scraper

- GIVEN the scraper is actively processing pages
- WHEN the pause command is issued
- THEN the scraper stops processing new pages after the current page completes
- AND a pause status message is sent

#### Scenario: Resuming the scraper

- GIVEN the scraper is paused
- WHEN the resume command is issued
- THEN the scraper continues processing the remaining pages in the queue

#### Scenario: Stopping the scraper

- GIVEN the scraper is actively processing pages
- WHEN the stop command is issued
- THEN the scraper stops processing immediately
- AND a stop status message is sent
- AND if the scraper was paused, it is resumed first so the loop can exit

### Requirement: Delay Between Page Scrapes

The system SHALL enforce a configurable delay between page scrapes to avoid rate limiting.

#### Scenario: Delay between pages

- GIVEN a configurable delay of 500ms between pages
- AND a page has just finished scraping
- WHEN there are more pages in the queue
- THEN the scraper waits the configured delay before processing the next page

#### Scenario: No delay after last page

- GIVEN the last page in the queue has been processed
- THEN no additional delay is applied

### Requirement: Original Page Restoration

The system SHALL restore the browser tab to the original page URL after scraping completes.

#### Scenario: Successful restoration

- GIVEN the scraper has finished processing all pages
- WHEN the scraping queue is empty or stopped
- THEN the browser tab navigates back to the original page URL

#### Scenario: Restoration failure

- GIVEN the scraper has finished processing all pages
- AND the tab navigation back fails
- THEN the error is silently ignored as it is non-critical

### Requirement: Lazy Loading Support

The system SHALL scroll linked pages to trigger lazy-loaded content before capturing the DOM, using a two-pass scroll strategy for improved coverage.

#### Scenario: Page with lazy-loaded images

- GIVEN a linked page with images that load on scroll
- WHEN the page is scraped
- THEN the page is scrolled from top to bottom in viewport-height increments with a 300ms settle time per step
- AND after reaching the bottom, a 500ms settle delay is observed
- AND a second quick scroll pass is performed from top to bottom
- AND after the second pass, the DOM is captured

#### Scenario: Page with IntersectionObserver-based loading

- GIVEN a linked page with content that loads via IntersectionObserver
- WHEN the page is scraped
- THEN the two-pass scroll strategy allows sufficient viewport time for observers to fire
- AND dynamically loaded content is present in the captured DOM

### Requirement: Scraping Statistics

The system SHALL provide statistics on the scraping process.

#### Scenario: Querying statistics

- GIVEN the scraper has processed some pages
- WHEN statistics are queried
- THEN the total queue length is returned
- AND the count of succeeded pages is returned
- AND the count of failed pages is returned
- AND the count of pending pages is returned

### Requirement: Linked Page Filename Generation

The system SHALL generate safe HTML filenames for scraped linked pages that are deterministic and consistent with the link converter's filename generation, in both local and server modes.

#### Scenario: URL with path

- GIVEN a linked page URL of `https://example.com/about/team`
- WHEN the filename is generated
- THEN the last path segment is used as the base name
- AND the `.html` extension is appended if not already present
- AND special characters are replaced with safe alternatives
- AND the same filename is used for both the stored page file and the href in link conversion

#### Scenario: URL with no path

- GIVEN a linked page URL of `https://example.com/`
- WHEN the filename is generated
- THEN a default filename of `page.html` is used

#### Scenario: Filename collision between linked pages

- GIVEN two linked page URLs that produce the same base filename (e.g., `/about/team` and `/contact/team`)
- WHEN filenames are generated for both pages
- THEN the second page's filename includes a short hash suffix to disambiguate (e.g., `team-a1b2.html`)
- AND the same collision-avoidance logic is applied in both the extension and the server assembler
