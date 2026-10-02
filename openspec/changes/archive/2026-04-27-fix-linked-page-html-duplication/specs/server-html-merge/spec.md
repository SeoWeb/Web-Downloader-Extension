## MODIFIED Requirements

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

The server SHALL analyze HTML complexity to detect potential exponential growth scenarios before merging.

#### Scenario: Excessive element count detected

- **WHEN** the combined element count across skeleton and chunks exceeds 100,000 elements
- **THEN** the server uses the safe merge strategy instead of DOM-based merging

#### Scenario: Deeply nested structure detected

- **WHEN** the HTML contains elements with more than 50 levels of nesting
- **THEN** the server uses the safe merge strategy

#### Scenario: Large table structures detected

- **WHEN** the HTML contains tables with more than 5,000 rows
- **THEN** the server uses the safe merge strategy

## ADDED Requirements

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
