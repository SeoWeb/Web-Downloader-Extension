## MODIFIED Requirements

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
