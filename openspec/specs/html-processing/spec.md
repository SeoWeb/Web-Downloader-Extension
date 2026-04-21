# HTML Processing Specification

## Purpose

HTML conversion, merging, and incremental assembly for the Website Downloader extension. Covers how raw HTML content is transformed for offline use -- either by converting resource URLs to relative paths (ZIP mode) or by inlining resources as base64 (single-file mode).

## Requirements

### Requirement: ZIP Mode URL Conversion

The system SHALL convert all resource URLs in the HTML to relative local paths for ZIP archive packaging.

#### Scenario: Image src conversion

- GIVEN an HTML document containing `<img src="https://example.com/images/photo.jpg">`
- WHEN ZIP mode conversion is applied
- THEN the src attribute is changed to `./images/photo.jpg`
- AND the image filename map is consulted first for correct extensions from Content-Type headers

#### Scenario: Image with extension-less URL

- GIVEN an HTML document containing `<img src="https://example.com/xid-31821076_1">`
- WHEN ZIP mode conversion is applied
- THEN the system generates a safe filename for the image
- AND the src is changed to `./images/<generated-filename>`

#### Scenario: CSS link href conversion

- GIVEN an HTML document containing `<link rel="stylesheet" href="https://example.com/css/style.css">`
- WHEN ZIP mode conversion is applied
- THEN the href is changed to `./styles/style.css`

#### Scenario: JavaScript src conversion

- GIVEN an HTML document containing `<script src="https://example.com/js/app.js">`
- WHEN ZIP mode conversion is applied
- THEN the src is changed to `./scripts/app.js`

#### Scenario: Anchor href conversion for same-origin links

- GIVEN an HTML document containing `<a href="https://example.com/about">`
- WHEN ZIP mode conversion is applied
- AND the link origin matches the page origin
- THEN the href is changed to `./pages/about.html`

#### Scenario: External links preserved

- GIVEN an HTML document containing `<a href="https://other-site.com/page">`
- WHEN ZIP mode conversion is applied
- AND the link origin differs from the page origin
- THEN the href is left unchanged

#### Scenario: Background image URL conversion in inline styles

- GIVEN an HTML element with `style="background-image: url('https://example.com/bg.jpg')"`
- WHEN ZIP mode conversion is applied
- THEN the background-image URL is changed to `./images/bg.jpg`

#### Scenario: Background image URL conversion in style tags

- GIVEN a `<style>` tag containing `background-image: url('https://example.com/bg.jpg')`
- WHEN ZIP mode conversion is applied
- THEN the background-image URL within the style tag is changed to `./images/bg.jpg`

#### Scenario: Object element conversion

- GIVEN an HTML document containing `<object data="https://example.com/file.swf">`
- WHEN ZIP mode conversion is applied
- THEN the data attribute is converted to a relative local path

### Requirement: Single-File Mode Base64 Inlining

The system SHALL inline all external resources as base64 data URLs when single-file mode is selected.

#### Scenario: Image base64 inlining

- GIVEN an HTML document containing `<img src="https://example.com/photo.jpg">`
- WHEN single-file mode conversion is applied
- THEN the image is fetched and converted to a base64 data URL
- AND the src attribute is replaced with the data URL

#### Scenario: Already-base64 images preserved

- GIVEN an HTML document containing `<img src="data:image/png;base64,...">`
- WHEN single-file mode conversion is applied
- THEN the image src is left unchanged

#### Scenario: Stylesheet base64 inlining

- GIVEN an HTML document containing `<link rel="stylesheet" href="https://example.com/style.css">`
- WHEN single-file mode conversion is applied
- THEN the CSS is fetched and the link element is replaced with a `<style>` element containing the CSS content

#### Scenario: Script base64 inlining

- GIVEN an HTML document containing `<script src="https://example.com/app.js">`
- WHEN single-file mode conversion is applied
- THEN the script is fetched and the script element is replaced with an inline `<script>` containing the JavaScript content

#### Scenario: Failed resource fetch in single-file mode

