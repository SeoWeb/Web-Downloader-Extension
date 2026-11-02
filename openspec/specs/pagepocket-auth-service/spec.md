# PagePocket Auth Service Specification

## Purpose

Identity for the PagePocket platform: user registration, login, short-lived JWT issuance and verification, refresh-token rotation, logout, and password/secret storage hygiene.

## Requirements

### Requirement: User Registration

The Auth Service SHALL expose an `AuthService.Register` RPC that creates a new user with a unique email, a bcrypt-hashed password, and the default `free` plan.

#### Scenario: Successful registration

- **WHEN** `Register` is called with a unique email, a password ≥ 8 characters, and a non-empty name
- **THEN** the service MUST create a row in `auth_db.users` with the bcrypt hash of the password, `plan='free'`, `is_verified=false`
- **AND** return an `AuthResponse` containing `access_token`, `refresh_token`, `expires_at`, and the created `User`

#### Scenario: Email already in use

- **WHEN** `Register` is called with an email that already exists in `auth_db.users`
- **THEN** the service MUST return a gRPC status `ALREADY_EXISTS` and MUST NOT create a duplicate row

#### Scenario: Invalid input

- **WHEN** `Register` is called with a malformed email or password shorter than 8 characters
- **THEN** the service MUST return `INVALID_ARGUMENT`

### Requirement: Login

The Auth Service SHALL expose an `AuthService.Login` RPC that authenticates a user by email + password and issues tokens.

#### Scenario: Successful login

- **WHEN** `Login` is called with credentials matching a stored user
- **THEN** the service MUST verify the password against the bcrypt hash in constant time
- **AND** return an `AuthResponse` with fresh `access_token` (JWT, 1-hour expiry) and a newly minted `refresh_token` persisted to `refresh_tokens` with a 30-day expiry

#### Scenario: Wrong credentials

- **WHEN** `Login` is called with a non-existent email or incorrect password
- **THEN** the service MUST return `UNAUTHENTICATED` with message `"invalid credentials"` (identical for both cases to avoid user enumeration)

### Requirement: JWT Issuance

Access tokens SHALL be signed HS256 JWTs whose payload includes `user_id`, `email`, `plan`, `iat`, and `exp`, with a short lifetime of one hour. Multi-day access-token lifetimes (e.g., the previous 7-day default) SHALL NOT be used; clients obtain new tokens via the existing refresh flow.

#### Scenario: Token contents

- **WHEN** an access token is issued
- **THEN** the JWT payload MUST contain `sub=<user_id>`, `email=<email>`, `plan=<plan>`, `iat=<now>`, `exp=<now + 3600>`
- **AND** the token MUST be signed with the shared `JWT_SECRET` using HS256

#### Scenario: Access tokens are short-lived

- **WHEN** the access-token TTL is configured
- **THEN** it MUST NOT exceed one hour
- **AND** an expired access token is replaced via `/api/v1/auth/refresh`, not by a longer-lived token

#### Scenario: Plan claim is authoritative

- **WHEN** a user's plan changes and a new access token is issued
- **THEN** the `plan` claim reflects the current plan
- **AND** downstream quota enforcement uses this claim over any client-supplied value

### Requirement: Token Verification

The Auth Service SHALL expose an `AuthService.Verify` RPC used by internal callers that need to validate a raw JWT.

#### Scenario: Valid token

- **WHEN** `Verify` is called with a well-formed, unexpired JWT signed with `JWT_SECRET`
- **THEN** the response MUST have `valid=true`, `user_id=<sub>`, `email=<email>`

#### Scenario: Invalid or expired token

- **WHEN** `Verify` is called with a malformed, tampered, or expired JWT
- **THEN** the response MUST have `valid=false` and empty `user_id`/`email`

### Requirement: Refresh Token Rotation

The Auth Service SHALL expose an `AuthService.Refresh` RPC that exchanges a valid refresh token for a new access+refresh token pair, revoking the old refresh token.

#### Scenario: Successful refresh

- **WHEN** `Refresh` is called with a refresh token whose SHA-256 hash exists in `refresh_tokens`, is unexpired, and not revoked
- **THEN** the service MUST delete that row, create a new refresh-token row, and return a new `AuthResponse`

