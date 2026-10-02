## MODIFIED Requirements

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
