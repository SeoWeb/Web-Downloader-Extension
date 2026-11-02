## MODIFIED Requirements

### Requirement: JWT Authentication Middleware

The API Gateway SHALL require a valid bearer JWT on every route except `/api/v1/auth/register`, `/api/v1/auth/login`, `/api/v1/auth/refresh`, `/api/v1/auth/google`, `/api/v1/share/public/{token}`, and `/api/v1/health`.

#### Scenario: Valid token

- **WHEN** a request includes `Authorization: Bearer <jwt>` and the JWT is valid and unexpired
- **THEN** the gateway MUST decode the payload, attach `user_id` to the request context, and forward the request
- **AND** the `user_id` MUST be propagated as a field in the downstream protobuf message

#### Scenario: Missing or malformed token

- **WHEN** a protected route is requested without an `Authorization` header, with a non-`Bearer` scheme, or with a malformed token
- **THEN** the gateway MUST return HTTP 401 with `{"detail": "Invalid token"}`

#### Scenario: Expired token

- **WHEN** the JWT signature is valid but `exp` is in the past
- **THEN** the gateway MUST return HTTP 401 and the client MUST refresh using `/api/v1/auth/refresh`

#### Scenario: Public share route bypasses auth

- **WHEN** a request to `/api/v1/share/public/{token}` arrives without `Authorization`
- **THEN** the gateway MUST forward to `ShareService.ValidateToken` without requiring a JWT

#### Scenario: Public Google auth route bypasses auth

- **WHEN** a `POST /api/v1/auth/google` request arrives without `Authorization`
- **THEN** the gateway MUST forward it to `AuthService.GoogleAuth` without requiring a JWT
- **AND** the request remains subject to the unauthenticated 20-per-minute per-IP rate-limit class on `/api/v1/auth/*`