- GIVEN a resource URL that fails to fetch
- WHEN single-file mode conversion is applied
- THEN the original URL is preserved for images
- AND empty content is used for scripts and stylesheets

### Requirement: Base Tag Removal

The system SHALL remove `<base>` tags from the HTML during conversion.

#### Scenario: Base tag present

- GIVEN an HTML document containing a `<base href="https://example.com/">` tag
- WHEN either ZIP or single-file conversion is applied
- THEN the base tag is removed from the document
- AND relative URLs are resolved correctly without the base tag

### Requirement: HTML Merging

The system SHALL support merging two HTML documents, combining their content intelligently.

#### Scenario: Matching parent containers

- GIVEN two HTML documents with matching parent container structures
- WHEN the merge is performed
- AND the first child elements of the matching containers are identical
- THEN the second document's content is used as the result

#### Scenario: Differing child elements

- GIVEN two HTML documents with matching parent containers but different children
- WHEN the merge is performed
- THEN the children from the second document are appended to the first document's container

#### Scenario: Merge with exponential complexity

- GIVEN two HTML documents with extremely complex or duplicate structures
- WHEN the merge detects exponential growth risk
- THEN a safe merge strategy is used
- AND only body content is concatenated with size limits

#### Scenario: Merged HTML exceeds size limit

- GIVEN two HTML documents whose combined size exceeds the maximum HTML content size
- WHEN the merge is performed
- THEN the content is truncated
- AND a truncation comment is inserted

#### Scenario: Invalid HTML input

- GIVEN HTML content that does not contain basic HTML structure tags
- WHEN the merge is attempted
- THEN an error is thrown indicating invalid HTML content

### Requirement: Incremental HTML Assembly

The system SHALL support chunk-based incremental HTML assembly as an alternative to DOM-based merging.

#### Scenario: Assembly job initialization

- GIVEN a skeleton HTML string and a job ID
- WHEN a new assembly job is initialized
- THEN the skeleton is stored with the insertion point ensured
- AND the job is ready to receive chunks

#### Scenario: Adding a chunk successfully

- GIVEN an active assembly job
- AND memory pressure is not critical
- AND the chunk does not exceed size limits
- WHEN a chunk is added
- THEN the chunk is stored in the job
- AND the job's total size is updated

#### Scenario: Duplicate chunk detection

- GIVEN an active assembly job with deduplication enabled
- AND a chunk with identical content has already been added
- WHEN the same chunk is added again
- THEN the duplicate is detected and skipped
- AND the result indicates the chunk was not added but the operation was successful

#### Scenario: Chunk exceeds size limit

- GIVEN an active assembly job
- AND a chunk exceeds 25% of the maximum total HTML size
- WHEN the chunk is added
- THEN the chunk is rejected with a size limit reason

#### Scenario: Critical memory pressure during assembly

- GIVEN an active assembly job
- AND memory pressure is critical
- WHEN a chunk is added
- THEN the chunk is rejected with a memory pressure reason

#### Scenario: High memory pressure with large chunk

- GIVEN an active assembly job
- AND memory pressure is high
- AND the chunk exceeds half the maximum chunk size
- WHEN the chunk is added
- THEN the chunk is rejected to conserve memory

#### Scenario: Assembly finalization

- GIVEN an active assembly job with accumulated chunks
- WHEN the job is finalized
- THEN the chunks are inserted at the insertion point in the skeleton
- AND the complete HTML string is returned
- AND a Blob of the result is provided
- AND the job is cleaned up

#### Scenario: Assembly fallback on failure

- GIVEN an incremental assembly job that fails
- WHEN the merge is attempted
- THEN the system falls back to the traditional DOM-based merge
- AND the original HTML content is preserved

### Requirement: Stale Assembly Job Cleanup

The system SHALL clean up assembly jobs that have not been updated within a configurable time period.

#### Scenario: Job exceeds maximum age

- GIVEN an assembly job that has not been updated for more than 30 minutes
- WHEN the cleanup routine runs
- THEN the job is removed from memory
- AND the number of cleaned jobs is returned
