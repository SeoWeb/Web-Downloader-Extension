# Server HTML Converter Specification

## Purpose

Server-side HTML URL conversion for the Website Downloader microservice. Covers how absolute resource URLs in merged HTML are converted to relative local paths using the uploaded filename map, including image, script, stylesheet, link, object, and CSS file conversions.

## Requirements

### Requirement: Image URL Conversion

The server SHALL convert image `src` attributes in the merged HTML from absolute URLs to relative local paths using the uploaded filename map.

Image filename generation SHALL include parent path segments when a URL has multiple path segments, matching the extension-side `generateImageFilename` behavior to prevent filename collisions.

When the filename map lookup fails, the converter SHALL use the content-type map to determine the correct file extension before falling back to `.bin`.

Image filename generation SHALL include a DJB2 query hash suffix when the original URL contains query parameters, matching the extension's `generateImageFilename()` behavior.

#### Scenario: Image mapped via filename map

- **WHEN** an `<img>` element has a `src` that matches an entry in the uploaded filename map
- **THEN** the `src` is replaced with the relative path `./images/<mapped_filename>`

#### Scenario: Image with lazy-load attribute

- **WHEN** an `<img>` element has a `data-src`, `data-lazy-src`, or similar lazy-load attribute containing a URL present in the filename map
- **THEN** the attribute value is replaced with the relative path `./images/<mapped_filename>`

#### Scenario: Image with srcset

- **WHEN** an `<img>` or `<picture><source>` element has a `srcset` attribute containing URLs
- **THEN** each URL in the srcset that matches the filename map is replaced with its local path
- **AND** the descriptor portion of the srcset entry is preserved

#### Scenario: Image URL not in filename map

- **WHEN** an `<img>` element has a `src` that does not match any entry in the filename map
- **THEN** the server resolves the URL and checks the content-type map
- **AND** if the URL has a content-type entry, generates a filename using that extension
- **AND** if no content-type entry exists, generates a filename with `.bin` extension
- **AND** replaces the `src` with `./images/<generated_filename>`

#### Scenario: Multi-segment URL generates collision-safe filename

- **WHEN** an image URL has multiple path segments and the last segment has an image extension (e.g., `https://i.ebayimg.com/images/g/hXIAAOSwu-BoJfB9/s-l960.webp`)
- **THEN** the generated filename includes all path segments joined with underscores (e.g., `images_g_hXIAAOSwu-BoJfB9_s-l960.webp`)

#### Scenario: Single-segment URL filename unchanged

- **WHEN** an image URL has a single path segment with an image extension (e.g., `https://example.com/photo.jpg`)
- **THEN** the generated filename uses only that segment (e.g., `photo.jpg`)

#### Scenario: Inline style url() conversion

- **WHEN** an element has an inline `style` attribute containing any `url(...)` reference
- **THEN** the URL inside `url()` is converted to a local path using the filename map or generated filename

#### Scenario: Inline style CSS custom property url() conversion

- **WHEN** an element has an inline `style` attribute containing `--image-url: url(https://example.com/photo.jpg)`
- **THEN** the URL inside `url()` is converted to a local path using the filename map or generated filename

#### Scenario: Extensionless CDN URL gets correct extension from content-type

- **WHEN** an `<img src>` is `https://store.storeimages.cdn-apple.com/1/as-images.apple.com/is/MHW04?wid=400&hei=400&fmt=jpeg` and this URL is not in the filename map but has content-type `image/jpeg` in the content-type map
- **THEN** the generated filename uses `.jpg` extension (e.g., `1_as-images.apple.com_is_MHW04_<hash>.jpg`)

#### Scenario: Fallback filename for extensionless URL with query params includes query hash

- **WHEN** `generate_image_filename()` is called in a fallback path with an `original_url` that has query parameters (e.g., `https://cdn.example.com/api/image/123?width=200`)
- **THEN** the generated filename includes the DJB2 query hash suffix matching what the extension would produce
- **AND** the base name matches entries in the `filename_ext_map` so `_maybe_fix_bin_extension()` can find the correct extension

