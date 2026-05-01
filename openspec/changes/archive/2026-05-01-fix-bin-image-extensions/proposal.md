## Why

Images served from extensionless URLs (e.g., Apple CDN `.../MHW04?wid=400&fmt=jpeg`) get `.bin` extensions in the assembled HTML instead of the correct type (`.jpg`, `.png`). The actual image file in the ZIP has the right extension (from the extension's Content-Type detection), but the server's HTML converter fallback generates a different `.bin` filename because it doesn't use stored content-type information when the filename map lookup misses.

## What Changes

- Server HTML converter fallback will use stored resource content-type from the database to determine correct extensions, instead of defaulting to `.bin`
- A `content_type_map` (URL → MIME type) will be built from uploaded resources and passed through the converter pipeline
- All image fallback paths (img src, lazy-load attrs, srcset, background images, CSS url()) will use this map

## Capabilities

### New Capabilities

- `content-type-aware-fallback`: Server HTML converter uses stored resource content-type to determine correct file extensions when the filename map lookup misses

### Modified Capabilities

- `server-html-converter`: Converter receives and uses content-type map for extension-less URL fallbacks
- `server-zip-assembly`: Assembler builds content-type map from DB resources and passes it to converter

## Impact

- `server/app/services/html_converter.py` — new `content_type_map` parameter on `convert_html`, `_convert_images`, and all fallback paths
- `server/app/services/zip_assembler.py` — build content-type map from DB resources, pass to converter
- No API changes, no extension-side changes required
