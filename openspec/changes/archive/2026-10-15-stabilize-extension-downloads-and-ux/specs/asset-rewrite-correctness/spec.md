## ADDED Requirements

### Requirement: Relative URLs resolved against the document URL
All file handlers SHALL resolve relative asset URLs against the URL of the HTML document in which they were found, not against the site origin.

#### Scenario: Page-relative asset on a nested page downloads
- **WHEN** `https://host/dir/page.html` references `img/x.png`
- **THEN** the asset is fetched from `https://host/dir/img/x.png`

#### Scenario: Linked-page assets resolve against the linked page
- **WHEN** a linked page at `https://host/a/b/post.html` references `../c/pic.jpg`
- **THEN** the asset is fetched from `https://host/c/pic.jpg`

#### Scenario: Dedup and fetch agree on the resolved URL
- **WHEN** the same relative URL string appears on the same page in both the dedup filter and a file handler
- **THEN** both resolve to the identical absolute URL and the asset is fetched exactly once

### Requirement: Charset-aware text decoding
Stylesheet and other text assets SHALL be decoded using the charset declared by the response `Content-Type` header, else the file's `@charset` rule, else UTF-8.

#### Scenario: Shift_JIS stylesheet is not corrupted
- **WHEN** a CSS file is served with `Content-Type: text/css; charset=Shift_JIS`
- **THEN** the uploaded content preserves the original characters

#### Scenario: Charset from @charset when header is absent
- **WHEN** a CSS file has no charset header but starts with `@charset "iso-8859-1";`
- **THEN** the content is decoded as ISO-8859-1

### Requirement: Imported stylesheets and favicons are captured
The extractor SHALL discover `@import` rules (URL and string forms, up to a depth cap of 3) as additional CSS resources, and `link rel="icon"`, `rel="shortcut icon"`, and `rel="apple-touch-icon"` as image resources.

#### Scenario: Nested import downloads
- **WHEN** `main.css` contains `@import url("theme.css")` and `theme.css` contains `@import "reset.css"`
- **THEN** both `theme.css` and `reset.css` are downloaded and included in the archive

#### Scenario: Favicon downloads
- **WHEN** the page declares `<link rel="icon" href="/favicon.ico">`
- **THEN** the favicon is downloaded and mapped for rewriting

#### Scenario: Import cycles terminate
- **WHEN** two stylesheets import each other
- **THEN** each is downloaded once and the recursion stops at the depth cap

### Requirement: Collision-free archive paths
Every uploaded asset SHALL receive an archive path derived from its URL pathname (sanitized, query string hashed into the filename), so that files with identical basenames from different directories do not overwrite each other. The asset registry, the filename map, and the uploaded path SHALL use the same path builder.

#### Scenario: Two same-basename stylesheets coexist
- **WHEN** `/a/main.css` and `/b/main.css` are both downloaded
- **THEN** they are stored at distinct archive paths and both appear with their own content

#### Scenario: Registry keys match uploaded paths
- **WHEN** an asset is registered and later looked up for rewriting
- **THEN** the registry entry and the uploaded archive path are identical strings

### Requirement: Non-downloadable URL schemes are filtered
Resource extraction SHALL NOT enqueue URLs with `blob:`, `data:`, `chrome-extension:`, `moz-extension:`, or fragment-only values as fetchable assets.

#### Scenario: Blob URL does not poison the queue
- **WHEN** an `<img src="blob:https://host/uuid">` is present
- **THEN** it is not fetched and is recorded as a skipped resource

#### Scenario: SVG fragment reference is not fetched as an image
- **WHEN** CSS contains `url(#gradient)`
- **THEN** it is not enqueued as an asset fetch

### Requirement: Linked-page collection is bounded
In linked-page modes other than full-site crawling, the system SHALL NOT upload arbitrary `<a href>` targets as HTML documents. Only URLs that resolve to HTML content (verified by content type) and stay within configured limits SHALL be included.

#### Scenario: PDF link is not uploaded as HTML
- **WHEN** a page links to a PDF and a non-full linked-page download runs
- **THEN** the PDF is not uploaded as a `linked` HTML document

#### Scenario: Non-HTML response is skipped
- **WHEN** a collected link responds with a non-HTML content type
- **THEN** it is skipped without uploading and counted as skipped
