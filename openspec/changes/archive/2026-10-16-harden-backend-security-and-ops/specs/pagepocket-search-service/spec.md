## MODIFIED Requirements

### Requirement: Index Upsert on Ingest
The Search Service SHALL expose an `IndexPage` RPC that upserts a row into `search_db.page_index` with the page's title, URL, and extracted plain-text body. Indexing SHALL be reliable: the archive service SHALL record a pending index entry durably with the page insert (same transaction), and delivery to `IndexPage` SHALL be retried with backoff until it succeeds, so an ingested page can never become permanently unsearchable due to a transient or swallowed search-service error.

#### Scenario: New page indexed
- **WHEN** `IndexPage` is called with `page_id`, `user_id`, `url`, `title`, `body_text`, and optional `tags`
- **THEN** the service MUST insert (or update on duplicate PK) the row in `page_index` with the provided fields
- **AND** `body_text` MUST be truncated to the `MEDIUMTEXT` limit (16 MB) before storage
- **AND** return `StatusResponse { success=true }`

#### Scenario: Idempotent re-index
- **WHEN** `IndexPage` is called for an existing `page_id`
- **THEN** the service MUST overwrite the existing row's `title`, `url`, and `body_text` and keep `archived_at` unchanged if already set

#### Scenario: Indexing failure is retried, not swallowed
- **WHEN** the archive service's fire-and-forget indexing call fails (service down, timeout, error response)
- **THEN** the pending entry is retained and retried with backoff
- **AND** the failure is logged (never silently discarded)

#### Scenario: Persistently failing pages are observable
- **WHEN** an index entry exceeds the retry budget
- **THEN** it remains in the pending store and is reported by the observability surface (log/alert)
- **AND** a later successful re-index (or a sweep) clears it
