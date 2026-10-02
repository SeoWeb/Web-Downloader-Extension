## ADDED Requirements

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
Access tokens SHALL be signed HS256 JWTs whose payload includes `user_id`, `email`, `plan`, `iat`, and `exp`.

#### Scenario: Token contents
- **WHEN** an access token is issued
- **THEN** the JWT payload MUST contain `sub=<user_id>`, `email=<email>`, `plan=<plan>`, `iat=<now>`, `exp=<now + 3600>`
- **AND** the token MUST be signed with the shared `JWT_SECRET` using HS256

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
