# PagePocket Share Service Specification

## Purpose

Public share links for archived pages: token creation with hash-only storage and mandatory page ownership, validation with deduplicated view counting and owner resolution, immediate revocation with cache invalidation, and link lifecycle/cleanup.

## Requirements

### Requirement: Share Link Creation
The Share Service SHALL expose a `CreateShareLink` RPC that issues an unguessable token for a user-owned page while persisting only a cryptographic hash of the token — the plaintext token value SHALL never be stored at rest. The service SHALL verify that the page exists and is owned by the requesting `user_id` before creating a link; share creation for a page the caller does not own SHALL be rejected. Duplicate active links for one `(user_id, page_id)` pair SHALL be impossible even under concurrent creation.

#### Scenario: Create token
- **WHEN** `CreateShareLink` is called with `user_id`, `page_id`, `is_public`, `expires_at` (0 = never)
- **THEN** the service MUST generate a 32-byte random token, encode it URL-safe base64 (43 chars), store only its hash (e.g. SHA-256, as the row's lookup key) in `share_db.share_links`, and return the plaintext token exactly once
- **AND** return `ShareLinkResponse { token, short_url=<BASE_URL>/s/<token>, is_public, expires_at, view_count=0 }`

#### Scenario: Plaintext tokens absent from storage
- **WHEN** the `share_db.share_links` table is inspected after any number of creations
- **THEN** no row MUST contain a value from which the returned plaintext token can be derived directly (hash-only storage)

#### Scenario: Concurrent duplicate creation blocked
- **WHEN** two `CreateShareLink` calls for the same `(user_id, page_id)` race
- **THEN** at most one active link MUST result (enforced by a DB constraint or serialized create-and-check), and the loser MUST return the existing link rather than create a second active row

#### Scenario: Existing active link for same page
- **WHEN** `CreateShareLink` is called for a `(user_id, page_id)` pair that already has an active (non-revoked, non-expired) link
- **THEN** the service MAY return the existing `ShareLinkResponse` rather than create a duplicate (implementation decision), but MUST never create multiple active links for the same pair

#### Scenario: Foreign page cannot be shared
- **WHEN** `CreateShareLink` is called with a `page_id` that does not exist or belongs to another user
- **THEN** the service MUST return `NOT_FOUND` (never distinguishing the two) and create no row
- **AND** enumeration of other users' pages via share creation is impossible

### Requirement: Token Validation
The Share Service SHALL expose a `ValidateToken` RPC used by the API Gateway's public viewer route, resolving tokens against their stored hash, checking revocation/expiry with immediate effect, and recording view counts via Redis deduplication instead of a database UPDATE per hit. On success it SHALL return the page id AND the page owner's `user_id` (`owner_user_id`), so downstream file access can be performed with mandatory ownership checks instead of an identity bypass.

#### Scenario: Valid public token
- **WHEN** `ValidateToken` is called with a `token` whose row (found by token hash) has `revoked_at IS NULL`, `is_public=true`, and (`expires_at IS NULL` OR `expires_at > NOW()`)
- **THEN** the service MUST return `ValidateShareResponse { valid=true, page_id=<page_id>, owner_user_id=<pages.user_id> }`
- **AND** the view MUST be counted in Redis (deduplicated per viewer within a TTL window) and flushed to `view_count` on a cadence — not via a synchronous `UPDATE share_links` on every request

#### Scenario: Repeated asset hits do not inflate the count
- **WHEN** the same viewer's requests (token + fingerprint) hit validation/assets repeatedly within the dedupe window
- **THEN** only one view MUST be recorded, and no per-request database write may occur on cache-served hits

#### Scenario: Downstream access uses the resolved owner
- **WHEN** the gateway serves share content after a successful validation
- **THEN** it passes `owner_user_id` as the `user_id` for `GetPageContent`/`GetArchiveFile`
- **AND** no internal call uses an empty `user_id` to bypass ownership

#### Scenario: Revoked token
- **WHEN** `ValidateToken` is called with a token whose `revoked_at` is set
- **THEN** return `ValidateShareResponse { valid=false, page_id="", owner_user_id="" }`

#### Scenario: Revocation is immediately visible despite caching
- **WHEN** a validation for a token is in flight (read before revoke) while `RevokeShareLink` commits and invalidates caches, and the in-flight validation then attempts to cache its `valid=true` result
- **THEN** the stale result MUST NOT survive the revocation (guard such that after `RevokeShareLink` returns, no subsequent `ValidateToken` within the prior cache TTL returns `valid=true` — e.g. generation check or bounded valid-entry TTL ≪ the old 1800 s window)

#### Scenario: Expired token
- **WHEN** `ValidateToken` is called with a token whose `expires_at` is in the past
- **THEN** return `ValidateShareResponse { valid=false, page_id="", owner_user_id="" }`

#### Scenario: Private token
- **WHEN** `ValidateToken` is called with a token whose `is_public=false`
- **THEN** return `ValidateShareResponse { valid=false, page_id="", owner_user_id="" }` (private tokens are validated by a separate authenticated path not in scope for this spec)

#### Scenario: Unknown token
- **WHEN** `ValidateToken` is called with a `token` that does not exist
- **THEN** return `ValidateShareResponse { valid=false, page_id="", owner_user_id="" }` (do not distinguish from expired/revoked to prevent enumeration)

### Requirement: Share Link Revocation
The Share Service SHALL expose a `RevokeShareLink` RPC that sets `revoked_at` on a user-owned share row, commits, and invalidates any cached validation entry for that token in the same critical path so revocation takes effect immediately.

#### Scenario: Successful revoke
- **WHEN** `RevokeShareLink` is called with `token` and `user_id` where the row's `user_id` matches
- **THEN** the service MUST set `revoked_at = NOW()`, invalidate the token's cached validation entry after commit, and return `StatusResponse { success=true }`
- **AND** subsequent `ValidateToken` calls MUST return `valid=false` immediately (no ≤30-minute stale window)

#### Scenario: Cross-user revoke blocked
- **WHEN** `RevokeShareLink` is called with a `user_id` that does not own the row
- **THEN** the service MUST return `StatusResponse { success=false, message="not found" }` and NOT modify the row

### Requirement: Token Metadata Retrieval
The Share Service SHALL expose a `GetShareLink` RPC used by the owner's management UI.

#### Scenario: Owner retrieves link
- **WHEN** `GetShareLink` is called with a `token`
- **THEN** return `ShareLinkResponse` with current `is_public`, `expires_at`, and `view_count`
- **AND** the caller (API Gateway) MUST ensure `authenticated user_id == row.user_id` before forwarding; the service itself does not enforce ownership on this RPC

### Requirement: Expiry Reporting on Metadata Retrieval
`GetShareLink` SHALL evaluate the link's `expires_at` and report an expired link as expired (never present it as active) so the owner's management UI shows the true state.

#### Scenario: Expired link flagged to the owner
- **WHEN** `GetShareLink` is called for a token whose `expires_at` is in the past
- **THEN** the response MUST identify the link as expired (expired state reflected in the returned metadata) and the gateway/UI MUST NOT present it as an active share

#### Scenario: Active link unaffected
- **WHEN** `GetShareLink` is called for a non-revoked, non-expired token
- **THEN** the response reports current `is_public`, `expires_at`, and `view_count` as before

### Requirement: Dangling-Link Cleanup
The Share Service SHALL expose a `RevokeLinksForPage(page_id)` RPC that revokes every share link referencing `page_id`, invoked (best-effort, logged) by the archive-service when a page is deleted, so no public link outlives its page.

#### Scenario: Page deletion revokes all links
- **WHEN** a page with two share links is deleted and archive calls `RevokeLinksForPage`
- **THEN** both links' `revoked_at` MUST be set and subsequent `ValidateToken` calls return `valid=false`

#### Scenario: No dangling public viewer
- **WHEN** a visitor opens `/s/<token>` for a link whose page was deleted
- **THEN** the visitor MUST see the invalid/revoked share state (never a broken or half-served page)

### Requirement: Production Link URL Correctness
The Share Service SHALL fail fast at startup when `ENVIRONMENT=production` is set without a usable `BASE_URL`, and the production compose overlay SHALL set `ENVIRONMENT=production` and the public `BASE_URL` so generated `short_url` values use the public hostname — never `localhost` or an internal address.

#### Scenario: Prod overlay arms the fail-fast
- **WHEN** the share-service starts from the production overlay
- **THEN** `ENVIRONMENT=production` and `BASE_URL=https://<public-host>` MUST be set and startup MUST succeed only with a valid `BASE_URL`

#### Scenario: Missing BASE_URL in production aborts startup
- **WHEN** the share-service runs with `ENVIRONMENT=production` and no `BASE_URL`
- **THEN** startup MUST fail (the fail-fast is live code, not dead)

#### Scenario: Short links use the public host
- **WHEN** a share link is created in production
- **THEN** `short_url` MUST begin with the configured public `BASE_URL` (not `http://localhost:8090` or the code-default)
