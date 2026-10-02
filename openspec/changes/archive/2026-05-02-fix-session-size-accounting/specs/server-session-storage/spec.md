## MODIFIED Requirements

### Requirement: Session Size Limits

The server SHALL enforce configurable size limits on sessions to prevent abuse. The total session size SHALL be calculated as the sum of all resource sizes plus all HTML chunk sizes for the session.

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

## ADDED Requirements

### Requirement: HTML chunk size column migration

The server SHALL include an Alembic migration that adds a `size` column (BigInteger, not null, server_default=0) to the `html_chunks` table.

#### Scenario: Migration adds size column

- **WHEN** the Alembic migration runs
- **THEN** a `size` column of type BigInteger is added to `html_chunks`
- **AND** the column has a server default of 0
- **AND** existing rows retain their data with size=0

#### Scenario: Downgrade removes size column

- **WHEN** the Alembic migration is downgraded
- **THEN** the `size` column is dropped from `html_chunks`
