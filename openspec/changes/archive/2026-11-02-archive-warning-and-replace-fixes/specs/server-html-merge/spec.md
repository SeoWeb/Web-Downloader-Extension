## ADDED Requirements

### Requirement: Same-index chunk replacement

When an HTML chunk is uploaded at a (page, scroll index) that already holds a chunk with different content, the server SHALL replace the superseded chunk: the database rows are swapped in the same transaction as the replacement insert, the chunk count is unchanged, and the merged output contains that scroll position's content exactly once. When the replaced index is the skeleton-source chunk (the chunk the page's skeleton was initialized from), the server SHALL regenerate the skeleton from the new content instead of registering the replacement as an appended chunk, so the merged output contains the first scroll's new content exactly once and the superseded first-scroll content is gone. Exact retransmissions (same content hash and scroll index) remain deduplicated without replacement.

#### Scenario: Non-zero index replacement swaps the registration

- **GIVEN** a page with chunks registered at scroll indexes 0 and 1
- **WHEN** a chunk with different content is uploaded at scroll index 1
- **THEN** the superseded chunk's registration is replaced, not appended
- **AND** the merged HTML contains the new index-1 content exactly once and never the superseded content

#### Scenario: Skeleton-source replacement regenerates the skeleton

- **GIVEN** a page whose skeleton was initialized from the scroll-index-0 chunk
- **WHEN** a chunk with different content is uploaded at scroll index 0
- **THEN** the skeleton is regenerated from the new content
- **AND** the merged HTML contains the new first-scroll content exactly once
- **AND** the superseded first-scroll content does not appear in the merged output

#### Scenario: Skeleton-source replacement after in-memory job eviction

- **GIVEN** the in-memory assembly job was evicted and reloaded from disk, with the skeleton-source chunk excluded from the chunk list
- **WHEN** a chunk with different content is uploaded at scroll index 0
- **THEN** the skeleton is regenerated from the new content
- **AND** the merged output does not duplicate the first scroll

#### Scenario: Exact retransmission stays deduplicated

- **WHEN** a chunk is uploaded with the same content hash and scroll index as an existing chunk
- **THEN** the upload is deduplicated and no replacement occurs

### Requirement: Chunk body text survives DOM merge

The DOM-based merge SHALL carry chunk body text — not only child elements — into the merged output. A chunk whose body is bare text with no element wrapper, alone or mixed with elements, SHALL appear in the merged HTML at the body insertion position. Bare-text content already contained in the skeleton SHALL NOT be duplicated.

#### Scenario: Text-only chunk is not dropped

- **GIVEN** a skeleton with element children and a chunk whose body is bare text with no element wrapper
- **WHEN** the DOM merge runs
- **THEN** the merged HTML contains the chunk's text

#### Scenario: Mixed text and elements are both preserved

- **GIVEN** a chunk whose body contains leading bare text followed by an element
- **WHEN** the DOM merge runs
- **THEN** the merged HTML contains both the text and the element

#### Scenario: Bare text already in the skeleton is not duplicated

- **GIVEN** a chunk whose bare-text body is already contained in the skeleton body
- **WHEN** the DOM merge runs
- **THEN** the skeleton is returned unchanged without duplicating the text
