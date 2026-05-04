# Server HTML Merge Specification

## Purpose

Server-side HTML chunk merging for the Website Downloader microservice. Covers incremental chunk storage, linked page separation, full merge on finalization, complexity analysis, and output validation.

## Requirements

### Requirement: Incremental HTML Chunk Merging

The server SHALL merge HTML chunks incrementally as they are uploaded, using a skeleton-and-chunks approach similar to the client-side HtmlAssembler. The merge is performed when the session transitions from `uploading` to `assembling` status (triggered by finalization after scrape-complete).

#### Scenario: First chunk initializes skeleton

- **WHEN** the first HTML chunk is uploaded to a session
- **THEN** the server stores it as the HTML skeleton document
- **AND** identifies the insertion point (default: before `</body>`)

#### Scenario: Subsequent chunks are queued

- **WHEN** additional HTML chunks are uploaded
- **THEN** the server stores them as queued chunks associated with the session
- **AND** tracks the total accumulated size

#### Scenario: Chunk deduplication by hash and scrollIndex

- **WHEN** an HTML chunk has the same content hash AND scrollIndex as a previously uploaded chunk for the same session and page (main or linked)
- **THEN** the server skips the duplicate chunk and does not increase the total size
- **AND** returns a response indicating the chunk was deduplicated
- **AND** chunks with the same hash but different scrollIndex are NOT deduplicated (the same content may appear at different scroll positions; this strategy favors correctness for network retries at the cost of potential duplication in the merged HTML)

### Requirement: Linked Page HTML Merge

The server SHALL merge HTML chunks for linked pages separately from the main page, producing a separate merged HTML document per linked page.

#### Scenario: Linked page chunk storage

- **WHEN** HTML chunks are uploaded with `pageType: linked` and a `pageUrl` identifier
- **THEN** the server stores them in a separate chunk list per `pageUrl`
- **AND** deduplication applies independently per page

#### Scenario: Linked page merge on finalization

- **WHEN** the session is finalized
- **THEN** each linked page's chunks are merged independently using the same skeleton-and-chunks algorithm
- **AND** each linked page produces a separate merged HTML document for the `pages/` directory

### Requirement: Full HTML Merge on Finalization

The server SHALL produce a complete merged HTML document when the session is finalized, combining the skeleton and all chunks. The merge SHALL NOT produce duplicated body content.

#### Scenario: Skeleton with body insertion point

- **WHEN** the session is finalized and the skeleton contains a `</body>` tag
- **THEN** all chunks are inserted before the `</body>` tag in the skeleton
- **AND** the resulting HTML is a valid, well-formed document

#### Scenario: Skeleton without body tag

- **WHEN** the session is finalized and the skeleton does not contain a `</body>` tag
- **THEN** the chunks are appended at the end of the HTML
- **AND** a warning is logged about the missing insertion point

#### Scenario: Safe merge fallback for complex HTML

- **WHEN** the merge produces content exceeding the configured maximum HTML size
- **THEN** the server falls back to a safe merge that concatenates only body content
- **AND** truncates with a comment if the combined content exceeds limits
- **AND** the safe merge SHALL deduplicate chunk body content that is identical to or a subset of the skeleton body content

#### Scenario: Safe merge skips duplicate body content

- **WHEN** the safe merge is triggered and a chunk's body content is identical to the skeleton body
- **THEN** the chunk's body content SHALL be skipped
- **AND** the merged output SHALL contain the skeleton body content exactly once

#### Scenario: Safe merge skips subset body content

- **WHEN** the safe merge is triggered and a chunk's body content is a substring of the skeleton body
- **THEN** the chunk's body content SHALL be skipped
- **AND** only chunks with genuinely new body content SHALL be appended

### Requirement: HTML Complexity Analysis

The server SHALL analyze HTML complexity using per-document analysis to detect potential exponential growth scenarios before merging.

#### Scenario: Excessive element count detected

- **WHEN** the combined element count across skeleton and chunks exceeds 100,000 elements
- **THEN** the server uses the safe merge strategy instead of DOM-based merging

#### Scenario: Deeply nested structure detected

- **WHEN** ANY individual document (skeleton or any chunk file) contains elements with more than 50 levels of nesting
- **THEN** the server uses the safe merge strategy

#### Scenario: Large table detected

- **WHEN** ANY individual document (skeleton or any chunk file) contains a table with more than 5,000 rows
- **THEN** the server uses the safe merge strategy

#### Scenario: Excessive nested tables

- **WHEN** ANY individual document (skeleton or any chunk file) contains more than 10 nested tables
- **THEN** the server uses the safe merge strategy

#### Scenario: Early-exit on element threshold

- **WHEN** the running element count total exceeds 100,000 during per-chunk counting
- **THEN** the server immediately returns `is_complex=True` without processing remaining chunks

### Requirement: DOM Merge Superset Detection

The DOM merge SHALL detect when all chunk body content is a subset of the skeleton body content and return the skeleton as-is without appending.

#### Scenario: All chunks identical to skeleton

- **WHEN** the DOM merge runs and all chunk body content is identical to the skeleton body content
- **THEN** the skeleton HTML SHALL be returned unchanged
- **AND** no chunk body content SHALL be appended

#### Scenario: All chunks are subsets of skeleton

- **WHEN** the DOM merge runs and each chunk's body content is a substring of the skeleton body content
- **THEN** the skeleton HTML SHALL be returned unchanged
- **AND** no chunk body content SHALL be appended

#### Scenario: First-child match but remaining content differs

- **WHEN** the DOM merge runs and the first body child of the combined chunks matches the skeleton's first body child
- **AND** the combined chunks contain body children NOT present in the skeleton
- **THEN** the new body children SHALL be appended to the skeleton
- **AND** the existing skeleton body content SHALL NOT be duplicated

### Requirement: Merged HTML Validation

The server SHALL validate the merged HTML output to ensure it is well-formed.

#### Scenario: Valid merged output

- **WHEN** the merge is complete and the output passes validation
- **THEN** the merged HTML is stored as the session's final HTML content under `<storage_root>/<session_id>/output/merged.html`
- **AND** all chunk files are deleted from `<storage_root>/<session_id>/chunks/` to reclaim disk space
- **AND** the HTML chunk records in the database are marked as merged (or deleted)

#### Scenario: Invalid merged output

- **WHEN** the merge produces malformed HTML
- **THEN** the server attempts a safe merge as fallback
- **AND** if the safe merge also fails, marks the session as `failed` with an error message
