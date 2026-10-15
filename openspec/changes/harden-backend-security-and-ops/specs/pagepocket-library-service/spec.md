## MODIFIED Requirements

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