### Requirement: Script URL Conversion

The server SHALL convert `<script src>` attributes from absolute URLs to relative local paths.

#### Scenario: Script with matching resource

- **WHEN** a `<script>` element has a `src` attribute matching an uploaded resource
- **THEN** the `src` is replaced with `./scripts/<filename>`

#### Scenario: Script with query parameters

- **WHEN** a `<script>` element has a `src` containing query parameters
- **THEN** the query parameters are stripped before matching
- **AND** the `src` is replaced with `./scripts/<filename_without_query>`

### Requirement: Stylesheet URL Conversion

The server SHALL convert `<link rel="stylesheet" href>` attributes from absolute URLs to relative local paths.

#### Scenario: Stylesheet with matching resource

- **WHEN** a `<link rel="stylesheet">` element has an `href` matching an uploaded resource
- **THEN** the `href` is replaced with `./styles/<filename>`

#### Scenario: CSS url() references in inline styles

- **WHEN** the HTML contains `<style>` tags with `url()` references
- **THEN** each `url()` is converted to a local path using the filename map or generated filename

### Requirement: Link URL Conversion

The server SHALL convert `<a href>` attributes to point to local file paths, using filenames that are consistent with the linked page filenames stored in the ZIP's `pages/` directory.

#### Scenario: Link to a document file

- **WHEN** an `<a>` element has an `href` ending in a document extension (.pdf, .doc, .docx, etc.)
- **THEN** the `href` is replaced with `./documents/<filename>`

#### Scenario: Link to an HTML page within same origin

- **WHEN** an `<a>` element has an `href` pointing to the same origin and is an HTML page
- **THEN** the `href` is replaced with `./pages/<filename>.html`
- **AND** the `<filename>` is generated using the same algorithm as the ZIP assembler's linked page filename generation (last path segment of the URL)
- **AND** the generated filename MUST exactly match the filename used to store the linked page in the ZIP's `pages/` directory

#### Scenario: Link to an external origin

- **WHEN** an `<a>` element has an `href` pointing to a different origin
- **THEN** the `href` is left unchanged

#### Scenario: Anchor-only link

- **WHEN** an `<a>` element has an `href` starting with `#`
- **THEN** the `href` is left unchanged

### Requirement: Object Element Conversion

The server SHALL convert `<object type="image/*" data>` attributes to local paths.

#### Scenario: Object with image type

- **WHEN** an `<object>` element has a `type` attribute starting with `image/` and a `data` attribute
- **THEN** the `data` attribute is replaced with `./images/<filename>` using the filename map

### Requirement: Linked Page HTML Conversion

The server SHALL convert HTML for linked pages with a different relative path prefix (pages are in `pages/` folder, assets are at root level).

#### Scenario: Linked page image references

- **WHEN** converting HTML for a linked page stored in the `pages/` directory
- **THEN** image paths use `../images/` prefix instead of `./images/`

#### Scenario: Linked page asset references

- **WHEN** converting HTML for a linked page stored in the `pages/` directory
- **THEN** CSS references use `../styles/` prefix and JS references use `../scripts/` prefix

### Requirement: CSS File URL Conversion

The server SHALL convert `url()` references inside standalone CSS files (stored at `styles/`) from absolute URLs to relative local paths.

#### Scenario: CSS url() with image reference

- **WHEN** a CSS file contains `background-image: url('https://example.com/images/bg.jpg')`
- **THEN** the URL is converted to `../images/bg.jpg` (CSS is in `styles/`, images in `images/`)
- **AND** the filename map is consulted for correct extensions

#### Scenario: CSS url() with font reference

