## ADDED Requirements

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
The Library Service SHALL expose RPCs to add and remove a page from a collection, enforcing user ownership.

#### Scenario: Add page to collection
- **WHEN** `AddPageToCollection` is called with `user_id`, `page_id`, `collection_id`
- **THEN** the service MUST verify the collection is owned by `user_id`
- **AND** insert a row into `page_collections` (composite PK `page_id,collection_id`) or silently succeed if the pair already exists
- **AND** return `StatusResponse { success=true }`

#### Scenario: Remove page from collection
- **WHEN** `RemovePageFromCollection` is called with the same triple
- **THEN** the service MUST delete the matching row if present and return `StatusResponse { success=true }`

#### Scenario: Ownership violation
- **WHEN** an add/remove call targets a `collection_id` not owned by `user_id`
- **THEN** the service MUST return `PERMISSION_DENIED` and perform no writes
