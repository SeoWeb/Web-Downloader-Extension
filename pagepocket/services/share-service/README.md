# Share Service

Manages share links for publicly sharing archived pages. Generates tokens, tracks views, and validates access. Runs as a gRPC server on **port 50055**.

## gRPC Methods

### CreateShareLink

Generates a share link for a page. If an active (non-expired, non-revoked) link already exists for the same user+page, returns the existing link.

| Field        | Type   | Description                                            |
| ------------ | ------ | ------------------------------------------------------ |
| `user_id`    | string | Link owner                                             |
| `page_id`    | string | Page to share                                          |
| `is_public`  | bool   | Whether the link is publicly accessible (default true) |
| `expires_at` | int64  | Unix timestamp for link expiration (0 = never)         |

Returns `ShareLinkResponse` with `token`, `short_url`, `is_public`, `expires_at`, `view_count`, `page_id`, `user_id`, `created_at`.

### GetShareLink

Retrieves details for an existing share link by token.

| Field   | Type   | Description      |
| ------- | ------ | ---------------- |
| `token` | string | Share link token |

Returns `ShareLinkResponse`. Errors: `NOT_FOUND`.

### RevokeShareLink

Revokes a share link by setting `revoked_at`. Only the link owner can revoke.

| Field     | Type   | Description               |
| --------- | ------ | ------------------------- |
| `token`   | string | Share link token          |
| `user_id` | string | Must match the link owner |

Returns `StatusResponse`.

### ValidateToken

Validates a public share token. Checks that the link exists, is not revoked, is public, and has not expired. Atomically increments the view count on success.

| Field   | Type   | Description                  |
| ------- | ------ | ---------------------------- |
| `token` | string | Share link token to validate |

Returns `ValidateShareResponse` with `valid` and `page_id` (empty if invalid).

## Configuration

| Variable       | Required | Default                 | Description                              |
| -------------- | -------- | ----------------------- | ---------------------------------------- |
| `DB_URL`       | Yes      | —                       | SQLAlchemy MySQL connection string       |
| `BASE_URL`     | No       | `http://localhost:8000` | Base URL for generating short share URLs |
| `MTLS_ENABLED` | No       | `false`                 | Enable mutual TLS                        |

## Dependencies

**Python packages:** `grpcio`, `grpcio-tools`, `protobuf`, `sqlalchemy`, `pymysql`

**Shared utilities:** `shared/db.py`, `shared/grpc_mtls.py`, `shared/proto_generated/`.

## Local Development

```bash
cd pagepocket/services/share-service
pip install -r requirements.txt

export DB_URL=mysql+pymysql://user:pass@localhost:3306/pagepocket
export BASE_URL=https://your-domain.com  # optional

python main.py
# Server starts on port 50055
```

## Service Communication

- **Called by:** API gateway (share endpoints: create, revoke, public validate)
- **Calls:** None. The share service is self-contained. The API gateway handles the presigned URL generation by calling the archive service separately after token validation.

## Database Table

- **`share_links`** — `token` (PK, 64-char URL-safe string), `user_id`, `page_id`, `is_public`, `expires_at`, `view_count`, `created_at`, `revoked_at`
