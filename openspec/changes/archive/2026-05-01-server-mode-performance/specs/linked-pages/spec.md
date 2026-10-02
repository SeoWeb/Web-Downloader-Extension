## MODIFIED Requirements

### Requirement: Concurrent HTML Chunk Uploads

In server mode, the system SHALL upload HTML chunks for a linked page concurrently using `Promise.all`, instead of uploading them one at a time sequentially.

#### Scenario: Multiple chunks uploaded concurrently
- **GIVEN** a linked page's DOM is captured as 4 HTML chunks (512KB each)
- **WHEN** the chunks are uploaded to the server in server mode
- **THEN** all 4 chunks are uploaded simultaneously via `Promise.all`
- **AND** each chunk includes its correct `scrollIndex` for server-side ordering

#### Scenario: Single chunk page has no parallelism overhead
- **GIVEN** a linked page's DOM fits in a single HTML chunk
- **WHEN** the chunk is uploaded
- **THEN** it is uploaded normally without `Promise.all` wrapping

### Requirement: Reduced Inter-Page Delay

The default delay between processing linked pages SHALL be 200ms instead of 500ms. This delay remains configurable.

#### Scenario: Default delay is 200ms
- **GIVEN** a LinkedPageScraper is created without explicit `delayBetweenPages`
- **WHEN** the scraper processes pages
- **THEN** it waits 200ms between completing one page and starting the next

#### Scenario: Custom delay is respected
- **GIVEN** a LinkedPageScraper is created with `delayBetweenPages: 1000`
- **WHEN** the scraper processes pages
- **THEN** it waits 1000ms between pages
