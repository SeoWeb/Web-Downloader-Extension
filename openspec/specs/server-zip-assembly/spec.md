# Server ZIP Assembly Specification

## Purpose

Server-side ZIP archive and single-file HTML assembly for the Website Downloader microservice. Covers ZIP creation, file path handling, single-file mode, assembly error handling, and progress reporting.

## Requirements

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

### Requirement: ZIP Filename & Path Generation

The server SHALL generate a safe filename for the ZIP archive from the original URL, and SHALL sanitize all file paths provided by the client (e.g., in the filename map) to prevent path traversal outside the intended ZIP directory structure.

#### Scenario: URL with hostname and path

- **WHEN** the session URL is `https://example.com/docs/guide`
- **THEN** the ZIP filename is formatted as `example.com-docs-guide-<timestamp>.zip`

#### Scenario: URL with special characters

- **WHEN** the session URL contains special characters in the hostname or path
- **THEN** special characters are replaced with underscores (hostname) or hyphens (path)
- **AND** the filename does not exceed 200 characters

### Requirement: Single File HTML Mode

The server SHALL support generating a single HTML file instead of a ZIP when the single-file option is specified.

#### Scenario: Single file mode assembly

- **WHEN** a session is finalized with the `singleFile` option enabled
- **THEN** the server inlines all CSS, JS, and images as base64 data URIs in the HTML (as specified in the Single-File HTML Inlining requirement of server-html-converter)
- **AND** any linked pages uploaded during full-website scraping are ignored, mimicking the existing client-side logic
- **AND** the output is a single `.html` file served directly (not ZIPped)
- **AND** font resources referenced in CSS are also inlined as base64 data URIs
- **AND** if text content was uploaded for `content.txt`, it is embedded in the HTML as a UTF-8 plain-text block at the end of the `<body>` using delimited comments:
  ```html
  <!-- content-txt-start -->
  <plain
    text
    content
    here,
    with
    `--`
    replaced
    by
    `&#45;&#45;`
    to
    prevent
    breaking
    the
    HTML
    comment
  >
    <!-- content-txt-end --></plain
  >
  ```
- **AND** the embedded content is capped at 1MB; if the uploaded content exceeds 1MB, it is truncated with a trailing note: `[content truncated at 1MB limit]`

### Requirement: Assembly Error Handling

The server SHALL handle errors during ZIP assembly gracefully.

#### Scenario: Missing resource file

- **WHEN** a resource's metadata exists in the database but the file is missing from disk
- **THEN** the server skips the missing resource
- **AND** logs a warning with the resource path
- **AND** continues assembling the rest of the ZIP

#### Scenario: Assembly progress updates

- **WHEN** the assembly pipeline is running
- **THEN** progress is updated in-memory for each resource
- **AND** the database is flushed every 10 resources (batched progress updates)
- **AND** progress is always flushed immediately at phase boundaries regardless of batch counter
- **AND** progress is reflected in the session status query API

#### Scenario: Assembly cancellation

- **WHEN** a session currently in `assembling` status is deleted
- **THEN** the server cancels the background assembly task immediately using a responsive mechanism (e.g., Python `asyncio.Task.cancel()` or threading `Event`)
- **AND** the task stops processing further files and cleans up partial output

#### Scenario: Assembly failure

- **WHEN** an unrecoverable error occurs during assembly
- **THEN** the server sets the session status to `failed`
- **AND** stores an error message describing the failure
- **AND** cleans up any partial ZIP file

### Requirement: Batched Assembly Progress Updates

The server SHALL batch database progress flushes during ZIP assembly, updating progress in-memory for each resource but only flushing to the database every 10 resources or at phase boundaries. This reduces database writes by approximately 90% for typical pages without meaningfully affecting progress granularity.

#### Scenario: Progress flushed in batches during ZIP assembly
- **GIVEN** a session is assembling a ZIP with 200 resources
- **WHEN** the ZIP assembly loop adds resources
- **THEN** progress is updated in-memory for each resource
- **AND** the database is flushed every 10 resources
- **AND** the total number of database flushes during ZIP assembly is approximately 20 (instead of 200)

#### Scenario: Progress always flushed at phase boundaries
- **GIVEN** the assembly pipeline transitions between phases
- **WHEN** a phase completes (e.g., CSS conversion finishes)
- **THEN** progress is flushed to the database immediately regardless of batch counter

#### Scenario: Progress granularity remains useful for polling
- **GIVEN** a client polls assembly status every 2 seconds
- **WHEN** assembly is actively adding resources to the ZIP
- **THEN** the client observes progress updates at approximately 5% granularity (10 resources at a time for a 200-resource page)

### Requirement: Parallel CSS File Conversion

The server SHALL convert CSS file `url()` references in parallel using `asyncio.gather` with a semaphore, instead of sequentially processing each CSS file.

#### Scenario: CSS files converted concurrently
- **GIVEN** a session has 20 CSS resource files to convert
- **WHEN** the assembly pipeline reaches the CSS conversion phase
- **THEN** up to 10 CSS files are converted concurrently
- **AND** each CSS file is read, converted, and written independently

#### Scenario: CSS conversion semaphore prevents resource exhaustion
- **GIVEN** a session has 100 CSS files to convert
- **WHEN** the CSS conversion phase runs
- **THEN** at most 10 files are being converted at the same time
- **AND** the thread pool is not exhausted

### Requirement: Parallel Linked Page HTML Conversion

The server SHALL convert linked page HTML in parallel using `asyncio.gather` with a semaphore, instead of processing each linked page sequentially.

#### Scenario: Linked pages converted concurrently
- **GIVEN** a session has 15 linked pages to convert
- **WHEN** the assembly pipeline reaches the linked page conversion phase
- **THEN** up to 10 linked pages are converted concurrently
- **AND** each page's HTML is independently converted with URL rewriting

#### Scenario: Single linked page processes normally
- **GIVEN** a session has only 1 linked page
- **WHEN** the linked page conversion phase runs
- **THEN** the single page is converted without parallelism overhead

### Requirement: Assembly pipeline phases

The ZIP assembly pipeline SHALL include a Phase 3b (CSS inlining) between Phase 3 (CSS URL conversion) and Phase 4 (output assembly). This phase inlines CSS content into the HTML for `file://` protocol compatibility.

