## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Signing secret hygiene
The service SHALL fail fast at startup when `JWT_SECRET` is unset or matches a known development default while running a production configuration. The secret SHALL NOT fall back silently to a development value.

#### Scenario: Prod refuses the dev default
- **WHEN** the service starts in a production configuration with the development `JWT_SECRET`
- **THEN** startup fails with an explicit configuration error
- **AND** no tokens are issued until a real secret is configured
