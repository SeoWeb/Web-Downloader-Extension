# Auth Service

Handles user registration, authentication, JWT token management, and token lifecycle. Runs as a gRPC server on **port 50051**.

## gRPC Methods

### Register

Creates a new user account.

| Field      | Type   | Description                                          |
| ---------- | ------ | ---------------------------------------------------- |
| `email`    | string | Must match standard email format, stored lowercase   |
| `password` | string | Minimum 8 characters, hashed with bcrypt (12 rounds) |
| `name`     | string | User display name                                    |

Returns `AuthResponse` with `access_token`, `refresh_token`, `expires_at`, and `User` object.

Errors: `INVALID_ARGUMENT` (bad email/password/name), `ALREADY_EXISTS` (email taken).

### Login

Authenticates an existing user.

| Field      | Type   | Description                                          |
| ---------- | ------ | ---------------------------------------------------- |
| `email`    | string | Case-insensitive match                               |
| `password` | string | Verified against bcrypt hash (truncated to 72 bytes) |

Returns `AuthResponse`. Errors: `UNAUTHENTICATED` on invalid credentials.

### Verify

Validates an access token without database lookup.

| Field   | Type   | Description      |
| ------- | ------ | ---------------- |
| `token` | string | JWT access token |

Returns `VerifyResponse` with `valid`, `user_id`, `email`, `plan`.

### Refresh

Rotates a refresh token, issuing new access and refresh tokens. Implements **reuse detection**: if a revoked refresh token is reused, all tokens for that user are revoked.

| Field           | Type   | Description                   |
| --------------- | ------ | ----------------------------- |
| `refresh_token` | string | The refresh token to exchange |

Returns `AuthResponse`. Errors: `UNAUTHENTICATED` (invalid/expired/reused token).

### Logout

Revokes all refresh tokens for a user.

| Field     | Type   | Description                 |
| --------- | ------ | --------------------------- |
| `user_id` | string | User whose tokens to revoke |

Returns `StatusResponse`.

## Configuration

| Variable       | Required | Default | Description                           |
| -------------- | -------- | ------- | ------------------------------------- |
| `DB_URL`       | Yes      | —       | SQLAlchemy MySQL connection string    |
| `JWT_SECRET`   | Yes      | —       | Secret for signing JWT tokens (HS256) |
| `MTLS_ENABLED` | No       | `false` | Enable mutual TLS                     |

## Dependencies

**Python packages:** `grpcio`, `grpcio-tools`, `protobuf`, `sqlalchemy`, `pymysql`, `cryptography`, `passlib[bcrypt]`, `bcrypt`, `PyJWT`

**Shared utilities:** `shared/db.py` (database session), `shared/jwt_utils.py` (token issue/verify), `shared/grpc_mtls.py` (mTLS credentials), `shared/proto_generated/` (protobuf stubs).

## Local Development

```bash
cd pagepocket/services/auth-service
pip install -r requirements.txt

# Set required environment variables
export DB_URL=mysql+pymysql://user:pass@localhost:3306/pagepocket
export JWT_SECRET=your-secret

python main.py
# Server starts on port 50051
```

## Service Communication

The auth service is called by the API gateway for all authentication endpoints. It does not call other services. Token verification is stateless (JWT signature check), so the gateway can verify tokens independently using the same `JWT_SECRET`.

## Database Tables

- **`users`** — `id`, `email` (unique), `password_hash`, `name`, `plan` (free/pro/team), `is_verified`, `created_at`
- **`refresh_tokens`** — `id`, `user_id`, `token_hash` (SHA-256 of raw token), `expires_at`, `created_at`, `revoked_at`
