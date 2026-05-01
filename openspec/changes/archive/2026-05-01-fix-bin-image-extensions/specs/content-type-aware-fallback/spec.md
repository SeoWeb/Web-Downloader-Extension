## ADDED Requirements

### Requirement: Content-type map construction from session resources

The assembler SHALL build a URL-to-content-type map from all uploaded resources for the session before invoking the HTML converter. The map SHALL use each resource's `original_url` as key and `content_type` as value, excluding entries where `content_type` is `None`.

#### Scenario: Resources with content-type available

- **WHEN** a session has resources with `original_url` = `https://cdn.example.com/img/abc123` and `content_type` = `image/jpeg`
- **THEN** the content-type map contains the entry `"https://cdn.example.com/img/abc123" → "image/jpeg"`

#### Scenario: Resources without content-type are excluded

- **WHEN** a session has a resource with `content_type` = `None`
- **THEN** that resource is excluded from the content-type map

### Requirement: Content-type lookup for fallback filename generation

When the filename map lookup fails for an image URL, the converter SHALL attempt to determine the correct file extension by looking up the resolved URL in the content-type map and passing the result to `generate_image_filename`.

#### Scenario: Extensionless URL with content-type match

- **WHEN** an `<img src>` URL has no file extension and the URL matches an entry in the content-type map with `image/jpeg`
- **THEN** the generated filename uses the `.jpg` extension instead of `.bin`

#### Scenario: URL resolved for content-type lookup

- **WHEN** an image URL is relative or protocol-relative
- **THEN** the converter resolves it to a full URL before looking it up in the content-type map

#### Scenario: Content-type map has no match

- **WHEN** the image URL is not found in the content-type map
- **THEN** the converter falls back to `.bin` extension (unchanged behavior)

### Requirement: Content-type map passed to all image fallback paths

The content-type map SHALL be used in ALL image URL conversion fallback paths: `<img src>`, lazy-load attributes (`data-src`, `data-lazy-src`, etc.), `srcset` entries, `<source src>`, and CSS `url()` references in inline styles and `<style>` tags.

#### Scenario: Lazy-load attribute fallback uses content-type

- **WHEN** a `data-src` attribute contains a URL not in the filename map, but the URL has a content-type entry
- **THEN** the generated filename uses the correct extension from the content-type

#### Scenario: srcset entry fallback uses content-type

- **WHEN** a `srcset` URL is not in the filename map, but the URL has a content-type entry
- **THEN** the generated filename uses the correct extension from the content-type

#### Scenario: CSS url() fallback uses content-type

- **WHEN** a CSS `url()` reference is not in the filename map, but the URL has a content-type entry
- **THEN** the generated filename uses the correct extension from the content-type
