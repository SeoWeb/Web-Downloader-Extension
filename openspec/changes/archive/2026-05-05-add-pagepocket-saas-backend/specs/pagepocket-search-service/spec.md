## ADDED Requirements

### Requirement: Index Upsert on Ingest
The Search Service SHALL expose an `IndexPage` RPC that upserts a row into `search_db.page_index` with the page's title, URL, and extracted plain-text body.

#### Scenario: New page indexed
- **WHEN** `IndexPage` is called with `page_id`, `user_id`, `url`, `title`, `body_text`, and optional `tags`
- **THEN** the service MUST insert (or update on duplicate PK) the row in `page_index` with the provided fields
- **AND** `body_text` MUST be truncated to the `MEDIUMTEXT` limit (16 MB) before storage
- **AND** return `StatusResponse { success=true }`

#### Scenario: Idempotent re-index
- **WHEN** `IndexPage` is called for an existing `page_id`
- **THEN** the service MUST overwrite the existing row's `title`, `url`, and `body_text` and keep `archived_at` unchanged if already set

### Requirement: Full-Text Search
The Search Service SHALL expose a `Search` RPC that returns pages matching a user query, scoped to the caller's `user_id`, with optional collection filtering.

#### Scenario: Basic query
- **WHEN** `Search` is called with `user_id`, non-empty `query`, `page`, `page_size`
- **THEN** the service MUST execute a MySQL `MATCH(title, body_text) AGAINST (? IN NATURAL LANGUAGE MODE)` filtered by `user_id`
- **AND** return up to `page_size` results, each with `page_id`, `url`, `title`, a `snippet` (≤ 240 chars, surrounding the first match), a relevance `score`, and `archived_at`
- **AND** include `total` = total number of matching rows

#### Scenario: Collection filter
- **WHEN** `Search` is called with a non-empty `collection_id`
- **THEN** the service MUST join against `library_db.page_collections` (cross-schema) and return only `page_id`s present in that collection

#### Scenario: User isolation
- **WHEN** `Search` is called with any `query`
- **THEN** results MUST NEVER include rows whose `user_id` differs from the caller's

#### Scenario: Empty query
- **WHEN** `Search` is called with an empty or whitespace-only `query`
- **THEN** the service MUST return `INVALID_ARGUMENT`

### Requirement: Index Removal
The Search Service SHALL expose a `RemovePage` RPC that deletes the index row for a page.

#### Scenario: Successful removal
- **WHEN** `RemovePage` is called with `page_id` and `user_id` matching the indexed row
- **THEN** the service MUST delete the row and return `StatusResponse { success=true }`

#### Scenario: Missing row
- **WHEN** `RemovePage` is called for a `page_id` that is not indexed
- **THEN** the service MUST return `StatusResponse { success=true }` (idempotent)

### Requirement: Multi-Lingual Tokenisation
The `page_index.body_text` FULLTEXT index SHALL use the MySQL `ngram` parser so CJK and short-token queries are searchable.

#### Scenario: CJK query
- **WHEN** a user indexes a page with Japanese, Chinese, or Korean body text and later searches with a short token (e.g. two-character query)
- **THEN** the ngram-parsed FULLTEXT index MUST return the page among the results
