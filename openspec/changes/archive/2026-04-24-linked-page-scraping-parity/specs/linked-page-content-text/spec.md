## ADDED Requirements

### Requirement: Linked Page Content Text Extraction

The system SHALL extract body text content from each scraped linked page, in addition to the main page, when the "Download content as text" option is enabled.

#### Scenario: Content text extracted from a linked page

- **WHEN** a linked page is scraped and the downloadContentAsText option is enabled
- **THEN** the system extracts the body text from the linked page's HTML using the same text extraction method as the main page
- **AND** the text is accumulated with a page-URL delimiter identifying the source page

#### Scenario: Content text appended to storage in local mode

- **WHEN** all linked pages have been scraped in local mode
- **AND** the downloadContentAsText option is enabled
- **THEN** the accumulated linked page text is appended to the storage alongside the main page's content.txt
- **AND** each page's text section is prefixed with a delimiter line containing the page URL

#### Scenario: Content text uploaded to server in server mode

- **WHEN** all linked pages have been scraped in server mode
- **AND** the downloadContentAsText option is enabled
- **THEN** the accumulated linked page text is uploaded via the existing uploadContent endpoint
- **AND** the text is appended after the main page's content with page-URL delimiters

#### Scenario: Content text not extracted when option disabled

- **WHEN** the downloadContentAsText option is disabled
- **THEN** no text content is extracted or stored for any linked page