- **WHEN** a CSS file contains `@font-face { src: url('https://example.com/fonts/roboto.woff2') }`
- **THEN** the URL is converted to `../fonts/roboto.woff2`
- **AND** if the font resource was uploaded to the server, it is stored in the `fonts/` directory in the ZIP
- **AND** if the font resource was not uploaded, the original URL is preserved

#### Scenario: CSS url() with data URI

- **WHEN** a CSS file contains `url(data:image/png;base64,...)`
- **THEN** the data URI is left unchanged

#### Scenario: CSS url() with relative path

- **WHEN** a CSS file contains `url('../images/icon.svg')` that was not resolved to an absolute URL during upload
- **THEN** the relative path is left unchanged

#### Scenario: CSS url() with query parameters

- **WHEN** a CSS file contains `url('https://example.com/css/fonts?v=1.2')`
- **THEN** the query parameters are stripped before matching
- **AND** the URL is converted to the local path without query parameters

#### Scenario: CSS @import url() reference

- **WHEN** a CSS file contains `@import url('https://example.com/styles/theme.css')`
- **THEN** the URL is converted to `./theme.css` if the resource was uploaded to the server (stored in the same `styles/` directory)
- **AND** the original URL is preserved if the resource was not uploaded or is from an external origin
- **AND** (v1 limitation) transitive `@import` chains are NOT followed recursively — only `url()` and `@import` references in the directly uploaded CSS files are rewritten; if `theme.css` itself imports `variables.css` using a relative path, that relative path is left unchanged per the "already-relative paths are preserved" rule and offline viewing depends on all imports residing in the same directory

### Requirement: Single-File HTML Inlining

The server SHALL produce a self-contained HTML file when the single-file option is active, inlining all resources as base64 data URIs.

#### Scenario: Image inlining in single-file mode

- **WHEN** converting HTML for a session with `singleFile` option enabled
- **THEN** each image referenced in the HTML is read from disk and converted to a base64 data URI
- **AND** the `src` attribute is replaced with the data URI
- **AND** already-base64 images are left unchanged

#### Scenario: CSS inlining in single-file mode

- **WHEN** converting HTML for a session with `singleFile` option enabled
- **THEN** each `<link rel="stylesheet">` element is replaced with an inline `<style>` element
- **AND** CSS content is read from disk and embedded directly
- **AND** `url()` references within the CSS are converted to base64 data URIs

#### Scenario: JavaScript inlining in single-file mode

- **WHEN** converting HTML for a session with `singleFile` option enabled
- **THEN** each `<script src>` element is replaced with an inline `<script>` element
- **AND** JavaScript content is read from disk and embedded directly

#### Scenario: Failed resource fetch in single-file mode

- **WHEN** a resource file referenced in the HTML is missing from disk during single-file conversion
- **THEN** the original URL is preserved for images
- **AND** empty content is used for scripts and stylesheets

#### Scenario: Inline style url() inlining in single-file mode

- **WHEN** converting HTML for a session with `singleFile` option enabled
- **AND** an element has an inline `style` attribute containing any `url(...)` reference
- **THEN** the URL inside `url()` is replaced with a base64 data URI read from disk

### Requirement: Linked Page Full Server-Side Processing

The server SHALL handle HTML conversion for linked pages uploaded during a full-website scraping session, applying the `../` path prefix for all resource references and producing filenames consistent with link conversion.

#### Scenario: Linked page HTML with all resource types

- **WHEN** a linked page's HTML chunks are uploaded with `pageType: linked`
- **THEN** the server merges the linked page's HTML chunks separately from the main page
- **AND** converts all resource URLs using `../` prefix (images → `../images/`, CSS → `../styles/`, JS → `../scripts/`, documents → `../documents/`)
- **AND** the converted HTML is stored in the `pages/` directory during ZIP assembly
- **AND** the page's filename is generated deterministically from its URL using the same algorithm as `convert_links()`

