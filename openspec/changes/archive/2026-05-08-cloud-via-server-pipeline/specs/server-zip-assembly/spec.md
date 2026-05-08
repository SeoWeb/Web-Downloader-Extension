## ADDED Requirements

### Requirement: Cloud-only assembly branch
When a session has `pagepocket_user_id` set, the assembly pipeline SHALL skip ZIP/HTML file creation and instead push the processed data to PagePocket via gRPC after completing phases 1-3 (HTML merge, URL conversion, CSS conversion).

#### Scenario: Cloud-only session with ZIP mode
- **WHEN** a session has `pagepocket_user_id` set and `singleFile` is false
- **THEN** the assembler SHALL complete HTML merging, URL conversion, CSS conversion, and CSS inlining as normal
- **AND** SHALL NOT create a ZIP file
- **AND** SHALL encode the processed `main_html` as UTF-8 bytes
- **AND** SHALL read all session resources from disk with their processed content
- **AND** SHALL append linked page HTML files as assets with `pages/` prefixed paths
- **AND** SHALL call `push_to_archive()` with the user ID, session ID, URL, title, processed HTML, and all assets
- **AND** SHALL set `session.status = "ready"`, `session.cloud_page_id` to the returned page ID
- **AND** SHALL NOT set `session.zip_path`

#### Scenario: Cloud-only session with single-file mode
- **WHEN** a session has `pagepocket_user_id` set and `singleFile` is true
- **THEN** the assembler SHALL produce the single-file HTML with all resources inlined
- **AND** SHALL read the resulting HTML from disk
- **AND** SHALL call `push_to_archive()` with the inlined HTML and no assets
- **AND** SHALL delete the local HTML file after successful push
- **AND** SHALL set `session.status = "ready"`, `session.cloud_page_id`
- **AND** SHALL NOT set `session.zip_path`

#### Scenario: Cloud push failure
- **WHEN** `push_to_archive()` returns an error after all retry attempts
- **THEN** the assembler SHALL set `session.cloud_status = "failed"` and `session.cloud_error` to the error message
- **AND** SHALL set `session.status = "ready"` (so the extension can read the error)
- **AND** SHALL NOT set `session.zip_path`

### Requirement: Cloud push uses processed HTML
The cloud push SHALL send the fully-processed HTML (merged chunks, URL-rewritten, CSS-inlined) as `html_content`, NOT the ZIP file bytes.

#### Scenario: Processed HTML sent to PagePocket
- **WHEN** the cloud push assembles the gRPC request
- **THEN** `html_content` SHALL be the processed `main_html` string encoded as UTF-8
- **AND** assets SHALL include all session resources with their converted content
- **AND** `extension_job_id` SHALL be the session UUID for idempotency

## MODIFIED Requirements

### Requirement: ZIP Archive Creation
The server SHALL create a ZIP archive containing the merged HTML and all uploaded resources when a session is finalized **and the session does not have `pagepocket_user_id` set**, with linked page filenames that match the link converter's output. The assembler SHALL build a content-type map from session resources and pass it to the HTML converter for content-type-aware fallback filename generation.

#### Scenario: Standard ZIP assembly (non-cloud session)
- **WHEN** a session is finalized with merged HTML and uploaded resources **and `pagepocket_user_id` is NULL**
- **THEN** the server creates a ZIP file using DEFLATE compression (level 6)
- **AND** the merged HTML is stored as `index.html` in the ZIP root
- **AND** each resource is stored at its designated path (e.g., `images/photo.jpg`, `styles/main.css`, `scripts/app.js`, `fonts/roboto.woff2`, `documents/report.pdf`)

#### Scenario: ZIP with linked pages (non-cloud session)
- **WHEN** a session includes linked page HTML files **and `pagepocket_user_id` is NULL**
- **THEN** the linked pages are stored in the `pages/` directory
- **AND** each page has an `.html` extension
- **AND** each page's filename is generated from its URL using the same algorithm as `convert_links()` (last path segment + `.html`)
- **AND** the filenames are deterministic and match the href values produced by link conversion, so internal navigation links resolve correctly

#### Scenario: ZIP with content text (non-cloud session)
- **WHEN** the session includes text content uploaded via the content endpoint **and `pagepocket_user_id` is NULL**
- **THEN** a `content.txt` file is included in the ZIP root
- **AND** if no content text was uploaded, no `content.txt` is included

#### Scenario: Content-type map built from resources
- **WHEN** the assembler begins URL conversion for a session
- **THEN** the assembler queries all resources for the session from the database
- **AND** builds a content-type map from `{resource.original_url: resource.content_type}` for all resources where `content_type` is not `None`
- **AND** passes this map to `convert_html()` and `convert_linked_page_html()`
