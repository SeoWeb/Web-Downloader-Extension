## Context

The Website Downloader extension supports two modes of operation:

1. **Local mode** — the extension scrapes, converts, and assembles the ZIP entirely in-browser using IndexedDB + JSZip.
2. **Server mode** — the extension scrapes and uploads HTML/resources to a Python microservice that handles merging, URL conversion, and ZIP assembly.

When linked page scraping was implemented, the local-mode path received careful attention (human-readable filenames, proper `../` path prefixes, asset dedup). The server-mode path was built incrementally via tasks 12.1–12.11, and several parity gaps were introduced:

- **Server-mode ZIP uses SHA-256 hash–based filenames for linked pages** (`pages/a1b2c3d4e5f6g7h8.html`) while the server's own `convert_links()` generates human-readable filenames (`pages/about.html`). This creates broken internal links in every server-mode ZIP.
- **Content text extraction is only done for the main page.** The `getResources()` function returns a `.text` field, but `scrapeLinkedPage()` never extracts or stores it.
- **Asset registry path prefixes differ** between main-page registration (`styles/`, `scripts/`, `images/`) and linked-page registration (`assets/css/`, `assets/js/`, `assets/images/`). While dedup still works (keyed on original URL), the stored `localPath` values are inconsistent.
- **Linked pages use a single-pass smooth scroll** (200ms per step) which may miss content loaded via IntersectionObserver or progressive infinite-scroll patterns.

## Goals / Non-Goals

**Goals:**

- Make linked page scraping produce output identical in fidelity to the first page, in both local and server modes.
- Ensure server-mode ZIPs contain valid internal navigation (no broken links between pages).
- Extend content text extraction to cover all scraped linked pages.
- Align asset registry path conventions between main page and linked pages.
- Improve lazy-load coverage for linked pages.

**Non-Goals:**

- Changing the single-file mode behavior (linked pages are intentionally excluded per spec 6.5).
- Adding recursive crawling beyond depth 1 (the `LinkedPageJob.depth` field exists for future use).
- Modifying the server's HTML merge logic (it already handles linked pages correctly).
- Adding a separate content.txt per linked page (all linked page text is appended to the main content.txt or uploaded as a single batch).

## Decisions

### Decision 1: Deterministic filename generation for server-mode linked pages

**Choice**: Use the same `generateFilename()` logic that the extension's `linked-page-scraper.ts` uses (extract last path segment, append `.html`) instead of SHA-256 hash–based names.

**Rationale**: The server's `convert_links()` already produces human-readable filenames like `pages/about.html`. The ZIP assembler must store pages at those same paths. Using the same algorithm ensures parity between local and server modes.

**Alternative considered**: Build a reverse-mapping table in the assembler (hash → readable name) and rewrite link hrefs after conversion. Rejected because it requires a second pass over the converted HTML and adds complexity.

**Implementation**: The `HtmlMergerService` already tracks `page_url` for each linked page job. Pass this URL through a shared `generate_page_filename()` function (ported from the extension's `generateFilename`) in both `convert_links()` and `_assemble_zip()`.

### Decision 2: Linked page content text handling

**Choice**: Each linked page's `getResources().text` is extracted in `scrapeLinkedPage()` and accumulated. After all linked pages are scraped, the combined text is either saved to storage (local mode) or uploaded via `serverClient.uploadContent()` (server mode, appended to the existing content).

**Rationale**: Reusing the existing `uploadContent` endpoint avoids creating a new API. The content is appended to the main page's text with a page-URL delimiter so it's clear which text came from which page.

**Alternative considered**: Upload each linked page's text separately via a new `POST /api/v1/sessions/{id}/content` with a `pageUrl` parameter. Rejected because it adds API surface and the current single content.txt file is sufficient.

### Decision 3: Asset registry path alignment

**Choice**: Change `downloadAssets()` in `linked-page-scraper.ts` to register assets with the same path prefixes as the main page: `styles/`, `scripts/`, `images/`, `documents/`.

**Rationale**: The `AssetRegistry.has()` check works on the original URL key, so changing the `localPath` parameter doesn't affect dedup. But consistent paths ensure that if any future code reads `assetRegistry.get(url).localPath`, it gets a correct value.

### Decision 4: Improved lazy-load scroll for linked pages

**Choice**: Add a configurable settle delay (default 500ms) after the scroll-to-bottom pass, then perform a second quick scroll pass. Also increase the per-step wait from 200ms to 300ms.

**Rationale**: Many modern sites use IntersectionObserver with a threshold that only fires when an element scrolls into the viewport for at least 200–300ms. A single fast scroll may not trigger these observers. The second pass catches content that loaded during the first pass but wasn't visible long enough.

**Alternative considered**: Use the same incremental scroll-and-capture loop as the main page. Rejected because the main page's loop is tightly coupled to the content-script messaging architecture (user-driven scrolling with incremental DOM capture via `SCROLL_AND_EXTRACT_DIFF`). Porting this to linked pages would require significant refactoring.

## Risks / Trade-offs

- **[Breaking change: server-mode linked page filenames]** → Mitigation: Server mode is not yet in wide production use; the hash-based naming was never documented as a contract. The change aligns with local-mode behavior which is the de facto standard.
- **[Increased scraping time from improved scroll]** → Mitigation: The additional settle delay and second scroll pass add ~1–2 seconds per linked page. This is acceptable for fidelity. The delays are configurable via existing `linkedPagesTimeout` and `linkedPagesDelay` options.
- **[Content text accumulation may increase memory]** → Mitigation: Body text is typically small relative to HTML. The text is extracted per-page and can be flushed to storage/upload incrementally, similar to how the main page handles it.
- **[Filename collisions for linked pages with same last path segment]** → Mitigation: `generateFilename()` already handles this by including a hash suffix when collisions occur. The same logic must be ported to the server.
