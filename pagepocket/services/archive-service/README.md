# Archive Service

Handles page ingestion, HTML processing, Cloudflare R2 storage, quota enforcement, and page lifecycle management. Runs as a gRPC server on **port 50052**.

## gRPC Methods

### IngestPage

Processes and stores an archived web page. Performs HTML sanitization, asset rewriting, quota checking, R2 upload, and search indexing.

| Field              | Type           | Description                                                                   |
| ------------------ | -------------- | ----------------------------------------------------------------------------- |
| `user_id`          | string         | Owner of the page                                                             |
| `url`              | string         | Original page URL                                                             |
| `html_content`     | bytes          | Raw HTML content                                                              |
| `title`            | string         | Page title (auto-extracted from `<title>` if empty)                           |
| `assets`           | repeated Asset | Binary assets (images, scripts, etc.) with `filename`, `data`, `content_type` |
| `extension_job_id` | string         | Idempotency key from the browser extension                                    |
| `plan`             | string         | User's plan tier for quota enforcement                                        |

Returns `IngestPageResponse` with `success` and `page_id`.

Errors: `RESOURCE_EXHAUSTED` (quota exceeded).

### GetPage

Retrieves metadata for a single archived page.

| Field     | Type   | Description               |
| --------- | ------ | ------------------------- |
| `page_id` | string | Page identifier           |
| `user_id` | string | Must match the page owner |

Returns `PageResponse`. Errors: `NOT_FOUND`.

### ListPages

Lists a user's archived pages with pagination.

| Field       | Type   | Description                                                    |
| ----------- | ------ | -------------------------------------------------------------- |
| `user_id`   | string | Owner                                                          |
| `page`      | int32  | Page number (1-based)                                          |
| `page_size` | int32  | Items per page (max 100, default 20)                           |
| `sort_by`   | string | `"archived_at"` (default, descending) or `"title"` (ascending) |

Returns `ListPagesResponse` with `pages` list and `total` count.

### GetPageContent

Generates a presigned URL for viewing an archived page's HTML.

| Field     | Type   | Description               |
| --------- | ------ | ------------------------- |
| `page_id` | string | Page identifier           |
| `user_id` | string | Must match the page owner |

Returns `PageContentResponse` with `signed_url` (valid 1 hour) and `expires_at`.

### DeletePage

Deletes a page, its assets from R2, and removes it from the search index. Adjusts quota usage.

| Field     | Type   | Description               |
| --------- | ------ | ------------------------- |
| `page_id` | string | Page identifier           |
| `user_id` | string | Must match the page owner |

Returns `StatusResponse`.

## Storage Layout

Pages are stored in Cloudflare R2 under the prefix `{user_id}/{page_id}/`:

``` plaintext
{user_id}/{page_id}/
  index.html      — Sanitized and rewritten HTML
  meta.json        — Title, URL, archived_at, size_bytes
  assets/          — Binary assets (images, scripts, stylesheets)
```

## Quota Tiers

Quota is enforced on every `IngestPage` call using `SELECT ... FOR UPDATE` to prevent concurrent races.

| Plan | Pages/Month | Max Storage |
| ---- | ----------- | ----------- |
| free | 50          | 500 MB      |
| pro  | Unlimited   | 10 GB       |
| team | Unlimited   | 50 GB       |

Monthly page counters reset automatically after 30 days.

## HTML Processing

The `page_processor` module:

1. Rewrites `src`, `href`, and `data-src` attributes in `<img>`, `<script>`, `<link>`, `<source>`, `<video>`, `<audio>` tags to point to R2 paths
2. Strips `<script>`, `<style>`, `<noscript>` tags to extract plain text
3. Generates a 500-character `preview_text` and full `body_text` for search indexing

## Configuration

| Variable               | Required | Default | Description                                 |
| ---------------------- | -------- | ------- | ------------------------------------------- |
| `DB_URL`               | Yes      | —       | SQLAlchemy MySQL connection string          |
| `R2_ENDPOINT_URL`      | Yes      | —       | Cloudflare R2 endpoint                      |
| `R2_ACCESS_KEY_ID`     | Yes      | —       | R2 access key                               |
| `R2_SECRET_ACCESS_KEY` | Yes      | —       | R2 secret key                               |
| `R2_BUCKET_NAME`       | Yes      | —       | R2 bucket name                              |
| `SEARCH_SERVICE_ADDR`  | No       | —       | gRPC address of search service for indexing |
| `MTLS_ENABLED`         | No       | `false` | Enable mutual TLS                           |

## Dependencies

**Python packages:** `grpcio`, `grpcio-tools`, `protobuf`, `sqlalchemy`, `pymysql`, `boto3`, `beautifulsoup4`, `lxml`

**Internal services:** Calls search service (fire-and-forget) to index/remove pages after ingestion/deletion.

**Shared utilities:** `shared/db.py`, `shared/r2_utils.py` (R2 S3 client), `shared/grpc_mtls.py`, `shared/proto_generated/`.

## Local Development

```bash
cd pagepocket/services/archive-service
pip install -r requirements.txt

# Set required environment variables
export DB_URL=mysql+pymysql://user:pass@localhost:3306/pagepocket
export R2_ENDPOINT_URL=https://your-account.r2.cloudflarestorage.com
export R2_ACCESS_KEY_ID=your-key
export R2_SECRET_ACCESS_KEY=your-secret
export R2_BUCKET_NAME=pagepocket
export SEARCH_SERVICE_ADDR=localhost:50054  # optional

python main.py
# Server starts on port 50052
```

## Service Communication

- **Called by:** API gateway (all archive endpoints)
- **Calls:** Search service — fire-and-forget `IndexPage`/`RemovePage` after page changes. Failures are silently ignored to avoid blocking ingestion.

## Database Tables

- **`pages`** — `id`, `user_id`, `url`, `title`, `preview_text`, `r2_key`, `size_bytes`, `extension_job_id` (unique, for idempotency), `archived_at`
- **`user_quotas`** — `user_id` (PK), `pages_this_month`, `total_bytes`, `quota_reset_at`
