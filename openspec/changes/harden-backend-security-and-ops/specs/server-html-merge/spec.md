## MODIFIED Requirements

### Requirement: Incremental HTML Chunk Merging
The server SHALL merge HTML chunks incrementally as they are uploaded, using a skeleton-and-chunks approach similar to the client-side HtmlAssembler. The merge is performed when the session transitions from `uploading` to `assembling` status (triggered by finalization after scrape-complete). When the skeleton is reconstructed from the first chunk (after a server restart), that chunk SHALL be marked as consumed so it is not emitted a second time as body content.

#### Scenario: First chunk initializes skeleton
- **WHEN** the first HTML chunk is uploaded to a session
- **THEN** the server stores it as the HTML skeleton document
- **AND** identifies the insertion point (default: before `</body>`)

#### Scenario: Subsequent chunks are queued
- **WHEN** additional HTML chunks are uploaded
- **THEN** the server stores them as queued chunks associated with the session
- **AND** tracks the total accumulated size

#### Scenario: Restart-during-upload does not duplicate the first scroll
- **WHEN** the server restarts during a scrape and the merge reconstructs the skeleton from the scrollIndex-0 chunk
- **THEN** that chunk is excluded from the chunk list applied into the skeleton
- **AND** the merged HTML contains the first scroll's content exactly once

#### Scenario: Chunk deduplication by hash and scrollIndex
- **WHEN** an HTML chunk has the same content hash AND scrollIndex as a previously uploaded chunk for the same session and page (main or linked)
- **THEN** the server skips the duplicate chunk and does not increase the total size
- **AND** returns a response indicating the chunk was deduplicated
- **AND** chunks with the same hash but different scrollIndex are NOT deduplicated (the same content may appear at different scroll positions; this strategy favors correctness for network retries at the cost of potential duplication in the merged HTML)
