## MODIFIED Requirements

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
- AND the asset is registered in the registry using the same path prefix convention as the main page
