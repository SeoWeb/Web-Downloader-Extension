## ADDED Requirements

### Requirement: Text-only multi-page per-page file assembly

When a session has text extraction enabled (`downloadContentAsText`) and linked-page texts stored per page (`content_pages` keyed by `page_url_hash`), the text-only assembly SHALL emit one file per page: `index.txt` for the main page plus `pages/<slug>.txt` for every linked page, where the slug is generated from the page's captured URL via `generate_page_filename` (the same generator and collision scheme as the linked-page HTML filenames); a page without a captured URL SHALL fall back to `pages/<page_url_hash>.txt`. Multi-file results SHALL follow the existing delivery rule — a single output file is delivered raw, multiple files are delivered as a ZIP — so a single-page text run still delivers raw `content.txt` unchanged.

#### Scenario: Multi-page text run zips with pages directory

- **WHEN** a text-only session with stored per-page texts has one or more linked pages
- **THEN** the assembled artifact contains `index.txt` (the main page's text) and one `pages/<slug>.txt` per linked page
- **AND** the multiple files are delivered as a ZIP

#### Scenario: Single-page text run delivers raw content.txt

- **WHEN** a text-only session has no linked pages (main page only)
- **THEN** the text is delivered as a single raw `content.txt` download, not a ZIP
- **AND** the delivery shape is unchanged from the pre-existing single-page behavior

#### Scenario: Page without a captured URL falls back to the hash name

- **WHEN** a stored linked-page text has no captured page URL
- **THEN** its file is written as `pages/<page_url_hash>.txt` (the same hash-identity fallback used for linked-page HTML)

### Requirement: Readable slug naming shared across page file types

Text page files SHALL reuse the server's existing readable-slug scheme: `pages/<name>.html`, `pages/<name>.md`, and `pages/<name>.txt` for the same linked page SHALL share the same slug base produced by `generate_page_filename` of the page URL, the same collision resolution (a deterministic 4-hex hash suffix appended on collision, e.g. `about-c3d4.txt`), and the same 100-character stem cap.

#### Scenario: Identical slug across types for one page

- **WHEN** a linked page `https://example.com/about` is stored as HTML, markdown, and text in the same session
- **THEN** the three files share the same slug base (`pages/about.html`, `pages/about.md`, `pages/about.txt`)

#### Scenario: Collision suffix is deterministic

- **WHEN** two linked pages in a session resolve to the same slug base (e.g. both `about`)
- **THEN** the colliding file is disambiguated with a deterministic 4-hex hash suffix (`about-c3d4.txt`), stable across assemblies
- **AND** the same collision rule applies identically to `.html`, `.md`, and `.txt` page files

## MODIFIED Requirements

### Requirement: Cloud push uses processed HTML

The cloud push SHALL send the fully-processed HTML (merged chunks, URL-rewritten, CSS-inlined) as `html_content`, NOT the ZIP file bytes. In markdown and text modes (HTML output disabled), the push SHALL additionally carry per-page content documents: linked-page markdown (`page_md_list`) and per-page page texts SHALL be pushed as `PageDocument` entries carrying `path`, `title`, `url`, and `content_format` — the push SHALL NOT reduce to main-page-only documents when linked pages were scraped, and per-page markdown/text SHALL NOT be dropped in these modes.

#### Scenario: Processed HTML sent to PagePocket

- **WHEN** the cloud push assembles the gRPC request
- **THEN** `html_content` SHALL be the processed `main_html` string encoded as UTF-8
- **AND** assets SHALL include all session resources with their converted content
- **AND** `extension_job_id` SHALL be the session UUID for idempotency

#### Scenario: Markdown-mode multi-page push includes pages documents

- **WHEN** a cloud-bound session runs in markdown mode (HTML output off) and linked pages were scraped
- **THEN** the push includes one `PageDocument` per linked page carrying that page's markdown, with `content_format` marking markdown
- **AND** the pushed document set is not reduced to the main page only

#### Scenario: Text-mode push includes per-page texts

- **WHEN** a cloud-bound session runs in text-only mode and linked pages were scraped
- **THEN** the push includes one `PageDocument` per linked page carrying that page's stored text, with `content_format` marking text

#### Scenario: Pages manifest recorded

- **WHEN** the push carries per-page documents
- **THEN** each document carries its `path`, `title`, `url`, and `content_format`
- **AND** the archive service records these as the page's `pages` list in `meta.json` (path/title/url/content_format)
