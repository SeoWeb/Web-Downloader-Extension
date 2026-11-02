## ADDED Requirements

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
