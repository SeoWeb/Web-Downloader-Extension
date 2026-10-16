## ADDED Requirements

### Requirement: User-Scoped Collection-Id Cache
`ListCollectionPageIds` SHALL scope its cache key by both `user_id` and `collection_id` (never `collection_id` alone), and ownership SHALL be enforced on both the database path and the cache path so one user can never read another user's collection membership.

#### Scenario: Cache key includes the user
- **WHEN** user A and user B request page ids for the same `collection_id` string
- **THEN** the service MUST use distinct cache entries per `user_id` (no shared key)

#### Scenario: Cross-user collection access rejected before cache
- **WHEN** a caller requests page ids for a `collection_id` they do not own and a cache entry exists for another user
- **THEN** the service MUST perform the ownership check regardless of cache state and return `NOT_FOUND` (or `PERMISSION_DENIED`) without leaking the other user's id list

### Requirement: Page-Link Purge Contract
The Library Service SHALL expose a `PurgePageLinks(page_id)` RPC that deletes every `page_collections` row referencing `page_id`, so archive page deletions can keep collection membership and `page_count` values consistent.

#### Scenario: Purge removes all membership rows
- **WHEN** `PurgePageLinks` is called with a `page_id` present in three collections
- **THEN** the service MUST delete all three `page_collections` rows and return `StatusResponse { success=true }`

#### Scenario: Purge is idempotent
- **WHEN** `PurgePageLinks` is called for a `page_id` with no membership rows
- **THEN** the service MUST return `StatusResponse { success=true }` with no error

#### Scenario: Collection counts stay consistent after page deletion
- **WHEN** archive deletes a page and calls `PurgePageLinks`, then a client lists collections
- **THEN** each collection's `page_count` MUST equal its actual remaining `page_collections` rows (no count-vs-items drift)
