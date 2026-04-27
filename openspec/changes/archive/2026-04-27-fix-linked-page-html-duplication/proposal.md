## Why

Main page scroll streaming uploads each scroll step's full HTML as a chunk tagged `pageType: "main"` WITH `pageUrl: tabUrl`. The server hashes the URL to create a separate job (not `"main"`), so when the assembler processes results, this phantom job is treated as a linked page and saved to `pages/`. The merge then duplicates content because `_safe_merge` naively concatenates the skeleton body with all chunk bodies — and all 13 scroll-step chunks contain nearly identical full-page HTML, producing 13x duplicated body content.

## What Changes

- Fix `useScrapingDownloader.ts` to NOT send `pageUrl` when streaming main page scroll chunks, so the server groups them under `page_url_hash = "main"` instead of creating a phantom linked page job.
- Fix `_safe_merge` in `html_merger.py` to deduplicate body content instead of blindly concatenating skeleton body + all chunk bodies.
- Fix `_dom_merge` superset detection to handle the case where all chunks are identical or near-identical to the skeleton.

## Capabilities

### New Capabilities

(None)

### Modified Capabilities

- `streaming`: Main page scroll streaming must omit `pageUrl` (or send `undefined`) so server creates one `"main"` job, not a phantom linked page job.
- `server-html-merge`: Safe merge must deduplicate chunk body content before concatenating. DOM merge must correctly detect when all chunks are identical supersets of the skeleton.

## Impact

- **`src/sidepanel/hooks/useScrapingDownloader.ts`**: Remove `pageUrl: tabUrl` from `SERVER_UPLOAD_HTML_CHUNK` message data (line ~140).
- **`server/app/services/html_merger.py`**: `_safe_merge` body content deduplication logic; `_dom_merge` superset detection refinement.
- **`server/app/api/routes/html.py`**: No changes needed — existing `pageUrl` handling is correct once client stops sending it for main page scrolls.
- **Downstream**: ZIP assembly no longer produces phantom linked page entries for the main page URL. Existing linked page scraping via `LinkedPageScraper` is unaffected.
