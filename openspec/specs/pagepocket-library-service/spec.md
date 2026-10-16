# PagePocket Library Service Specification

## Purpose

Collections and page-collection membership: CRUD for user-owned collections, membership management, user-scoped collection-id caching, and page-link purging.

## Requirements

### Requirement: Collections CRUD
The Library Service SHALL expose RPCs to create, read, update, delete, and list collections owned by a user, optionally nested under a parent collection.

#### Scenario: Create collection
- **WHEN** `CreateCollection` is called with `user_id`, non-empty `name`, optional `description`, optional `parent_id`, and optional hex `color`
- **THEN** the service MUST insert a row into `library_db.collections` with a new UUIDv4 `id`, default `color='#6B7280'` if unspecified, and return a `CollectionResponse`
- **AND** if `parent_id` is provided but the row does not exist or does not belong to `user_id`, return `INVALID_ARGUMENT`

#### Scenario: Update collection
- **WHEN** `UpdateCollection` is called with `collection_id`, `user_id`, and at least one of `name`, `description`, `color`
- **THEN** the service MUST update only the provided fields on the row where `collection_id` matches and `user_id` owns the collection
- **AND** return the updated `CollectionResponse`
- **AND** return `NOT_FOUND` if the collection does not exist or is not owned by `user_id`

#### Scenario: Delete collection
- **WHEN** `DeleteCollection` is called with `collection_id` and `user_id`
- **THEN** the service MUST delete the row
- **AND** child collections' `parent_id` MUST be set to NULL (ON DELETE SET NULL)
- **AND** all rows in `page_collections` referencing this `collection_id` MUST be removed (ON DELETE CASCADE)

#### Scenario: List collections
- **WHEN** `ListCollections` is called with `user_id` and optional `parent_id`
- **THEN** return every collection owned by `user_id` whose `parent_id` matches the filter (or NULL if `parent_id` is empty)
- **AND** each `CollectionResponse` MUST include a `page_count` computed from `page_collections`

### Requirement: Page-Collection Membership
The Library Service SHALL expose RPCs to add and remove a page from a collection, enforcing ownership of BOTH the collection and the page. A membership write SHALL be rejected when the caller does not own the page, the collection, or both.

#### Scenario: Add page to collection
- **WHEN** `AddPageToCollection` is called with `user_id`, `page_id`, `collection_id`
- **THEN** the service MUST verify the collection is owned by `user_id`
- **AND** MUST verify the page exists and `pages.user_id` matches `user_id`
- **AND** insert a row into `page_collections` (composite PK `page_id,collection_id`) or silently succeed if the pair already exists
- **AND** return `StatusResponse { success=true }`

#### Scenario: Remove page from collection
- **WHEN** `RemovePageFromCollection` is called with the same triple
- **THEN** the service MUST verify ownership of the collection (and page for symmetry)
- **AND** delete the matching row if present and return `StatusResponse { success=true }`

#### Scenario: Collection ownership violation
- **WHEN** an add/remove call targets a `collection_id` not owned by `user_id`
- **THEN** the service MUST return `PERMISSION_DENIED` and perform no writes

#### Scenario: Page ownership violation
- **WHEN** an add call references a `page_id` that does not exist or is owned by another user
- **THEN** the service MUST return `NOT_FOUND` (never leaking another user's page existence) and perform no writes
- **AND** the page therefore cannot be enumerated via another user's `ListPages(collection_id)`

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
