## MODIFIED Requirements

### Requirement: Session Size Limits

The server SHALL enforce configurable size limits on sessions to prevent abuse. The total session size SHALL be calculated as the sum of all resource sizes plus all HTML chunk sizes for the session. A same-index replacement upload (a chunk at an occupied page/scroll index with different content) SHALL be charged only its net growth — the new chunk size minus the superseded chunk size — against the limit; the pre-check SHALL determine replacement before charging so the superseded bytes are not counted twice.

#### Scenario: Default session size limit

- **WHEN** a session is created
- **THEN** the maximum total session size is 1000MB by default (configurable via `MAX_SESSION_SIZE_MB`)
- **AND** the maximum HTML chunk size is 25% of the total session limit

#### Scenario: Session size exceeded

- **WHEN** a resource upload would cause the session's total stored size (resources + HTML chunks) to exceed the configured limit
- **THEN** the upload is rejected with a 413 response
- **AND** the response body includes `current_size` reflecting the true total (resources + HTML chunks)

#### Scenario: Session size exceeded on HTML chunk upload

- **WHEN** an HTML chunk upload would cause the session's total stored size (resources + HTML chunks) to exceed the configured limit
- **THEN** the upload is rejected with a 413 response
- **AND** the response body includes `current_size` reflecting the true total (resources + HTML chunks)

#### Scenario: HTML chunk size stored in database

- **WHEN** an HTML chunk is uploaded
- **THEN** the chunk's byte size (UTF-8 encoded length) is stored in the `size` column of the `html_chunks` table
- **AND** the size is included in all subsequent session size calculations

#### Scenario: Size calculation query includes both tables

- **WHEN** the server checks cumulative session size for either a resource or HTML chunk upload
- **THEN** the query computes: `(SUM(resources.size) WHERE session_id = :id) + (SUM(html_chunks.size) WHERE session_id = :id)`
- **AND** uses COALESCE to treat NULL sums as 0

#### Scenario: Replacement within net growth is accepted near the limit

- **GIVEN** a session near `MAX_SESSION_SIZE_MB` holding an HTML chunk of size S at some (page, scroll index)
- **WHEN** a replacement chunk at the same (page, scroll index) is uploaded whose net growth (new size − S) fits within the remaining budget
- **THEN** the upload is accepted, even though `current_total + new size` alone would exceed the limit

#### Scenario: Replacement exceeding net growth is rejected

- **GIVEN** a session near `MAX_SESSION_SIZE_MB` holding an HTML chunk of size S at some (page, scroll index)
- **WHEN** a replacement chunk is uploaded whose net growth (new size − S) would exceed the remaining budget
- **THEN** the upload is rejected with 413 `session_size_exceeded` before any file is written
- **AND** the response body reports the pre-state total and the net growth as the upload size