#### Scenario: Linked page uses main page's filename map
- **GIVEN** `convert_linked_page_html` is called
- **WHEN** the conversion executes
- **THEN** the HTML is parsed exactly once
- **AND** all conversion passes use the `../` path prefix appropriate for the `pages/` directory

### Requirement: Filename extension map fallback for bin extensions

When the filename map lookup fails and `generate_image_filename()` produces a filename ending with `.bin`, the converter SHALL attempt to look up the filename's base (without the `.bin` extension) in the `filename_ext_map`. If a match is found, the converter SHALL use the matched extension instead of `.bin`.

#### Scenario: Bin filename corrected via filename_ext_map

- **WHEN** an `<img src>` URL is not in the filename map and not in the content-type map, producing the filename `1_as-images.apple.com_is_store-card-13-iphone-nav-202509.bin`
- **AND** the `filename_ext_map` contains `"1_as-images.apple.com_is_store-card-13-iphone-nav-202509"` → `"png"`
- **THEN** the converter uses `1_as-images.apple.com_is_store-card-13-iphone-nav-202509.png` as the filename

#### Scenario: No match in filename_ext_map preserves bin

- **WHEN** `generate_image_filename()` produces a `.bin` filename
- **AND** the filename base is not found in the `filename_ext_map`
- **THEN** the `.bin` extension is used (unchanged behavior)

#### Scenario: Query-hashed base name found in filename_ext_map

- **WHEN** the extension downloaded an image from `https://cdn.example.com/api/image/123?width=200` and stored it as `images/api_image_123_a1b2c3d4.jpg`
- **AND** the `filename_ext_map` contains `"api_image_123_a1b2c3d4"` → `"jpg"`
- **AND** the server fallback generates `api_image_123_a1b2c3d4.bin` (with query hash)
- **THEN** `_maybe_fix_bin_extension()` finds the match and replaces `.bin` with `.jpg`

### Requirement: CSS inlining function

The HTML converter service SHALL provide an `inline_css_into_html()` function that reads CSS files from disk and replaces `<link rel="stylesheet">` elements with inline `<style>` tags containing the CSS content.

#### Scenario: Inline all stylesheets into HTML

- **WHEN** `inline_css_into_html()` is called with an HTML string, storage root, session ID, filename map, and a `local_path_to_storage` mapping
- **THEN** all `<link rel="stylesheet">` elements with resolvable CSS files are replaced with `<style>` tags
- **AND** CSS `url()` paths are adjusted based on the target path prefix (`./` for root, `../` for linked pages)

#### Scenario: CSS file stored with UUID filename

- **WHEN** a CSS resource is stored on disk at `resources/<uuid>` but referenced by local path `styles/main.css`
- **AND** a `local_path_to_storage` mapping is provided that maps `styles/main.css` to the UUID-based disk path
- **THEN** the inlining function resolves the correct disk path via the mapping and reads the CSS content successfully

### Requirement: Extensionless stylesheet URL fallback

The `_convert_stylesheets()` function SHALL generate a filename with `.css` extension for URLs that have no file extension, instead of leaving them unchanged.

#### Scenario: Stylesheet URL with no file extension

- **WHEN** a `<link rel="stylesheet" href="/styles/main">` URL has no file extension
- **THEN** the converter generates a fallback filename like `main.css` and rewrites the href to `./styles/main.css`

### Requirement: Extensionless script URL fallback

The `_convert_scripts()` function SHALL generate a filename with `.js` extension for URLs that have no file extension, instead of leaving them unchanged.

#### Scenario: Script URL with no file extension

- **WHEN** a `<script src="/scripts/client">` URL has no file extension
- **THEN** the converter generates a fallback filename like `client.js` and rewrites the src to `./scripts/client.js`

### Requirement: Undefined prefix stripping

The `_convert_stylesheets()` and `_convert_scripts()` functions SHALL strip a leading `undefined` prefix from filenames that result from website JS variables being undefined at capture time.

#### Scenario: Script URL with undefined prefix

