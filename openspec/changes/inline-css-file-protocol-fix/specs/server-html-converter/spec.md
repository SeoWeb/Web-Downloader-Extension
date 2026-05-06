## ADDED Requirements

### Requirement: CSS inlining function
The HTML converter service SHALL provide an `inline_css_into_html()` function that reads CSS files from disk and replaces `<link rel="stylesheet">` elements with inline `<style>` tags containing the CSS content.

#### Scenario: Inline all stylesheets into HTML
- **WHEN** `inline_css_into_html()` is called with an HTML string, storage root, session ID, and filename map
- **THEN** all `<link rel="stylesheet">` elements with resolvable CSS files are replaced with `<style>` tags
- **AND** CSS `url()` paths are adjusted based on the target path prefix (`./` for root, `../` for linked pages)

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
