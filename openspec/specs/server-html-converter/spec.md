# Server HTML Converter Specification

## Purpose

Server-side HTML URL conversion for the Website Downloader microservice. Covers how absolute resource URLs in merged HTML are converted to relative local paths using the uploaded filename map, including image, script, stylesheet, link, object, and CSS file conversions.

## Requirements

### Requirement: Image URL Conversion

The server SHALL convert image `src` attributes in the merged HTML from absolute URLs to relative local paths using the uploaded filename map.

Image filename generation SHALL include parent path segments when a URL has multiple path segments, matching the extension-side `generateImageFilename` behavior to prevent filename collisions.

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
- **THEN** the server generates a filename from the URL path, including parent segments for multi-segment paths
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

- **WHEN** converting a linked page's HTML
- **THEN** the server uses the session's global filename map (including incremental updates from linked page scraping)
- **AND** resources already downloaded for the main page are correctly referenced

#### Scenario: Linked page discovers new images

- **WHEN** a linked page contains images not present in the main page's filename map
- **THEN** the extension uploads the new images as resources
- **AND** sends an incremental filename map update via `POST /api/v1/sessions/{id}/filename-map`
- **AND** the server uses the updated map when converting the linked page's HTML
