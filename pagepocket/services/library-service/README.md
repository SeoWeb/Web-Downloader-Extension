# Library Service

Manages user collections for organizing archived pages into a hierarchical folder structure. Runs as a gRPC server on **port 50053**.

## gRPC Methods

### CreateCollection

Creates a new collection, optionally nested under a parent.

| Field         | Type   | Description                            |
| ------------- | ------ | -------------------------------------- |
| `user_id`     | string | Owner                                  |
| `name`        | string | Collection name (required)             |
| `description` | string | Optional description                   |
| `parent_id`   | string | Optional parent collection for nesting |
| `color`       | string | Hex color code (default `#6B7280`)     |

Returns `CollectionResponse`. Errors: `INVALID_ARGUMENT` (empty name or invalid parent).

### GetCollection

Retrieves collection details including page count.

| Field           | Type   | Description           |
| --------------- | ------ | --------------------- |
| `collection_id` | string | Collection identifier |
| `user_id`       | string | Must match the owner  |

Returns `CollectionResponse`. Errors: `NOT_FOUND`.

### ListCollections

Lists a user's collections. When `parent_id` is provided, returns children of that collection. Otherwise returns root-level collections.

| Field       | Type   | Description                  |
| ----------- | ------ | ---------------------------- |
| `user_id`   | string | Owner                        |
| `parent_id` | string | Optional parent to filter by |

Returns `ListCollectionsResponse` with collections list (each includes `page_count`).

### UpdateCollection

Updates collection properties. Only provided fields are changed.

| Field           | Type   | Description                |
| --------------- | ------ | -------------------------- |
| `collection_id` | string | Collection identifier      |
| `user_id`       | string | Must match the owner       |
| `name`          | string | New name (optional)        |
| `description`   | string | New description (optional) |
| `color`         | string | New hex color (optional)   |

Returns `CollectionResponse`. Errors: `NOT_FOUND`.

### DeleteCollection

Deletes a collection. Cascades to remove all `page_collections` associations.

| Field           | Type   | Description           |
| --------------- | ------ | --------------------- |
| `collection_id` | string | Collection identifier |
| `user_id`       | string | Must match the owner  |

Returns `StatusResponse`. Errors: `NOT_FOUND`.

### AddPageToCollection

Links a page to a collection. Silently succeeds if the link already exists.

| Field           | Type   | Description                 |
| --------------- | ------ | --------------------------- |
| `user_id`       | string | Must match collection owner |
| `page_id`       | string | Page to add                 |
| `collection_id` | string | Target collection           |

Returns `StatusResponse`. Errors: `PERMISSION_DENIED` (not owner).

### RemovePageFromCollection

Removes a page from a collection.

| Field           | Type   | Description                 |
| --------------- | ------ | --------------------------- |
| `user_id`       | string | Must match collection owner |
| `page_id`       | string | Page to remove              |
| `collection_id` | string | Target collection           |

Returns `StatusResponse`. Errors: `PERMISSION_DENIED` (not owner).

## Configuration

| Variable       | Required | Default | Description                        |
| -------------- | -------- | ------- | ---------------------------------- |
| `DB_URL`       | Yes      | —       | SQLAlchemy MySQL connection string |
| `MTLS_ENABLED` | No       | `false` | Enable mutual TLS                  |

## Dependencies

**Python packages:** `grpcio`, `grpcio-tools`, `protobuf`, `sqlalchemy`, `pymysql`

**Shared utilities:** `shared/db.py`, `shared/grpc_mtls.py`, `shared/proto_generated/`.

## Local Development

```bash
cd pagepocket/services/library-service
pip install -r requirements.txt

export DB_URL=mysql+pymysql://user:pass@localhost:3306/pagepocket

python main.py
# Server starts on port 50053
```

## Service Communication

- **Called by:** API gateway (all library/collection endpoints)
- **Calls:** None. The library service is self-contained and does not call other services.

## Database Tables

- **`collections`** — `id`, `user_id`, `name`, `description`, `parent_id` (FK → `collections.id`, SET NULL on delete), `color`, `created_at`, `updated_at`
- **`page_collections`** — Composite PK (`page_id`, `collection_id`), `added_at`. FK `collection_id` → `collections.id` with CASCADE delete.
- **`tags`** — `id`, `user_id`, `name`, `created_at` (defined in models, not yet exposed via gRPC)
- **`page_tags`** — `id`, `page_id`, `tag_id` (FK → `tags.id`, CASCADE) (defined in models, not yet exposed via gRPC)
