## 1. Extension-side (TypeScript) Changes

- [x] 1.1 Update `generateImageFilename()` in `src/background/urlUtils.ts` — when the URL has multiple path segments and the last segment has an image extension, join all segments with `_` before passing to `fixFilename()`
- [x] 1.2 Verify single-segment URLs still produce simple filenames (no parent prefix)

## 2. Server-side (Python) Changes

- [x] 2.1 Update `generate_image_filename()` in `server/app/services/html_converter.py` — match the TypeScript behavior for multi-segment image extension URLs
- [x] 2.2 Verify single-segment URLs still produce simple filenames

## 3. Tests

- [x] 3.1 Update `test_generate_image_filename` test expectations to reflect multi-segment path behavior
- [x] 3.2 Add test case for eBay-style CDN URL collision avoidance
- [x] 3.3 Verify all existing tests pass with the new filename generation
