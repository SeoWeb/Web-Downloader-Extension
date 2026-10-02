## Why

Linked pages are not scraped with the same fidelity as the first page, causing broken cross-page links in server-mode ZIPs, missing text content for linked pages, inconsistent asset registry paths, and weaker lazy-load coverage. These gaps make the output incomplete and, in server mode, produce ZIPs where internal navigation links point to non-existent files.

## What Changes

- **Fix linked page filename generation in server-mode ZIP assembly** — replace hash-based filenames (`pages/{sha256_hash}.html`) with human-readable filenames matching what `convert_links()` produces (`pages/about.html`), ensuring cross-page links resolve correctly in the output ZIP.
- **Add content text extraction for linked pages** — extract body text from each linked page via `getResources()` and upload it to the server (server mode) or save it locally (local mode), so the "Download content as text" option covers all scraped pages, not just the main page.
- **Align asset registry path prefixes** — make linked-page-scraper register assets with the same path prefix convention as the main page (`styles/`, `scripts/`, `images/`, `documents/`) instead of the divergent `assets/css/`, `assets/js/`, `assets/images/` prefixes.
- **Improve lazy-load scroll strategy for linked pages** — add a configurable settle-time after the scroll-to-bottom pass and a second scroll pass to capture content that loads progressively via IntersectionObserver or infinite-scroll patterns.

## Capabilities

### New Capabilities

- `linked-page-content-text`: Extraction and storage of body text content from each linked page, paralleling the main page's content.txt handling in both local and server modes.

### Modified Capabilities

- `linked-pages`: Add requirement for consistent filename generation between the link converter and the ZIP assembler, and improve lazy-load scroll coverage.
- `server-zip-assembly`: Add requirement that linked page filenames in the ZIP MUST match the filenames produced by the server-side `convert_links()` function, so that internal navigation links resolve correctly.
- `server-html-converter`: Add requirement that the `convert_links()` function must produce filenames that are consistent with the linked page filenames stored in the ZIP's `pages/` directory.
- `html-processing`: Update the anchor href conversion scenario to note that linked page filenames must be deterministic and match across conversion and assembly.

## Impact

- **Extension code**: `src/background/linked-page-scraper.ts` (filename generation, content text, asset registry paths, scroll strategy), `src/background/download-core.ts` (content text handling for linked pages)
- **Server code**: `server/app/services/zip_assembler.py` (linked page filename generation), `server/app/services/html_converter.py` (link conversion must match ZIP filenames), `server/app/api/routes/sessions.py` or new endpoint (content text upload for linked pages)
- **ZIP output**: Linked page filenames change from hash-based to human-readable in server mode — this is a **BREAKING** change for any tooling that depends on the hash-based naming
- **Backward compatibility**: Local-mode behavior is unchanged (already uses human-readable filenames); server-mode output becomes consistent with local mode
