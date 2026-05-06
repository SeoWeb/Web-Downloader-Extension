## ADDED Requirements

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