- **WHEN** a `<script src="undefinedbrowser-perf.8417c6bba72228fa2e29.js">` has a filename starting with "undefined"
- **THEN** the converter strips the "undefined" prefix, resulting in `./scripts/browser-perf.8417c6bba72228fa2e29.js`

### Requirement: UUID-based storage path resolution

The `_resolve_local_path()` function SHALL accept a `local_path_to_storage` mapping that translates logical local paths (e.g., `styles/main.css`) to actual filesystem paths (e.g., `resources/<uuid>`). Resources are stored on disk with UUID filenames, not their logical local_path names. Without this mapping, the function cannot locate files for inlining or base64 encoding.

#### Scenario: Resolve UUID-stored resource via mapping

- **WHEN** `_resolve_local_path()` is called with a URL like `./styles/main.css`
- **AND** a `local_path_to_storage` dict maps `styles/main.css` to `/data/sessions/{sid}/resources/abc-123`
- **THEN** the function returns `/data/sessions/{sid}/resources/abc-123`

#### Scenario: Fallback without mapping

- **WHEN** `_resolve_local_path()` is called without a `local_path_to_storage` mapping
- **THEN** the function falls back to constructing `{storage_root}/{session_id}/resources/{clean_path}` (works for tests with human-readable filenames)

### Requirement: Extensionless CSS filename handling

The CSS file handler SHALL add a `.css` extension to filenames that have no file extension. Since the handler is only invoked for `<link rel="stylesheet">` resources, the resource type is already known and no Content-Type confirmation is needed.

#### Scenario: CSS URL with no file extension

- **WHEN** a CSS resource URL like `https://example.com/styles/main` has no extension in its last path segment
- **THEN** the handler detects the missing extension and appends `.css`
- **AND** the file is stored as `styles/main.css`

### Requirement: Extensionless JS filename handling

The JS file handler SHALL add a `.js` extension to filenames that have no file extension. Since the handler is only invoked for `<script>` resources, the resource type is already known and no Content-Type confirmation is needed.

#### Scenario: JS URL with no file extension

- **WHEN** a JS resource URL like `https://example.com/scripts/client` has no extension in its last path segment
- **THEN** the handler detects the missing extension and appends `.js`
- **AND** the file is stored as `scripts/client.js`

### Requirement: Undefined prefix stripping in filenames

The CSS and JS file handlers SHALL strip a leading `undefined` prefix from extracted filenames, which occurs when website JavaScript variables used in URL construction are undefined at capture time.

#### Scenario: CSS filename with undefined prefix

- **WHEN** a CSS URL resolves to a filename like `undefinedhome.desktop.css`
- **THEN** the handler strips the "undefined" prefix, resulting in `home.desktop.css`

#### Scenario: JS filename with undefined prefix

- **WHEN** a JS URL resolves to a filename like `undefinedbrowser-perf.8417c6bba72228fa2e29.js`
- **THEN** the handler strips the "undefined" prefix, resulting in `browser-perf.8417c6bba72228fa2e29.js`

### Requirement: Filename extension map threaded through all image fallback paths

The `filename_ext_map` SHALL be used in ALL image URL conversion fallback paths where `generate_image_filename()` is called: `<img src>`, lazy-load attributes (`data-src`, `data-lazy-src`, etc.), `srcset` entries, `<source src>`, and CSS `url()` references in inline styles and `<style>` tags.

#### Scenario: Lazy-load attribute fallback corrects bin

- **WHEN** a `data-src` attribute produces a `.bin` filename via the fallback path
- **AND** the `filename_ext_map` contains a matching base name entry
- **THEN** the correct extension from the map is used instead of `.bin`

#### Scenario: CSS url() fallback corrects bin

- **WHEN** a CSS `url()` reference produces a `.bin` filename via the fallback path
- **AND** the `filename_ext_map` contains a matching base name entry
- **THEN** the correct extension from the map is used instead of `.bin`