#### Scenario: Multi-file ZIP assembly with CSS inlining
- **WHEN** a non-single-file session is assembled
- **THEN** Phase 3b runs after CSS URL conversion and before ZIP creation
- **AND** a `local_path_to_storage` mapping is built from all session resources (mapping logical paths like `styles/main.css` to UUID-based disk paths)
- **AND** this mapping is passed to `inline_css_into_html()` so it can resolve CSS files on disk
- **AND** all `<link rel="stylesheet">` tags in the main HTML are replaced with inline `<style>` tags
- **AND** linked page HTMLs also have their stylesheets inlined

#### Scenario: Single-file mode uses storage path mapping
- **WHEN** a single-file session is assembled
- **THEN** the `local_path_to_storage` mapping is passed to `write_single_file_to_disk()` so it can resolve all resource types (CSS, JS, images) for base64 inlining

#### Scenario: Single-file mode skips Phase 3b
- **WHEN** a single-file session is assembled
- **THEN** Phase 3b is skipped (single-file mode already inlines all resources via a different mechanism)

### Requirement: CSS files still included in ZIP

The server SHALL continue writing CSS files to the `styles/` directory in the ZIP, even after inlining them into HTML, for completeness and fallback purposes.

#### Scenario: CSS files present in ZIP alongside inline styles
- **WHEN** ZIP assembly completes for a multi-file session
- **THEN** the ZIP contains both inline `<style>` tags in `index.html` AND the original CSS files in `styles/` directory
