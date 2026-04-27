## Why

Image filenames are generated from only the last path segment of the URL. When multiple images share the same filename but live in different URL directories (e.g., eBay CDN: `/images/g/ABC/s-l960.webp` vs `/images/g/XYZ/s-l960.webp`), they collide — producing a single `s-l960.webp` that only contains the last image downloaded. This causes missing/broken images in downloaded pages.

## What Changes

- Update `generateImageFilename()` in `src/background/urlUtils.ts` to include parent path segments when a URL has multiple path segments and the last segment has an image extension, preventing collisions
- Update `generate_image_filename()` in `server/app/services/html_converter.py` to match the same behavior for server-side parity
- Single-segment paths (e.g., `/photo.jpg`) continue to use just the filename — no change

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `html-processing`: Image filename generation now includes parent path segments to avoid collisions for same-named files from different URL paths
- `server-html-converter`: Python `generate_image_filename()` updated to match the TypeScript behavior

## Impact

- `src/background/urlUtils.ts` — `generateImageFilename()` logic change
- `server/app/services/html_converter.py` — `generate_image_filename()` logic change
- `server/tests/test_html_converter.py` — updated test expectations
- Image filenames in downloaded ZIPs will change for multi-segment URLs (e.g., `photo.jpg` → `img_photo.jpg`), but the filename map ensures consistency between download and HTML rewriting
