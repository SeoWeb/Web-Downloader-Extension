## MODIFIED Requirements

### Requirement: ZIP Archive Creation

The server SHALL create a ZIP archive containing the merged HTML and all uploaded resources when a session is finalized, with linked page filenames that match the link converter's output. The assembler SHALL build a content-type map from session resources and pass it to the HTML converter for content-type-aware fallback filename generation.

#### Scenario: Standard ZIP assembly

- **WHEN** a session is finalized with merged HTML and uploaded resources
- **THEN** the server creates a ZIP file using DEFLATE compression (level 6)
- **AND** the merged HTML is stored as `index.html` in the ZIP root
- **AND** each resource is stored at its designated path (e.g., `images/photo.jpg`, `styles/main.css`, `scripts/app.js`, `fonts/roboto.woff2`, `documents/report.pdf`)

#### Scenario: ZIP with linked pages

- **WHEN** a session includes linked page HTML files
- **THEN** the linked pages are stored in the `pages/` directory
- **AND** each page has an `.html` extension
- **AND** each page's filename is generated from its URL using the same algorithm as `convert_links()` (last path segment + `.html`)
- **AND** the filenames are deterministic and match the href values produced by link conversion, so internal navigation links resolve correctly

#### Scenario: ZIP with content text

- **WHEN** the session includes text content uploaded via the content endpoint
- **THEN** a `content.txt` file is included in the ZIP root
- **AND** if no content text was uploaded, no `content.txt` is included

#### Scenario: Content-type map built from resources

- **WHEN** the assembler begins URL conversion for a session
- **THEN** the assembler queries all resources for the session from the database
- **AND** builds a content-type map from `{resource.original_url: resource.content_type}` for all resources where `content_type` is not `None`
- **AND** passes this map to `convert_html()` and `convert_linked_page_html()`
