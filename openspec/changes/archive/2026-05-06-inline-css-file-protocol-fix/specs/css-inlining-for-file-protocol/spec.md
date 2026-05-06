## ADDED Requirements

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
