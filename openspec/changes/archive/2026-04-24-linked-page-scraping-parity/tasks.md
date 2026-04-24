## 1. Server-Side Linked Page Filename Fix (Critical)

- [x] 1.1 Port `generateFilename()` from extension's `linked-page-scraper.ts` to `server/app/services/html_converter.py` as `generate_page_filename(url)` — extract last path segment, append `.html`, sanitize with `fix_filename()`
- [x] 1.2 Update `zip_assembler.py` `_assemble_zip()` to use `generate_page_filename(job.page_url)` instead of `f"pages/{page_hash}.html"` for linked page filenames in the ZIP
- [x] 1.3 Verify `convert_links()` in `html_converter.py` produces the same filenames as `generate_page_filename()` for the same URLs — ensure both use the same last-path-segment + `.html` logic
- [x] 1.4 Add collision handling: track used filenames across linked pages in the assembler; when a collision occurs, append a short hash suffix (e.g., `team-a1b2.html`) and ensure `convert_links()` applies the same dedup

## 2. Linked Page Content Text Extraction

- [x] 2.1 In `scrapeLinkedPage()`, extract `text` via `getResources(html).text` and store it in `ScrapedPageData` return value (add a `text` field)
- [x] 2.2 In `processQueue()`, accumulate linked page text with page-URL delimiters (e.g., `\n--- https://example.com/about ---\n`) and return the combined text after all pages are processed
- [x] 2.3 In local mode (`download-core.ts` `executeDownload()`), append the accumulated linked page text to `addContentText()` after `processQueue()` completes
- [x] 2.4 In server mode (`executeDownloadServerMode()`), upload the accumulated linked page text via `serverClient.uploadContent()` after `processQueue()` completes
- [x] 2.5 Guard all text extraction with `downloadOptions.downloadContentAsText` check — skip when disabled

## 3. Asset Registry Path Alignment

- [x] 3.1 In `linked-page-scraper.ts` `downloadAssets()`, change the `assetRegistry.register()` calls from `assets/css/`, `assets/js/`, `assets/images/` prefixes to `styles/`, `scripts/`, `images/`, `documents/` — matching the main page's registration convention

## 4. Improved Lazy-Load Scroll Strategy

- [x] 4.1 In `scrollPageForLazyLoading()`, increase per-step settle time from 200ms to 300ms
- [x] 4.2 Add a 500ms settle delay after reaching the bottom of the page (before scrolling back to top)
- [x] 4.3 Add a second quick scroll pass from top to bottom after the settle delay, before DOM capture
- [x] 4.4 Update the total scroll timeout consideration — ensure the combined two-pass strategy stays within `pageTimeout`

## 5. Testing & Verification

- [x] 5.1 Add server-side test for `generate_page_filename()` — verify it produces matching filenames for URLs like `/about/team`, `/`, and collision cases
- [x] 5.2 Add server-side integration test for ZIP assembly with linked pages — verify filenames in the ZIP match `convert_links()` output
- [x] 5.3 Add extension unit test for linked page content text extraction — verify text is accumulated and delimited correctly
- [ ] 5.4 Manual end-to-end test: download a multi-page site in server mode and verify all internal links resolve correctly in the output ZIP
