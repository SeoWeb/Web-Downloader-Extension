## ADDED Requirements

### Requirement: Share Link Creation
The Share Service SHALL expose a `CreateShareLink` RPC that issues an unguessable token for a user-owned page.

#### Scenario: Create token
- **WHEN** `CreateShareLink` is called with `user_id`, `page_id`, `is_public`, `expires_at` (0 = never)
- **THEN** the service MUST generate a 32-byte random token, encode it URL-safe base64 (43 chars, becomes the `token` PK), and insert a row into `share_db.share_links`
- **AND** return `ShareLinkResponse { token, short_url=<BASE_URL>/s/<token>, is_public, expires_at, view_count=0 }`

#### Scenario: Existing active link for same page
- **WHEN** `CreateShareLink` is called for a `(user_id, page_id)` pair that already has an active (non-revoked, non-expired) link
- **THEN** the service MAY return the existing `ShareLinkResponse` rather than create a duplicate (implementation decision), but MUST never create multiple active links for the same pair

### Requirement: Token Validation
The Share Service SHALL expose a `ValidateToken` RPC used by the API Gateway's public viewer route.

#### Scenario: Valid public token
- **WHEN** `ValidateToken` is called with a `token` whose row has `revoked_at IS NULL`, `is_public=true`, and (`expires_at IS NULL` OR `expires_at > NOW()`)
- **THEN** the service MUST atomically increment `view_count` and return `ValidateShareResponse { valid=true, page_id=<page_id> }`

#### Scenario: Revoked token
- **WHEN** `ValidateToken` is called with a token whose `revoked_at` is set
- **THEN** return `ValidateShareResponse { valid=false, page_id="" }`

#### Scenario: Expired token
- **WHEN** `ValidateToken` is called with a token whose `expires_at` is in the past
- **THEN** return `ValidateShareResponse { valid=false, page_id="" }`

#### Scenario: Private token
- **WHEN** `ValidateToken` is called with a token whose `is_public=false`
- **THEN** return `ValidateShareResponse { valid=false, page_id="" }` (private tokens are validated by a separate authenticated path not in scope for this spec)

#### Scenario: Unknown token
- **WHEN** `ValidateToken` is called with a `token` that does not exist
- **THEN** return `ValidateShareResponse { valid=false, page_id="" }` (do not distinguish from expired/revoked to prevent enumeration)

### Requirement: Share Link Revocation
The Share Service SHALL expose a `RevokeShareLink` RPC that sets `revoked_at` on a user-owned share row.

#### Scenario: Successful revoke
- **WHEN** `RevokeShareLink` is called with `token` and `user_id` where the row's `user_id` matches
- **THEN** the service MUST set `revoked_at = NOW()` and return `StatusResponse { success=true }`
- **AND** subsequent `ValidateToken` calls MUST return `valid=false`

#### Scenario: Cross-user revoke blocked
- **WHEN** `RevokeShareLink` is called with a `user_id` that does not own the row
- **THEN** the service MUST return `StatusResponse { success=false, message="not found" }` and NOT modify the row

### Requirement: Token Metadata Retrieval
The Share Service SHALL expose a `GetShareLink` RPC used by the owner's management UI.

#### Scenario: Owner retrieves link
- **WHEN** `GetShareLink` is called with a `token`
- **THEN** return `ShareLinkResponse` with current `is_public`, `expires_at`, and `view_count`
- **AND** the caller (API Gateway) MUST ensure `authenticated user_id == row.user_id` before forwarding; the service itself does not enforce ownership on this RPC
