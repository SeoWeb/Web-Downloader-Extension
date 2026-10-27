## ADDED Requirements

### Requirement: Durable uploads before success response

Upload endpoints that mutate session state — resource upload, HTML chunk upload, and filename-map upload — SHALL commit their database transaction BEFORE the HTTP success response is sent, so no commit can fail after the client has been told success. A commit failure SHALL surface to the client as an error response (never a 200), and any file written during the failed request SHALL be removed, leaving no orphan row or file. The `get_db()` teardown commit SHALL remain as a safety net; endpoints without database mutations (content-text upload) are exempt.

#### Scenario: Upload commits before the response is sent

- **WHEN** a resource, HTML chunk, or filename-map upload completes with a success response
- **THEN** the transaction for that upload has already been committed
- **AND** a request issued immediately afterwards (e.g. finalize) observes the committed state

#### Scenario: Post-200 commit failure is impossible

- **GIVEN** the database commit fails during an upload (pool exhaustion, deadlock, database restart)
- **WHEN** the upload request completes
- **THEN** the client receives a 5xx error response, not a success
- **AND** no resource row, chunk row, or map mutation survives
- **AND** any file written during the request has been removed
