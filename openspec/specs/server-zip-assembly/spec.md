# Server ZIP Assembly Specification

## Purpose

Server-side ZIP archive and single-file HTML assembly for the Website Downloader microservice. Covers ZIP creation, file path handling, single-file mode, assembly error handling, and progress reporting.

## Requirements

### Requirement: ZIP Archive Creation

The server SHALL create a ZIP archive containing the merged HTML and all uploaded resources when a session is finalized, with linked page filenames that match the link converter's output.

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
- **THEN** the server updates `session.assembly_phase` and `session.assembly_progress_pct` in the database after each file or major step
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
