## MODIFIED Requirements

### Requirement: Linked Page Content Text Extraction

The system SHALL extract body text content from each scraped page — the main page and every linked page — when the "Download content as text" option is enabled, using a per-page model: each page's text SHALL be extracted and uploaded immediately after that page's scrape, with no whole-run text accumulation held in memory. The main page's text SHALL be uploaded first, before linked-page scraping begins, and each subpage's text SHALL follow in scrape order. In server mode, the upload target SHALL be the per-page content endpoint `POST /{session_id}/content/pages` with a `{page_url, text}` payload (a null `page_url` identifies the main page); the server SHALL store the text keyed by `page_url_hash` with replace-on-rewrite semantics. The legacy append endpoint SHALL remain available for older clients but SHALL no longer be used by the current extension.

#### Scenario: Content text extracted per page immediately

- **WHEN** a page is scraped (main or linked) and the downloadContentAsText option is enabled
- **THEN** the body text is extracted from the page's HTML using the same text extraction method as the main page
- **AND** the text is uploaded immediately after that page's scrape rather than accumulated until the end of the run

#### Scenario: Main page text is uploaded before linked scraping

- **WHEN** a download with text extraction enabled reaches content extraction
- **THEN** the main page's text is uploaded first, before linked-page scraping begins
- **AND** each subpage's text follows in scrape order, so the artifact reading order is main-first

#### Scenario: Per-page text kept per page in local mode

- **WHEN** pages are scraped in local mode and the downloadContentAsText option is enabled
- **THEN** each page's text is kept as a per-page document (main page first, subpages in scrape order) instead of being accumulated into one delimited blob
- **AND** the per-page documents are handed to packaging, which produces one text file per page

#### Scenario: Per-page text uploaded to the per-page content endpoint in server mode

- **WHEN** a page's text is uploaded in server mode
- **THEN** it is sent to `POST /{session_id}/content/pages` with `{page_url, text}` (null `page_url` for the main page)
- **AND** the server stores the text keyed by `page_url_hash` with replace-on-rewrite semantics
- **AND** the legacy append endpoint is not used by the current extension (it remains for older clients)

#### Scenario: Per-page re-upload replaces without duplicating

- **WHEN** the same page's text is uploaded again (for example after a retry or a resume-from-park)
- **THEN** the stored text for that page's `page_url_hash` is replaced
- **AND** no duplicate page section appears in the stored content

#### Scenario: One page's text upload failure does not fail the run

- **WHEN** a single page's text upload fails
- **THEN** the failure is surfaced among the run's failures
- **AND** scraping and the remaining page uploads continue

#### Scenario: Content text not extracted when option disabled

- **WHEN** the downloadContentAsText option is disabled
- **THEN** no per-page text is extracted or uploaded for any page, including the main page
