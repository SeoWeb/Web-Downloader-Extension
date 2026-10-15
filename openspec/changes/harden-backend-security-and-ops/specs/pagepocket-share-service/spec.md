## MODIFIED Requirements

### Requirement: Share Link Creation
The Share Service SHALL expose a `CreateShareLink` RPC that issues an unguessable token for a user-owned page. The service SHALL verify that the page exists and is owned by the requesting `user_id` before creating a link; share creation for a page the caller does not own SHALL be rejected.

#### Scenario: Create token
- **WHEN** `CreateShareLink` is called with `user_id`, `page_id`, `is_public`, `expires_at` (0 = never) and the page is owned by `user_id`
- **THEN** the service MUST generate a 32-byte random token, encode it URL-safe base64 (43 chars, becomes the `token` PK), and insert a row into `share_db.share_links`
- **AND** return `ShareLinkResponse { token, short_url=<BASE_URL>/s/<token>, is_public, expires_at, view_count=0 }`

#### Scenario: Foreign page cannot be shared
- **WHEN** `CreateShareLink` is called with a `page_id` that does not exist or belongs to another user
- **THEN** the service MUST return `NOT_FOUND` (never distinguishing the two) and create no row
- **AND** enumeration of other users' pages via share creation is impossible

#### Scenario: Existing active link for same page
- **WHEN** `CreateShareLink` is called for a `(user_id, page_id)` pair that already has an active (non-revoked, non-expired) link
- **THEN** the service MAY return the existing `ShareLinkResponse` rather than create a duplicate, but MUST never create multiple active links for the same pair

### Requirement: Token Validation
The Share Service SHALL expose a `ValidateToken` RPC used by the API Gateway's public viewer route. On success it SHALL return the page id AND the page owner's `user_id` (`owner_user_id`), so downstream file access can be performed with mandatory ownership checks instead of an identity bypass.

#### Scenario: Valid public token
- **WHEN** `ValidateToken` is called with a `token` whose row has `revoked_at IS NULL`, `is_public=true`, and (`expires_at IS NULL` OR `expires_at > NOW()`)
- **THEN** the service MUST atomically increment `view_count` and return `ValidateShareResponse { valid=true, page_id=<page_id>, owner_user_id=<pages.user_id> }`

#### Scenario: Downstream access uses the resolved owner
- **WHEN** the gateway serves share content after a successful validation
- **THEN** it passes `owner_user_id` as the `user_id` for `GetPageContent`/`GetArchiveFile`
- **AND** no internal call uses an empty `user_id` to bypass ownership

#### Scenario: Revoked token
- **WHEN** `ValidateToken` is called with a token whose `revoked_at` is set
- **THEN** return `ValidateShareResponse { valid=false, page_id="", owner_user_id="" }`

#### Scenario: Expired token
- **WHEN** `ValidateToken` is called with a token whose `expires_at` is in the past
- **THEN** return `ValidateShareResponse { valid=false, page_id="", owner_user_id="" }`

#### Scenario: Private token
- **WHEN** `ValidateToken` is called with a token whose `is_public=false`
- **THEN** return `ValidateShareResponse { valid=false, page_id="", owner_user_id="" }`

#### Scenario: Unknown token
- **WHEN** `ValidateToken` is called with a `token` that does not exist
- **THEN** return `ValidateShareResponse { valid=false, page_id="", owner_user_id="" }` (do not distinguish from expired/revoked to prevent enumeration)
