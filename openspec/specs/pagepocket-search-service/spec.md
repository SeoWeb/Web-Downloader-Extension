# PagePocket Search Service Specification

## Purpose

Full-text indexing and querying of archived pages: byte-safe atomic index upserts, reliable delivery with durable pending-entry retries, user-scoped search with optional collection filtering via the library RPC, index removal, and multi-lingual tokenisation.

## Requirements

### Requirement: Index Upsert on Ingest
The Search Service SHALL expose an `IndexPage` RPC that atomically upserts a row into `search_db.page_index` with the page's title, URL, and extracted plain-text body, truncating the body by UTF-8 bytes (never by character count) before storage. Indexing SHALL be reliable: the archive service SHALL record a pending index entry durably with the page insert (same transaction), and delivery to `IndexPage` SHALL be retried with backoff until it succeeds, so an ingested page can never become permanently unsearchable due to a transient or swallowed search-service error.

#### Scenario: New page indexed
- **WHEN** `IndexPage` is called with `page_id`, `user_id`, `url`, `title`, `body_text`, and optional `tags`
- **THEN** the service MUST insert the row in `page_index` using a single atomic `INSERT … ON DUPLICATE KEY UPDATE` statement (no read-then-insert window)
- **AND** `body_text` MUST be truncated to fit the `MEDIUMTEXT` limit (16 MB of UTF-8 bytes, minus safety margin) via the shared byte-safe helper before storage
- **AND** return `StatusResponse { success=true }`

#### Scenario: Concurrent duplicate IndexPage calls
- **WHEN** two `IndexPage` calls for the same `page_id` execute concurrently
- **THEN** both MUST succeed (one insert, one duplicate-key update) — neither may fail with an unhandled `IntegrityError`

#### Scenario: CJK body near the size limit
- **WHEN** a page's body consists of multi-byte CJK characters whose UTF-8 encoding exceeds the byte limit
- **THEN** the stored `body_text` MUST be a valid UTF-8 string within the byte limit (no `Data too long` error, no permanent indexing failure)

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

### Requirement: Full-Text Search
The Search Service SHALL expose a `Search` RPC that returns pages matching a user query, scoped to the caller's `user_id`, with optional collection filtering resolved via the Library Service's user-scoped RPC (never via cross-schema SQL).

#### Scenario: Basic query
- **WHEN** `Search` is called with `user_id`, non-empty `query`, `page`, `page_size`
- **THEN** the service MUST execute a MySQL `MATCH(title, body_text) AGAINST (? IN NATURAL LANGUAGE MODE)` filtered by `user_id`
- **AND** return up to `page_size` results, each with `page_id`, `url`, `title`, a `snippet` (≤ 240 chars, surrounding the first match), a relevance `score`, and `archived_at`
- **AND** include `total` = total number of matching rows

#### Scenario: Collection filter via library RPC
- **WHEN** `Search` is called with a non-empty `collection_id`
- **THEN** the service MUST call `LibraryService.ListCollectionPageIds` (with the caller's `user_id`) and filter results to the returned page-id set
- **AND** MUST NOT issue SQL referencing `library_db`

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

### Requirement: Schema Isolation
The Search Service SHALL connect only to `search_db` with its own least-privilege MySQL user and SHALL NOT contain any cross-schema SQL; all knowledge of collections comes exclusively from library RPC responses.

#### Scenario: Service credentials scoped
- **WHEN** the search-service's `DB_URL` is configured for production
- **THEN** it MUST authenticate as `pagepocket_search` with grants on `search_db` only

#### Scenario: No embedded foreign-schema SQL
- **WHEN** `pagepocket/services/search-service/` is searched for schema-qualified references (e.g. `library_db.`)
- **THEN** none MUST be found
