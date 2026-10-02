## MODIFIED Requirements

### Requirement: Image URL Conversion

The server SHALL convert image `src` attributes in the merged HTML from absolute URLs to relative local paths using the uploaded filename map.

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
- **THEN** the server generates a filename from the URL path
- **AND** replaces the `src` with `./images/<generated_filename>`

#### Scenario: Inline style url() conversion

- **WHEN** an element has an inline `style` attribute containing any `url(...)` reference
- **THEN** the URL inside `url()` is converted to a local path using the filename map or generated filename

#### Scenario: Inline style CSS custom property url() conversion

- **WHEN** an element has an inline `style` attribute containing `--image-url: url(https://example.com/photo.jpg)`
- **THEN** the URL inside `url()` is converted to a local path using the filename map or generated filename

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