#### Scenario: Reused or revoked refresh token

- **WHEN** `Refresh` is called with a refresh token that was already consumed or revoked
- **THEN** the service MUST return `UNAUTHENTICATED` and SHOULD revoke all remaining refresh tokens for that user (token-reuse defence)

### Requirement: Logout

The Auth Service SHALL expose an `AuthService.Logout` RPC that revokes all refresh tokens for a given user.

#### Scenario: Logout all sessions

- **WHEN** `Logout` is called with a `user_id`
- **THEN** the service MUST delete every row in `refresh_tokens` for that user
- **AND** return `StatusResponse{success=true}`
- **AND** previously issued access tokens remain valid until their `exp` (accepted trade-off for stateless JWTs)

### Requirement: Password Storage

Passwords SHALL be stored only as bcrypt hashes with cost factor ≥ 12.

#### Scenario: Hash on write

- **WHEN** a password is persisted during registration or password change
- **THEN** the stored value MUST be a bcrypt hash with cost ≥ 12 (via `passlib[bcrypt]`)
- **AND** the plain-text password MUST NOT be logged or persisted anywhere

### Requirement: Signing secret hygiene

The service SHALL fail fast at startup when `JWT_SECRET` is unset or matches a known development default while running a production configuration. The secret SHALL NOT fall back silently to a development value.

#### Scenario: Prod refuses the dev default

- **WHEN** the service starts in a production configuration with the development `JWT_SECRET`
- **THEN** startup fails with an explicit configuration error
- **AND** no tokens are issued until a real secret is configured

### Requirement: Google sign-in

The Auth Service SHALL expose an `AuthService.GoogleAuth` RPC that authenticates a user via Google using an authorization code exchanged server-side, and issues the same token pair as password login. The gateway SHALL expose it at `POST /api/v1/auth/google` accepting `{code, code_verifier, redirect_uri}`. The service SHALL exchange the code at Google's token endpoint using server-side `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (the secret SHALL NOT be distributed to clients), and SHALL verify the returned ID token: Google JWKS signature, `aud` equals `GOOGLE_CLIENT_ID`, unexpired `exp`, and `email_verified=true`. Accounts SHALL be resolved as: match on `google_sub`; else match `email` on an existing account and link it by storing `google_sub` (auto-link, Google emails are verified); else create a new user with `plan='free'`, `is_verified=true`, and the Google profile name. The users table SHALL gain a nullable, unique `google_sub` column, and `password_hash` SHALL become nullable so Google-created accounts can exist without a password.

#### Scenario: Successful Google sign-in for a new user

- **WHEN** `GoogleAuth` is called with a valid code whose ID token verifies and whose email has no existing account
- **THEN** the service MUST create a user with the Google email, profile name, `plan='free'`, `is_verified=true`, `google_sub` set, and a NULL `password_hash`
- **AND** return an `AuthResponse` with a fresh access token (JWT, 1-hour expiry) and a refresh token persisted to `refresh_tokens` with a 30-day expiry

#### Scenario: Google sign-in links an existing password account

- **WHEN** the ID token's verified email matches an existing password account with no `google_sub`
- **THEN** the service MUST store the `google_sub` on that existing user
- **AND** MUST NOT create a duplicate account
- **AND** return an `AuthResponse` for the existing user

#### Scenario: Returning Google user

- **WHEN** the ID token's `sub` matches a stored `google_sub`
- **THEN** the service MUST authenticate that user and return an `AuthResponse` without re-examining email matching

#### Scenario: Invalid or unverifiable token material

- **WHEN** the code exchange fails, or the ID token fails signature, audience, expiry, or `email_verified` verification
- **THEN** the service MUST return `UNAUTHENTICATED` and MUST NOT create or modify any user

#### Scenario: Google-only account cannot password-login

- **GIVEN** a user whose `password_hash` is NULL
- **WHEN** `Login` is called with that email and any password
- **THEN** the service MUST return `UNAUTHENTICATED` with the same generic message used for wrong credentials

#### Scenario: Google dependency failure

- **WHEN** Google's token endpoint is unreachable or returns a server error
- **THEN** the service MUST return `UNAUTHENTICATED` with a safe, non-enumerating message and MUST NOT create or modify any user
