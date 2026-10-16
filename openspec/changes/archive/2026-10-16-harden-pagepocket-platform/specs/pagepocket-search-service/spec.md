## MODIFIED Requirements

### Requirement: Index Upsert on Ingest
The Search Service SHALL expose an `IndexPage` RPC that atomically upserts a row into `search_db.page_index` with the page's title, URL, and extracted plain-text body, truncating the body by UTF-8 bytes (never by character count) before storage.

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

## ADDED Requirements

### Requirement: Schema Isolation
The Search Service SHALL connect only to `search_db` with its own least-privilege MySQL user and SHALL NOT contain any cross-schema SQL; all knowledge of collections comes exclusively from library RPC responses.

#### Scenario: Service credentials scoped
- **WHEN** the search-service's `DB_URL` is configured for production
- **THEN** it MUST authenticate as `pagepocket_search` with grants on `search_db` only

#### Scenario: No embedded foreign-schema SQL
- **WHEN** `pagepocket/services/search-service/` is searched for schema-qualified references (e.g. `library_db.`)
- **THEN** none MUST be found
