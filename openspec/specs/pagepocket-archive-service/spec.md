## ADDED Requirements

### Requirement: Page Ingestion from Extension Server
The Archive Service SHALL expose an `ArchiveService.IngestPage` RPC that receives a captured page (HTML + assets) from the extension server and persists it.

#### Scenario: Successful ingest
- **WHEN** `IngestPage` is called with `user_id`, `url`, `title`, `html_content`, a list of `Asset { filename, content_type, data }`, and a unique `extension_job_id`
- **THEN** the service MUST generate a UUIDv4 `page_id`
- **AND** upload every asset to R2 under `{user_id}/{page_id}/assets/{filename}`
- **AND** rewrite every `src`/`href` in the HTML whose basename matches an asset filename to `/r2/{user_id}/{page_id}/assets/{filename}`
- **AND** upload the rewritten HTML to R2 under `{user_id}/{page_id}/index.html` with `content-type: text/html; charset=utf-8`
- **AND** insert a row into `archive_db.pages` with `id`, `user_id`, `url`, `title`, first 500 chars of body text as `preview_text`, the `index.html` R2 key, total byte size, and the `extension_job_id`
- **AND** call `SearchService.IndexPage` asynchronously with the extracted plain-text body
- **AND** return `IngestPageResponse { success=true, page_id=<uuid>, message="" }`

#### Scenario: Idempotent replay
- **WHEN** `IngestPage` is called with an `extension_job_id` that already exists in `archive_db.pages`
- **THEN** the service MUST NOT upload to R2 again and MUST NOT create a new row
- **AND** return `IngestPageResponse { success=true, page_id=<existing uuid> }`

#### Scenario: Empty title fallback
- **WHEN** the `title` field is empty
- **THEN** the service MUST use the `<title>` element from the HTML if present, else the `url`, as the stored title

### Requirement: Quota Enforcement
The Archive Service SHALL enforce per-plan quotas (pages per month, total bytes) before writing to R2.

#### Scenario: Under quota
- **WHEN** `IngestPage` is called and the user's `user_quotas.pages_this_month` is below the plan limit AND `total_bytes + request_size` is below the plan byte limit
- **THEN** the ingest proceeds and both counters are incremented atomically after successful R2 upload and DB insert

#### Scenario: Monthly page limit exceeded
- **WHEN** `user_quotas.pages_this_month` ≥ `PLAN_LIMITS[plan].pages_per_month`
- **THEN** the service MUST return gRPC `RESOURCE_EXHAUSTED` with message `"Monthly page limit reached"`
- **AND** MUST NOT upload to R2 or create a `pages` row

#### Scenario: Storage byte limit exceeded
- **WHEN** `user_quotas.total_bytes + request_size` > `PLAN_LIMITS[plan].max_bytes`
- **THEN** the service MUST return gRPC `RESOURCE_EXHAUSTED` with message `"Storage limit reached"`

#### Scenario: Plan limits table
- **WHEN** the service evaluates quotas
- **THEN** it MUST use: `free` = 50 pages/month + 500 MB; `pro` = 99999 pages/month + 10 GB; `team` = 99999 pages/month + 50 GB
- **AND** `pages_this_month` MUST reset to 0 when `quota_reset_at` is in the past (rolled forward one month on next ingest)

### Requirement: Page Retrieval
The Archive Service SHALL expose `ArchiveService.GetPage`, `ArchiveService.GetPageContent`, and `ArchiveService.ListPages` RPCs that return pages owned by the requesting `user_id`.

#### Scenario: Get metadata
- **WHEN** `GetPage` is called with `page_id` and `user_id`
- **THEN** if the row exists and `pages.user_id` matches, return a `PageResponse` with all metadata fields
- **AND** if no match, return `NOT_FOUND`

#### Scenario: Get viewer URL
- **WHEN** `GetPageContent` is called with `page_id` and `user_id`
- **THEN** the service MUST generate an R2 presigned GET URL for `pages.r2_key` with an expiry of 3600 seconds
- **AND** return `PageContentResponse { signed_url, expires_at=<now+3600> }`

#### Scenario: List pagination and sort
- **WHEN** `ListPages` is called with `user_id`, `page`, `page_size`, `sort_by ∈ {archived_at, title}`
- **THEN** the service MUST return a page-sized slice ordered by the requested column (descending for `archived_at`, ascending for `title`) along with the total row count for that user

#### Scenario: Cross-user isolation
- **WHEN** any Get/List RPC is called with a `user_id` that does not own the target `page_id`
- **THEN** the service MUST return `NOT_FOUND` (never leak existence across users)

### Requirement: Page Deletion
The Archive Service SHALL expose an `ArchiveService.DeletePage` RPC that removes the page row, its R2 prefix, its thumbnail, and its search index entry.

#### Scenario: Successful delete
- **WHEN** `DeletePage` is called with `page_id` and `user_id` matching the row
- **THEN** the service MUST delete every object under R2 prefix `{user_id}/{page_id}/` and the thumbnail object `{user_id}/{page_id}.webp`
- **AND** delete the row from `archive_db.pages`
- **AND** decrement `user_quotas.total_bytes` by the row's `size_bytes`
- **AND** call `SearchService.RemovePage`
- **AND** return `StatusResponse { success=true }`

#### Scenario: Not found or cross-user
- **WHEN** the row does not exist or belongs to another user
- **THEN** the service MUST return `StatusResponse { success=false, message="not found" }` and perform no side effects
