## MODIFIED Requirements

### Requirement: Linked Page Filename Generation
The system SHALL NOT perform client-side filename collision resolution for linked pages. The server handles filename generation and collision resolution during assembly. Linked page HTML chunks SHALL be uploaded with `pageType: "linked"` and `pageUrl` metadata for server-side processing.

#### Scenario: Linked page chunk uploaded to server
- **WHEN** a linked page is scraped
- **THEN** the system uploads the page's HTML chunks to the server with `pageType: "linked"` and the page's final URL as `pageUrl`
- **AND** the server handles filename generation and cross-page link conversion

#### Scenario: Incremental filename map uploaded after linked page
- **WHEN** a linked page's assets are downloaded
- **THEN** the system uploads a delta filename map containing only new entries not in the global map
