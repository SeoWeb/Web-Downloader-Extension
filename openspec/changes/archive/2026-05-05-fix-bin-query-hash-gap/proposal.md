## Why

Images served from extensionless URLs with query parameters (e.g. `https://cdn.example.com/api/image/123?width=200`) still get `.bin` references in the assembled HTML. Three previous fixes (content-type map, original-URL storage, filename-ext map) all work correctly, but the last-resort safety net (`_maybe_fix_bin_extension`) fails because the extension's filename includes a DJB2 query hash (`api_image_123_a1b2c3d4.jpg`) while the server's fallback generates no hash (`api_image_123.bin`), so the base names never match.

## What Changes

- Port the DJB2 query hash function (`getQueryHash` from `urlUtils.ts`) to Python in `html_converter.py`
- Update `generate_image_filename()` to accept an optional `original_url` parameter and include the query hash when present
- Thread the original (pre-cleaned) URL through all 6 fallback call sites that call `generate_image_filename()`

## Capabilities

### New Capabilities

- `query-hash-filenames`: Query-hash disambiguation in server-side image filename generation, matching the extension's TypeScript implementation

### Modified Capabilities

- `server-html-converter`: `generate_image_filename()` signature gains `original_url` parameter; all fallback call sites updated to pass it
- `content-type-aware-fallback`: The `filename_ext_map` safety net now works correctly for URLs with query params because base names match

## Impact

- `server/app/services/html_converter.py` — add `_get_query_hash()`, update `generate_image_filename()`, update 6 call sites
- Existing tests for `generate_image_filename` may need updated expected values for URLs with query params
- No API changes, no database changes, no extension-side changes
